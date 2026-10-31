import { Router } from 'express';
import { z } from 'zod';
import { can, ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { dateRange, ok, oid, pageMeta, pageQuery, searchRegex, str } from '../../core/http.js';
import { TXN_CONFIG, TXN_TYPES } from '../../core/txn.js';
import { optStr } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { ApprovalRequest, AuditLog, EmailMessage, Employee, HrRequest, Item, Notification, Party, Transaction } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { decideApproval } from '../../services/approvals.js';
const router = Router();
/* ---------------- Approvals ---------------- */
router.get('/approvals', async (req, res) => {
    const ctx = ctxOf(req);
    const filter = { company: ctx.companyId };
    // Approvers see every request; everyone else sees their own requests.
    if (!can(ctx, 'approvals.manage'))
        filter.requestedBy = ctx.userId;
    if (str(req.query.status))
        filter.status = req.query.status;
    if (str(req.query.kind))
        filter.kind = req.query.kind;
    const q = pageQuery(req, 50, 500);
    const [rows, total] = await Promise.all([
        ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).populate('requestedBy reviewedBy', 'name').lean(),
        ApprovalRequest.countDocuments(filter),
    ]);
    ok(res, rows, pageMeta(total, q));
});
router.get('/approvals/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const a = await ApprovalRequest.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('requestedBy reviewedBy', 'name').lean();
    if (!a)
        throw AppError.notFound('Approval request');
    if (!can(ctx, 'approvals.manage') && String(a.requestedBy._id) !== String(ctx.userId))
        throw AppError.forbidden();
    ok(res, a);
});
router.post('/approvals/:id/decision', requirePermission('approvals.manage'), validate(z.object({ decision: z.enum(['approve', 'reject']), note: optStr })), async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, await decideApproval(ctx, req.params.id, req.body.decision, req.body.note));
});
router.post('/approvals/:id/withdraw', async (req, res) => {
    const ctx = ctxOf(req);
    const a = await ApprovalRequest.findOne({ _id: oid(req.params.id), company: ctx.companyId, requestedBy: ctx.userId, status: 'pending' });
    if (!a)
        throw AppError.notFound('Pending request');
    // A withdrawn leave / advance request disappears together with its approval.
    if (a.kind === 'hr_request' && a.entityId)
        await HrRequest.deleteOne({ _id: a.entityId, company: ctx.companyId, status: 'pending' });
    await a.deleteOne();
    await audit(ctx, 'withdraw', a.entity, a.entityId, `Request withdrawn: ${a.label}`);
    ok(res, { withdrawn: true });
});
/* ---------------- Quick search (Ctrl + K) ---------------- */
/** Parties, items, documents and employees matching `q`, each only when the user may see that area. */
router.get('/search', async (req, res) => {
    const ctx = ctxOf(req);
    const rx = searchRegex(req.query.q);
    if (!rx)
        return ok(res, { parties: [], items: [], documents: [], employees: [] });
    const docTypes = TXN_TYPES.filter((t) => can(ctx, `${TXN_CONFIG[t].permission}.view`));
    const [parties, items, documents, employees] = await Promise.all([
        can(ctx, 'parties.view')
            ? Party.find({ company: ctx.companyId, $or: [{ name: rx }, { phone: rx }, { gstin: rx }] }).select('name phone balance isActive').sort({ name: 1 }).collation({ locale: 'en' }).limit(6).lean()
            : [],
        can(ctx, 'items.view')
            ? Item.find({ company: ctx.companyId, $or: [{ name: rx }, { code: rx }, { hsn: rx }] }).select('name code type stock salePrice isActive').sort({ name: 1 }).collation({ locale: 'en' }).limit(6).lean()
            : [],
        docTypes.length
            ? Transaction.find({ company: ctx.companyId, type: { $in: docTypes }, $or: [{ number: rx }, { partyName: rx }, { refNo: rx }] })
                .select('type number partyName date total status')
                .sort({ date: -1, _id: -1 })
                .limit(8)
                .lean()
            : [],
        can(ctx, 'employees.view') || can(ctx, 'employees.manage')
            ? Employee.find({ company: ctx.companyId, $or: [{ name: rx }, { phone: rx }, { code: rx }] }).select('name designation phone status').sort({ name: 1 }).limit(4).lean()
            : [],
    ]);
    ok(res, { parties, items, documents, employees });
});
/* ---------------- Notifications ---------------- */
router.get('/notifications', async (req, res) => {
    const ctx = ctxOf(req);
    const filter = { user: ctx.userId, company: ctx.companyId };
    if (req.query.unread === 'true')
        filter.read = false;
    const q = pageQuery(req, 30, 200);
    const [rows, total, unread, pendingApprovals, unreadEmail] = await Promise.all([
        Notification.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments({ user: ctx.userId, company: ctx.companyId, read: false }),
        can(ctx, 'approvals.manage') ? ApprovalRequest.countDocuments({ company: ctx.companyId, status: 'pending' }) : Promise.resolve(0),
        can(ctx, 'email.use') ? EmailMessage.countDocuments({ company: ctx.companyId, folder: 'inbox', read: false, deleted: { $ne: true } }) : Promise.resolve(0),
    ]);
    ok(res, rows, { ...pageMeta(total, q), unread, pendingApprovals, unreadEmail });
});
router.post('/notifications/read', validate(z.object({ ids: z.array(z.string()).optional() })), async (req, res) => {
    const ctx = ctxOf(req);
    const filter = { user: ctx.userId, company: ctx.companyId, read: false };
    if (req.body.ids?.length)
        filter._id = { $in: req.body.ids.map((i) => oid(i)) };
    const r = await Notification.updateMany(filter, { $set: { read: true } });
    ok(res, { updated: r.modifiedCount });
});
/** Clears every notification the user has already read in this company. */
router.delete('/notifications', async (req, res) => {
    const ctx = ctxOf(req);
    const r = await Notification.deleteMany({ user: ctx.userId, company: ctx.companyId, read: true });
    ok(res, { deleted: r.deletedCount });
});
router.delete('/notifications/:id', async (req, res) => {
    const ctx = ctxOf(req);
    await Notification.deleteOne({ _id: oid(req.params.id), user: ctx.userId, company: ctx.companyId });
    ok(res, { deleted: true });
});
/* ---------------- Activity log ---------------- */
router.get('/audit', requirePermission('audit.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const q = pageQuery(req, 50, 500);
    const filter = { company: ctx.companyId };
    if (str(req.query.user))
        filter.user = oid(req.query.user);
    if (str(req.query.entity))
        filter.entity = req.query.entity;
    if (str(req.query.action))
        filter.action = req.query.action;
    if (str(req.query.entityId))
        filter.entityId = oid(req.query.entityId);
    const range = dateRange(req.query.from, req.query.to);
    if (range)
        filter.createdAt = range;
    const rx = searchRegex(req.query.search);
    if (rx)
        filter.$or = [{ label: rx }, { userName: rx }];
    const [rows, total] = await Promise.all([
        AuditLog.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).select(req.query.full === 'true' ? '' : '-before -after').lean(),
        AuditLog.countDocuments(filter),
    ]);
    ok(res, rows, pageMeta(total, q));
});
/** Everyone with activity in this company, including users from other companies who switched in. */
router.get('/audit/users', requirePermission('audit.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const rows = await AuditLog.aggregate([
        { $match: { company: ctx.companyId, user: { $ne: null } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$user', name: { $first: '$userName' } } },
        { $sort: { name: 1 } },
    ]);
    ok(res, rows.map((r) => ({ _id: String(r._id), name: r.name ?? 'Unknown' })));
});
router.get('/audit/:id', requirePermission('audit.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const log = await AuditLog.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
    if (!log)
        throw AppError.notFound('Log entry');
    ok(res, log);
});
export default router;
//# sourceMappingURL=routes.js.map