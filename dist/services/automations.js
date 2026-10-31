import { Company, Item, Party, Transaction } from '../models/index.js';
import { resolveSettings } from '../core/settings.js';
import { zonedNow } from '../core/time.js';
import { TXN_CONFIG } from '../core/txn.js';
import { logger } from '../config/logger.js';
import { sendCompanyMail, smtpConfigured } from './mailer.js';
import { notifyPermission } from './notify.js';
import { syncInbox } from './imap.js';
/** Jobs run every hour; each company acts at a fixed hour of its own time zone (Settings ▸ General). */
const atLocalHour = (s, hour) => Number(zonedNow(s.general.timezone).time.slice(0, 2)) === hour;
const money = (n, sym) => `${sym}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function documentHtml(company, doc, sym) {
    const items = doc.items ?? [];
    const rows = items
        .map((l) => `<tr><td style="padding:6px;border-bottom:1px solid #eee">${esc(l.name)}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${l.qty} ${esc(l.unitName ?? '')}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${money(l.price, sym)}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${money(l.amount, sym)}</td></tr>`)
        .join('');
    const label = TXN_CONFIG[doc.type]?.label ?? 'Document';
    return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#222">
  <h2 style="color:#1e40af;margin-bottom:4px">${esc(company.name)}</h2>
  <p style="margin-top:0;color:#666">${esc(label)} <b>${esc(doc.number)}</b> dated ${new Date(doc.date).toLocaleDateString('en-IN')}</p>
  <p>Dear ${esc(doc.partyName)},</p>
  <p>Please find the details of your ${esc(label.toLowerCase())} below.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#eff6ff"><th style="padding:6px;text-align:left">Item</th><th style="padding:6px;text-align:right">Qty</th><th style="padding:6px;text-align:right">Price</th><th style="padding:6px;text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <p style="text-align:right;font-size:16px"><b>Total: ${money(Number(doc.total), sym)}</b>${Number(doc.balance) > 0 ? `<br><span style="color:#b91c1c">Balance due: ${money(Number(doc.balance), sym)}</span>` : ''}</p>
  <p>Thank you for your business.<br>${esc(company.name)}${company.phone ? ` · ${esc(company.phone)}` : ''}</p></div>`;
}
/** Called after a sale invoice is created: emails the party when the automation is on. */
export async function onSaleCreated(companyId, txnId) {
    try {
        const company = await Company.findById(companyId).lean();
        if (!company)
            return;
        const s = resolveSettings(company.settings);
        if (!s.email.autoSendInvoice || !smtpConfigured(s))
            return;
        const doc = await Transaction.findById(txnId).lean();
        if (!doc?.party)
            return;
        const party = await Party.findById(doc.party).select('email').lean();
        if (!party?.email)
            return;
        await sendCompanyMail(companyId, {
            to: [party.email],
            subject: `${TXN_CONFIG[doc.type].label} ${doc.number} from ${company.name}`,
            html: documentHtml(company, doc, s.general.currencySymbol),
            related: doc._id,
            automation: 'auto_send_invoice',
        });
    }
    catch (err) {
        logger.warn({ err }, 'auto send invoice failed');
    }
}
export async function runPaymentReminders() {
    const companies = await Company.find({ isActive: true }).lean();
    for (const company of companies) {
        const s = resolveSettings(company.settings);
        if (!s.email.paymentReminders || !smtpConfigured(s) || !atLocalHour(s, 9))
            continue;
        const cutoff = new Date(Date.now() - (Number(s.email.reminderDaysAfterDue) || 0) * 86400000);
        const weekAgo = new Date(Date.now() - 7 * 86400000);
        const due = await Transaction.find({
            company: company._id, type: 'SALE', status: { $in: ['UNPAID', 'PARTIAL'] }, dueDate: { $lte: cutoff }, party: { $ne: null },
            $or: [{ remindedAt: null }, { remindedAt: { $lt: weekAgo } }],
        }).limit(200).lean();
        for (const doc of due) {
            const party = await Party.findById(doc.party).select('email name').lean();
            if (!party?.email)
                continue;
            try {
                await sendCompanyMail(company._id, {
                    to: [party.email],
                    subject: `Payment reminder: ${doc.number} — ${money(doc.balance, s.general.currencySymbol)} due`,
                    html: `<div style="font-family:Arial,sans-serif"><p>Dear ${esc(party.name)},</p><p>This is a friendly reminder that invoice <b>${esc(doc.number)}</b> dated ${new Date(doc.date).toLocaleDateString('en-IN')} has an outstanding balance of <b>${money(doc.balance, s.general.currencySymbol)}</b>${doc.dueDate ? `, which was due on ${new Date(doc.dueDate).toLocaleDateString('en-IN')}` : ''}.</p><p>Please arrange the payment at the earliest. Ignore this message if already paid.</p><p>Regards,<br>${esc(company.name)}</p></div>`,
                    related: doc._id,
                    automation: 'payment_reminder',
                });
                await Transaction.updateOne({ _id: doc._id }, { $set: { remindedAt: new Date() } });
            }
            catch (err) {
                logger.warn({ err }, 'reminder failed');
            }
        }
    }
}
export async function runDailySummary() {
    const companies = await Company.find({ isActive: true }).lean();
    for (const company of companies) {
        const s = resolveSettings(company.settings);
        if (!s.email.dailySummary || !s.email.dailySummaryTo || !smtpConfigured(s) || !atLocalHour(s, 21))
            continue;
        // Business dates are stored as UTC midnight of the day.
        const start = new Date(`${zonedNow(s.general.timezone).day}T00:00:00.000Z`);
        const agg = await Transaction.aggregate([
            { $match: { company: company._id, status: { $ne: 'CANCELLED' }, date: { $gte: start, $lt: new Date(start.getTime() + 86400000) } } },
            { $group: { _id: '$type', total: { $sum: '$total' }, count: { $sum: 1 } } },
        ]);
        const rows = agg.map((a) => `<tr><td style="padding:6px">${esc(TXN_CONFIG[a._id]?.label ?? a._id)}</td><td style="padding:6px;text-align:right">${a.count}</td><td style="padding:6px;text-align:right">${money(a.total, s.general.currencySymbol)}</td></tr>`).join('');
        try {
            await sendCompanyMail(company._id, {
                to: s.email.dailySummaryTo.split(',').map((x) => x.trim()).filter(Boolean),
                subject: `Daily summary — ${company.name} — ${start.toLocaleDateString('en-IN', { timeZone: 'UTC' })}`,
                html: `<div style="font-family:Arial,sans-serif"><h3>${esc(company.name)} — ${start.toLocaleDateString('en-IN', { timeZone: 'UTC' })}</h3>${rows ? `<table style="border-collapse:collapse">${rows}</table>` : '<p>No transactions today.</p>'}</div>`,
                automation: 'daily_summary',
            });
        }
        catch (err) {
            logger.warn({ err }, 'daily summary failed');
        }
    }
}
/** Tells the people who manage stock how many items are at or below their minimum. */
export async function lowStockAlert(companyId) {
    const low = await Item.countDocuments({ company: companyId, type: 'product', isActive: { $ne: false }, minStock: { $gt: 0 }, $expr: { $lte: ['$stock', '$minStock'] } });
    if (low > 0)
        await notifyPermission(companyId, ['items.edit', 'items.adjust_stock'], { type: 'warning', title: 'Low stock', message: `${low} item(s) are at or below minimum stock`, link: '/reports/low-stock' });
    return low;
}
export async function runLowStockAlerts() {
    const companies = await Company.find({ isActive: true }).lean();
    for (const company of companies) {
        const s = resolveSettings(company.settings);
        if (s.items.lowStockAlert && atLocalHour(s, 8))
            await lowStockAlert(company._id);
    }
}
export async function runInboxSync() {
    const companies = await Company.find({ isActive: true, 'settings.email.imapHost': { $nin: [null, ''] } }).select('_id').lean();
    for (const c of companies)
        await syncInbox(c._id).catch(() => undefined);
}
//# sourceMappingURL=automations.js.map