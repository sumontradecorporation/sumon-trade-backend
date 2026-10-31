import { Router } from 'express';
import { z } from 'zod';
import { BIN_RE, TIN_RE } from '../../core/bangladesh.js';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { ok } from '../../core/http.js';
import { openSecret, sealSecret } from '../../core/secrets.js';
import { DEFAULT_SETTINGS, SECRET_MASK, deepMerge, redactSettings, resolveSettings } from '../../core/settings.js';
import { isTimeZone } from '../../core/time.js';
import { email, optStr, optionalId } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { Attendance, BankAccount, BankEntry, Category, Company, Employee, ExpenseCategory, HrRequest, Item, LoanAccount, LoanEntry, Party, PartyGroup, Payroll, Role, StockAdjustment, Transaction, Unit, UnitConversion, User, } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { recalcDocuments, recalcItems, recalcParties } from '../../services/ledger.js';
import { sendCompanyMail } from '../../services/mailer.js';
import { removeInboxMail, testInbox } from '../../services/imap.js';
const router = Router();
/** Readable by every company user (forms need prefixes, tax rates, print settings). Secrets are redacted. */
router.get('/', async (req, res) => {
    const ctx = ctxOf(req);
    const company = await Company.findById(ctx.companyId).lean();
    if (!company)
        throw AppError.notFound('Company');
    const { settings, ...profile } = company;
    ok(res, { company: profile, settings: redactSettings(resolveSettings(settings)) });
});
const SECTIONS = Object.keys(DEFAULT_SETTINGS);
const SECTION_LABEL = {
    general: 'General', transaction: 'Transactions', print: 'Print', taxes: 'Taxes', items: 'Items', parties: 'Parties', email: 'Email & automations', hr: 'HR & payroll',
};
/** Allowed range of numeric settings; anything outside is clamped. */
const BOUNDS = {
    'general.decimalPlaces': [0, 4],
    'general.financialYearStartMonth': [1, 12],
    'transaction.defaultDueDays': [0, 365],
    'items.defaultTaxRate': [0, 100],
    'email.smtpPort': [1, 65535],
    'email.imapPort': [1, 65535],
    'email.reminderDaysAfterDue': [0, 365],
    'hr.workingDaysPerMonth': [1, 31],
    'hr.halfDayFactor': [0, 1],
    'hr.paidLeavePerMonth': [0, 31],
};
router.put('/section/:section', requirePermission('settings.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const section = req.params.section;
    if (!SECTIONS.includes(section))
        throw AppError.badRequest('Unknown settings section');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw AppError.badRequest('Invalid settings');
    const company = await Company.findById(ctx.companyId);
    if (!company)
        throw AppError.notFound('Company');
    const current = resolveSettings(company.settings);
    // Only keys known to the defaults are accepted; types must match the defaults.
    const defaults = DEFAULT_SETTINGS[section];
    const clean = {};
    for (const [k, v] of Object.entries(body)) {
        if (!(k in defaults))
            continue;
        const d = defaults[k];
        if (typeof d === 'number') {
            const [min, max] = BOUNDS[`${section}.${k}`] ?? [-1e9, 1e9];
            clean[k] = Math.min(max, Math.max(min, Number(v) || 0));
        }
        else if (typeof d === 'boolean')
            clean[k] = !!v;
        else if (typeof d === 'string')
            clean[k] = String(v ?? '').slice(0, 5000);
        else if (Array.isArray(d))
            clean[k] = Array.isArray(v) ? v.slice(0, 50) : d;
        else if (d && typeof d === 'object') {
            // Maps of short strings: document number prefixes and per-document print templates.
            clean[k] = v && typeof v === 'object' && !Array.isArray(v)
                ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string').map(([key, x]) => [key, x.trim().slice(0, 40)]))
                : d;
        }
    }
    if (section === 'hr' && Array.isArray(clean.weeklyOff))
        clean.weeklyOff = [...new Set(clean.weeklyOff.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if (section === 'transaction' && clean.prefixes) {
        // A blank prefix would make numbers like "1", "2" collide across document types; keep the default instead.
        const p = clean.prefixes;
        for (const [type, def] of Object.entries(DEFAULT_SETTINGS.transaction.prefixes))
            if (type in p && !p[type])
                p[type] = def;
    }
    if (section === 'general' && typeof clean.timezone === 'string' && !isTimeZone(clean.timezone))
        throw AppError.badRequest('Unknown time zone');
    if (section === 'email') {
        // Mailbox passwords are stored encrypted. The mask means "keep the saved password" (re-sealed, which also
        // encrypts a password saved before encryption was added).
        for (const k of ['smtpPass', 'imapPass']) {
            if (typeof clean[k] === 'string')
                clean[k] = sealSecret(clean[k] === SECRET_MASK ? openSecret(current.email[k]) : clean[k]);
        }
    }
    if (section === 'taxes' && Array.isArray(clean.rates)) {
        clean.rates = clean.rates
            .filter((r) => r && typeof r === 'object')
            .map((r) => ({ name: String(r.name ?? `${r.rate}%`).slice(0, 40), rate: Math.min(100, Math.max(0, Number(r.rate) || 0)) }));
    }
    const merged = deepMerge(current[section], clean);
    // An empty per-document template means "use the default template" again.
    if (section === 'print')
        merged.templates = Object.fromEntries(Object.entries(merged.templates).filter(([, v]) => v));
    const next = { ...(company.settings ?? {}), [section]: merged };
    company.set('settings', next);
    company.markModified('settings');
    await company.save();
    if (section === 'email') {
        // Emails fetched from a mailbox that is removed or swapped for another one go with it.
        const box = (e) => `${String(e.imapHost ?? '').toLowerCase()}|${String(e.imapUser ?? '').toLowerCase()}`;
        if (box(current.email) !== box(merged))
            await removeInboxMail(company._id, { keepMarkers: false });
    }
    const redacted = (v) => (section === 'email' ? redactSettings({ ...DEFAULT_SETTINGS, email: v }).email : v);
    await audit(ctx, 'update', 'Settings', company._id, `Settings updated: ${SECTION_LABEL[section]}`, redacted(current[section]), redacted(merged));
    ok(res, redactSettings(resolveSettings(company.settings)));
});
const profileSchema = z.object({
    name: z.string().trim().min(2).max(150),
    phone: z.string().trim().min(5).max(20),
    email,
    address: optStr,
    city: optStr,
    state: optStr,
    pincode: optStr,
    gstin: optStr.refine((v) => !v || BIN_RE.test(v), 'BIN must be 9 digits, optionally with a 4 digit branch suffix'),
    pan: optStr.refine((v) => !v || TIN_RE.test(v), 'TIN must be 12 digits'),
    businessType: optStr,
    businessCategory: optStr,
    website: optStr,
    logo: optionalId,
    signature: optionalId,
});
router.put('/company', requirePermission('settings.manage'), validate(profileSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const company = await Company.findById(ctx.companyId);
    if (!company)
        throw AppError.notFound('Company');
    const before = company.toObject();
    company.set(req.body);
    for (const k of ['logo', 'signature'])
        if (!req.body[k])
            company.set(k, undefined);
    await company.save();
    await audit(ctx, 'update', 'Company', company._id, 'Business profile updated', { ...before, settings: undefined }, { ...company.toObject(), settings: undefined });
    const { settings: _s, ...profile } = company.toObject();
    ok(res, profile);
});
router.post('/email/test', requirePermission('settings.manage'), validate(z.object({ to: z.string().email() })), async (req, res) => {
    const ctx = ctxOf(req);
    const mail = await sendCompanyMail(ctx.companyId, {
        to: [req.body.to],
        subject: `Test email from ${ctx.companyName}`,
        html: `<p>Your email settings are working. This message was sent from <b>${ctx.companyName}</b>.</p>`,
        sentBy: ctx.userId,
    });
    ok(res, mail);
});
router.post('/email/test-imap', requirePermission('settings.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, await testInbox(ctx.companyId));
});
/** Full JSON backup of this company's data (download). */
router.get('/backup', requirePermission('settings.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const c = { company: ctx.companyId };
    const [company, roles, users, parties, groups, items, categories, units, conversions, adjustments, transactions, accounts, entries, loans, loanEntries, expenseCategories, employees, attendance, requests, payroll] = await Promise.all([
        Company.findById(ctx.companyId).lean(), Role.find(c).lean(), User.find(c).lean(), Party.find(c).lean(), PartyGroup.find(c).lean(), Item.find(c).lean(),
        Category.find(c).lean(), Unit.find(c).lean(), UnitConversion.find(c).lean(), StockAdjustment.find(c).lean(), Transaction.find(c).lean(), BankAccount.find(c).lean(),
        BankEntry.find(c).lean(), LoanAccount.find(c).lean(), LoanEntry.find(c).lean(), ExpenseCategory.find(c).lean(), Employee.find(c).lean(), Attendance.find(c).lean(), HrRequest.find(c).lean(), Payroll.find(c).lean(),
    ]);
    const safeCompany = company ? { ...company, settings: redactSettings(resolveSettings(company.settings)) } : null;
    await audit(ctx, 'export', 'Company', ctx.companyId, 'Full data backup downloaded');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${ctx.companyName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify({ version: 1, exportedAt: new Date(), company: safeCompany, roles, users, parties, groups, items, categories, units, conversions, adjustments, transactions, accounts, entries, loans, loanEntries, expenseCategories, employees, attendance, requests, payroll }, null, 1));
});
/** Maintenance: rebuild every derived balance from source documents. */
router.post('/recalculate', requirePermission('settings.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const [docs, parties, items] = await Promise.all([
        Transaction.find({ company: ctx.companyId }).select('_id').lean(),
        Party.find({ company: ctx.companyId }).select('_id').lean(),
        Item.find({ company: ctx.companyId }).select('_id').lean(),
    ]);
    for (let i = 0; i < docs.length; i += 500)
        await recalcDocuments(ctx.companyId, docs.slice(i, i + 500).map((d) => d._id));
    await recalcParties(ctx.companyId, parties.map((p) => p._id));
    await recalcItems(ctx.companyId, items.map((i) => i._id));
    await audit(ctx, 'update', 'Company', ctx.companyId, 'Balances recalculated');
    ok(res, { documents: docs.length, parties: parties.length, items: items.length });
});
export default router;
//# sourceMappingURL=routes.js.map