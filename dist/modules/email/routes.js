import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { ok, oid, pageMeta, pageQuery, searchRegex, str } from '../../core/http.js';
import { optStr } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { EmailMessage } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { sendCompanyMail, smtpConfigured } from '../../services/mailer.js';
import { removeInboxMail, syncInbox } from '../../services/imap.js';
const router = Router();
router.use(requirePermission('email.use'));
const imapConfigured = (ctx) => {
    const s = ctx.settings.email;
    return !!(s.imapHost && s.imapUser && s.imapPass);
};
router.get('/status', (req, res) => {
    const s = ctxOf(req).settings.email;
    ok(res, {
        smtp: smtpConfigured(ctxOf(req).settings),
        imap: imapConfigured(ctxOf(req)),
        automations: { autoSendInvoice: s.autoSendInvoice, paymentReminders: s.paymentReminders, dailySummary: s.dailySummary },
    });
});
router.get('/messages', async (req, res) => {
    const ctx = ctxOf(req);
    const q = pageQuery(req, 30, 200);
    const filter = { company: ctx.companyId, folder: str(req.query.folder) === 'sent' ? 'sent' : 'inbox', deleted: { $ne: true } };
    const rx = searchRegex(req.query.search);
    if (rx)
        filter.$or = [{ subject: rx }, { from: rx }, { to: rx }];
    const [rows, total, unread] = await Promise.all([
        // A short plain text preview for the list; the full bodies load when a message is opened.
        EmailMessage.aggregate([
            { $match: filter },
            { $sort: { date: -1 } },
            { $skip: q.skip },
            { $limit: q.limit },
            { $set: { snippet: { $substrCP: [{ $ifNull: ['$text', ''] }, 0, 180] } } },
            { $unset: ['html', 'text'] },
        ]),
        EmailMessage.countDocuments(filter),
        EmailMessage.countDocuments({ company: ctx.companyId, folder: 'inbox', read: false, deleted: { $ne: true } }),
    ]);
    ok(res, rows, { ...pageMeta(total, q), unread });
});
router.get('/messages/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const m = await EmailMessage.findOneAndUpdate({ _id: oid(req.params.id), company: ctx.companyId, deleted: { $ne: true } }, { $set: { read: true } }, { returnDocument: 'after' }).lean();
    if (!m)
        throw AppError.notFound('Email');
    ok(res, m);
});
router.post('/messages/:id/read', validate(z.object({ read: z.boolean() })), async (req, res) => {
    const ctx = ctxOf(req);
    const r = await EmailMessage.updateOne({ _id: oid(req.params.id), company: ctx.companyId }, { $set: { read: req.body.read } });
    if (!r.matchedCount)
        throw AppError.notFound('Email');
    ok(res, { read: req.body.read });
});
/** Removes every fetched inbox email from the app. The mailbox on the email server is not touched. */
router.delete('/messages', requirePermission('settings.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const r = await removeInboxMail(ctx.companyId, { keepMarkers: imapConfigured(ctx) });
    await audit(ctx, 'delete', 'Email', ctx.companyId, `Removed ${r.removed} fetched inbox email(s)`);
    ok(res, r);
});
router.delete('/messages/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const m = await EmailMessage.findOne({ _id: oid(req.params.id), company: ctx.companyId }).select('folder').lean();
    if (m?.folder === 'inbox')
        await removeInboxMail(ctx.companyId, { ids: [m._id], keepMarkers: true });
    else if (m)
        await EmailMessage.deleteOne({ _id: m._id });
    ok(res, { deleted: true });
});
const sendSchema = z.object({
    to: z.array(z.string().trim().email()).min(1, 'Add at least one recipient'),
    cc: z.array(z.string().trim().email()).default([]),
    subject: z.string().trim().min(1, 'Subject is required').max(300),
    body: optStr,
    attachments: z.array(z.string()).max(10).default([]),
    /** Id of the received email this one answers, so mail apps thread the conversation. */
    inReplyTo: optStr,
});
router.post('/send', validate(sendSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${(b.body ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>`;
    const original = b.inReplyTo ? await EmailMessage.findOne({ _id: oid(b.inReplyTo), company: ctx.companyId }).select('messageId').lean() : null;
    const m = await sendCompanyMail(ctx.companyId, {
        to: b.to,
        cc: b.cc,
        subject: b.subject,
        html,
        text: b.body,
        fileIds: b.attachments,
        sentBy: ctx.userId,
        inReplyTo: original?.messageId ?? undefined,
    });
    await audit(ctx, 'email', 'Email', m._id, `Email "${b.subject}" sent to ${b.to.join(', ')}`);
    ok(res, m);
});
router.post('/sync', async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, await syncInbox(ctx.companyId));
});
/** Fetches the next batch of emails older than the ones already here. */
router.post('/sync/older', async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, await syncInbox(ctx.companyId, 'older'));
});
export default router;
//# sourceMappingURL=routes.js.map