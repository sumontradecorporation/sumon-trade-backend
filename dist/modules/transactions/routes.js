import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { can, ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, dateRange, ok, oid, pageMeta, pageQuery, round2, searchRegex, str } from '../../core/http.js';
import { TXN_CONFIG, TXN_TYPES } from '../../core/txn.js';
import { optStr } from '../../core/zod.js';
import { validate } from '../../middleware/validate.js';
import { ApprovalRequest, AuditLog, Party, Transaction } from '../../models/index.js';
import { needsApproval, queueForApproval, registerApprovalHandler } from '../../services/approvals.js';
import { sendCompanyMail } from '../../services/mailer.js';
import { onSaleCreated } from '../../services/automations.js';
import { peekNumber } from '../../services/numbering.js';
import { audit } from '../../services/audit.js';
import { cancelSchema, confirmationSchema, deliveryStatusSchema, txnBodySchema } from './schema.js';
import { addConfirmation, assertCan, cancelTxn, createTxn, deleteTxn, getTxnOrThrow, removeConfirmation, updateTxn } from './service.js';
const router = Router();
registerApprovalHandler('txn_update', { approve: (ctx, a) => updateTxn(ctx, a.entityId, txnBodySchema.parse(a.payload)) });
registerApprovalHandler('txn_delete', { approve: (ctx, a) => deleteTxn(ctx, a.entityId) });
registerApprovalHandler('txn_cancel', { approve: (ctx, a) => cancelTxn(ctx, a.entityId, a.payload?.reason) });
function parseTypes(raw) {
    const list = (str(raw) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    for (const t of list)
        if (!TXN_TYPES.includes(t))
            throw AppError.badRequest(`Unknown transaction type ${t}`);
    return list;
}
/** GET /transactions — list with filters + summary for the header cards */
router.get('/', async (req, res) => {
    const ctx = ctxOf(req);
    let types = parseTypes(req.query.type);
    const viewable = TXN_TYPES.filter((t) => can(ctx, `${TXN_CONFIG[t].permission}.view`));
    if (types.length) {
        for (const t of types)
            assertCan(ctx, t, 'view');
    }
    else {
        types = viewable;
    }
    const q = pageQuery(req, 50, 1000);
    const filter = { company: ctx.companyId, type: { $in: types } };
    const range = dateRange(req.query.from, req.query.to);
    if (range)
        filter.date = range;
    if (str(req.query.party))
        filter.party = oid(req.query.party, 'party');
    if (str(req.query.expenseCategory))
        filter.expenseCategory = oid(req.query.expenseCategory, 'category');
    if (str(req.query.paymentAccount))
        filter.paymentAccount = oid(req.query.paymentAccount, 'account');
    if (str(req.query.item))
        filter['items.item'] = oid(req.query.item, 'item');
    if (str(req.query.createdBy))
        filter.createdBy = oid(req.query.createdBy, 'user');
    const status = str(req.query.status);
    if (status === 'OVERDUE') {
        filter.status = { $in: ['UNPAID', 'PARTIAL'] };
        filter.dueDate = { $lt: new Date() };
    }
    else if (status === 'DUE') {
        filter.status = { $in: ['UNPAID', 'PARTIAL'] };
    }
    else if (status)
        filter.status = { $in: status.split(',') };
    const rx = searchRegex(req.query.search);
    if (rx)
        filter.$or = [{ number: rx }, { partyName: rx }, { refNo: rx }, { description: rx }, { paymentType: rx }];
    const sortKey = str(req.query.sort) ?? '-date';
    const sort = sortKey.startsWith('-') ? { [sortKey.slice(1)]: -1 } : { [sortKey]: 1 };
    if (!('createdAt' in sort))
        sort.createdAt = -1;
    const [rows, total, sums] = await Promise.all([
        Transaction.find(filter)
            .sort(sort)
            .skip(q.skip)
            .limit(q.limit)
            .select('-items.description')
            .populate('expenseCategory', 'name')
            .populate('createdBy', 'name')
            .populate('updatedBy', 'name')
            .lean(),
        Transaction.countDocuments(filter),
        Transaction.aggregate([
            { $match: { ...filter, status: status === 'CANCELLED' ? 'CANCELLED' : { ...(filter.status ?? {}), $ne: 'CANCELLED' } } },
            {
                $group: {
                    _id: null,
                    total: { $sum: '$total' },
                    settled: { $sum: { $add: ['$settled', { $ifNull: ['$paidViaPayments', 0] }] } },
                    balance: { $sum: '$balance' },
                    tax: { $sum: '$taxTotal' },
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);
    const s = sums[0] ?? { total: 0, settled: 0, balance: 0, tax: 0, count: 0 };
    ok(res, rows, {
        ...pageMeta(total, q),
        summary: { total: round2(s.total), settled: round2(s.settled), balance: round2(s.balance), tax: round2(s.tax), count: s.count },
    });
});
router.get('/next-number', async (req, res) => {
    const ctx = ctxOf(req);
    const [type] = parseTypes(req.query.type);
    if (!type)
        throw AppError.badRequest('type is required');
    const p = TXN_CONFIG[type].permission;
    if (!can(ctx, `${p}.create`) && !can(ctx, `${p}.edit`))
        assertCan(ctx, type, 'create');
    ok(res, { number: await peekNumber(ctx.companyId, type, ctx.settings) });
});
/** Open invoices / bills of a party that a payment can be linked to */
router.get('/open-documents', async (req, res) => {
    const ctx = ctxOf(req);
    const party = oid(req.query.party, 'party');
    const [paymentType] = parseTypes(req.query.paymentType);
    const target = paymentType === 'PAYMENT_OUT' ? 'PURCHASE' : 'SALE';
    assertCan(ctx, target, 'view');
    const excludePayment = str(req.query.exclude);
    const docs = await Transaction.find({ company: ctx.companyId, party, type: target, status: { $ne: 'CANCELLED' } })
        .sort({ date: 1 })
        .select('number date total settled paidViaPayments balance status dueDate')
        .lean();
    let own = new Map();
    if (excludePayment && Types.ObjectId.isValid(excludePayment)) {
        const p = await Transaction.findOne({ _id: excludePayment, company: ctx.companyId }).select('allocations').lean();
        own = new Map((p?.allocations ?? []).map((a) => [String(a.transaction), a.amount]));
    }
    const rows = docs
        .map((d) => ({ ...d, outstanding: round2(d.total - d.settled - (d.paidViaPayments ?? 0) + (own.get(String(d._id)) ?? 0)) }))
        .filter((d) => d.outstanding > 0);
    ok(res, rows);
});
router.get('/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const doc = await Transaction.findOne({ _id: oid(req.params.id), company: ctx.companyId })
        .populate('party', 'name phone email gstin billingAddress shippingAddress state balance')
        .populate('expenseCategory', 'name')
        .populate('paymentAccount', 'name kind bankName accountNumber ifsc upiId')
        .populate('cheque.account', 'name')
        .populate('attachments', 'originalName mime size')
        .populate('docFiles.po', 'originalName mime size')
        .populate('docFiles.challan', 'originalName mime size')
        .populate('docFiles.bill', 'originalName mime size')
        .populate('confirmations.file', 'originalName mime size')
        .populate('confirmations.uploadedBy', 'name')
        .populate('createdBy', 'name')
        .populate('updatedBy', 'name')
        .lean();
    if (!doc)
        throw AppError.notFound('Transaction');
    assertCan(ctx, doc.type, 'view');
    const pending = await ApprovalRequest.find({ company: ctx.companyId, entityId: doc._id, status: 'pending' }).select('kind label createdAt').lean();
    ok(res, { ...doc, pendingApprovals: pending });
});
router.get('/:id/history', async (req, res) => {
    const ctx = ctxOf(req);
    const doc = await getTxnOrThrow(ctx, String(req.params.id));
    assertCan(ctx, doc.type, 'view');
    const [logs, approvals] = await Promise.all([
        AuditLog.find({ company: ctx.companyId, entityId: doc._id }).sort({ createdAt: -1 }).limit(200).lean(),
        ApprovalRequest.find({ company: ctx.companyId, entityId: doc._id }).sort({ createdAt: -1 }).populate('requestedBy reviewedBy', 'name').lean(),
    ]);
    ok(res, { logs, approvals });
});
router.post('/', validate(txnBodySchema), async (req, res) => {
    const ctx = ctxOf(req);
    const doc = await createTxn(ctx, req.body);
    if (doc.type === 'SALE')
        void onSaleCreated(ctx.companyId, doc._id);
    created(res, doc);
});
router.put('/:id', validate(txnBodySchema), async (req, res) => {
    const ctx = ctxOf(req);
    const existing = await getTxnOrThrow(ctx, String(req.params.id));
    assertCan(ctx, existing.type, 'edit');
    const perm = TXN_CONFIG[existing.type].permission;
    if (needsApproval(ctx, `${perm}.edit`)) {
        return queueForApproval(res, ctx, {
            kind: 'txn_update',
            entity: 'Transaction',
            entityId: existing._id,
            label: `Edit ${TXN_CONFIG[existing.type].label} ${existing.number}`,
            payload: req.body,
            before: existing.toObject(),
        });
    }
    ok(res, await updateTxn(ctx, existing._id, req.body));
});
router.post('/:id/cancel', validate(cancelSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const existing = await getTxnOrThrow(ctx, String(req.params.id));
    assertCan(ctx, existing.type, 'edit');
    const del = `${TXN_CONFIG[existing.type].permission}.delete`;
    // Cancelling voids a document, so it applies at once only for a role that could delete it outright
    if (!ctx.isSuperAdmin && (!can(ctx, del) || needsApproval(ctx, del))) {
        return queueForApproval(res, ctx, {
            kind: 'txn_cancel',
            entity: 'Transaction',
            entityId: existing._id,
            label: `Cancel ${TXN_CONFIG[existing.type].label} ${existing.number}`,
            payload: req.body,
            reason: req.body.reason,
        });
    }
    ok(res, await cancelTxn(ctx, existing._id, req.body.reason));
});
router.delete('/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const existing = await getTxnOrThrow(ctx, String(req.params.id));
    assertCan(ctx, existing.type, 'delete');
    if (needsApproval(ctx, `${TXN_CONFIG[existing.type].permission}.delete`)) {
        return queueForApproval(res, ctx, {
            kind: 'txn_delete',
            entity: 'Transaction',
            entityId: existing._id,
            label: `Delete ${TXN_CONFIG[existing.type].label} ${existing.number}`,
            before: existing.toObject(),
            reason: str(req.query.reason),
        });
    }
    ok(res, await deleteTxn(ctx, existing._id));
});
router.post('/:id/confirmations', validate(confirmationSchema), async (req, res) => {
    ok(res, await addConfirmation(ctxOf(req), req.params.id, req.body));
});
router.delete('/:id/confirmations/:cid', async (req, res) => {
    ok(res, await removeConfirmation(ctxOf(req), req.params.id, req.params.cid));
});
router.patch('/:id/delivery-status', validate(deliveryStatusSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const doc = await getTxnOrThrow(ctx, String(req.params.id));
    assertCan(ctx, doc.type, 'edit');
    doc.deliveryStatus = req.body.deliveryStatus;
    await doc.save();
    await audit(ctx, 'update', 'Transaction', doc._id, `${doc.number} marked ${req.body.deliveryStatus}`);
    ok(res, doc.toObject());
});
const emailSchema = z.object({
    to: z.array(z.string().trim().email()).min(1, 'Add at least one recipient'),
    cc: z.array(z.string().trim().email()).default([]),
    subject: z.string().trim().min(1),
    message: optStr,
    fileId: optStr,
});
/** Email a document (the PDF is generated in the browser and uploaded first) */
router.post('/:id/email', validate(emailSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const doc = await getTxnOrThrow(ctx, String(req.params.id));
    assertCan(ctx, doc.type, 'view');
    const body = req.body;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${(body.message ?? '').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>`;
    const mail = await sendCompanyMail(ctx.companyId, {
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        html,
        text: body.message ?? '',
        fileIds: body.fileId ? [body.fileId] : [],
        related: doc._id,
        sentBy: ctx.userId,
    });
    await audit(ctx, 'email', 'Transaction', doc._id, `${doc.number} emailed to ${body.to.join(', ')}`);
    ok(res, mail);
});
/** Party ledger summary used by party detail header */
router.get('/party/:partyId/summary', async (req, res) => {
    const ctx = ctxOf(req);
    if (!can(ctx, 'parties.view'))
        throw AppError.forbidden();
    const party = await Party.findOne({ _id: oid(req.params.partyId), company: ctx.companyId }).lean();
    if (!party)
        throw AppError.notFound('Party');
    const agg = await Transaction.aggregate([
        { $match: { company: ctx.companyId, party: party._id, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: '$type', total: { $sum: '$total' }, balance: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]);
    ok(res, { party, byType: agg });
});
export default router;
//# sourceMappingURL=routes.js.map