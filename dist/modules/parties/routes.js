import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, escapeRegex, ok, oid, pageMeta, pageQuery, round2, searchRegex, str } from '../../core/http.js';
import { BIN_RE, normalizeDivision } from '../../core/bangladesh.js';
import { zonedNow } from '../../core/time.js';
import { email, money, objectId, optDate, optStr, optionalId, phone } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { memoryUpload } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { Party, PartyGroup, Transaction } from '../../models/index.js';
import { needsApproval, queueForApproval, registerApprovalHandler } from '../../services/approvals.js';
import { audit } from '../../services/audit.js';
import { parseSheet, templateXlsx, toXlsx } from '../../services/excel.js';
import { recalcParties } from '../../services/ledger.js';
const router = Router();
export const partySchema = z.object({
    name: z.string().trim().min(1, 'Party name is required').max(150),
    phone,
    email,
    gstin: optStr.refine((g) => !g || BIN_RE.test(g), 'BIN must be 9 digits, optionally with a 4 digit branch suffix'),
    gstType: z.enum(['unregistered', 'regular', 'composition', 'consumer']).default('unregistered'),
    state: optStr,
    billingAddress: optStr,
    shippingAddress: optStr,
    group: optionalId,
    partyType: z.enum(['customer', 'supplier', 'both']).default('both'),
    openingBalance: money,
    openingType: z.enum(['receive', 'pay']).default('receive'),
    openingBalanceDate: optDate,
    creditLimit: z.coerce.number().min(0).optional().nullable().transform((v) => v ?? undefined),
    notes: optStr,
    isActive: z.boolean().default(true),
});
function toDoc(b) {
    const { openingType, openingBalance, ...rest } = b;
    return { ...rest, openingBalance: openingType === 'pay' ? -openingBalance : openingBalance, openingBalanceDate: b.openingBalanceDate ?? new Date() };
}
async function assertUniqueName(companyId, name, exceptId) {
    const exists = await Party.exists({ company: companyId, name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    if (exists)
        throw AppError.conflict(`A party named "${name}" already exists`);
}
async function assertGroup(companyId, group) {
    if (group && !(await PartyGroup.exists({ _id: group, company: companyId })))
        throw AppError.badRequest('Group not found');
}
/* ---------------- Groups ---------------- */
router.get('/groups', requirePermission('parties.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const [groups, stats] = await Promise.all([
        PartyGroup.find({ company: ctx.companyId }).sort({ name: 1 }).lean(),
        Party.aggregate([
            { $match: { company: ctx.companyId } },
            {
                $group: {
                    _id: '$group',
                    parties: { $sum: 1 },
                    receivable: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } },
                    payable: { $sum: { $cond: [{ $lt: ['$balance', 0] }, { $abs: '$balance' }, 0] } },
                },
            },
        ]),
    ]);
    const m = new Map(stats.map((s) => [String(s._id), s]));
    const ungrouped = m.get('null');
    ok(res, {
        groups: groups.map((g) => ({ ...g, parties: m.get(String(g._id))?.parties ?? 0, receivable: round2(m.get(String(g._id))?.receivable ?? 0), payable: round2(m.get(String(g._id))?.payable ?? 0) })),
        ungrouped: { parties: ungrouped?.parties ?? 0, receivable: round2(ungrouped?.receivable ?? 0), payable: round2(ungrouped?.payable ?? 0) },
    });
});
const groupSchema = z.object({ name: z.string().trim().min(1).max(80), description: optStr });
router.post('/groups', requirePermission('parties.create'), validate(groupSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const g = await PartyGroup.create({ ...req.body, company: ctx.companyId });
    await audit(ctx, 'create', 'PartyGroup', g._id, `Party group ${g.name} created`);
    created(res, g.toObject());
});
router.put('/groups/:id', requirePermission('parties.edit'), validate(groupSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const g = await PartyGroup.findOneAndUpdate({ _id: oid(req.params.id), company: ctx.companyId }, { $set: req.body }, { returnDocument: 'after' }).lean();
    if (!g)
        throw AppError.notFound('Group');
    await audit(ctx, 'update', 'PartyGroup', g._id, `Party group ${g.name} updated`);
    ok(res, g);
});
async function deleteGroup(ctx, id) {
    const g = await PartyGroup.findOneAndDelete({ _id: id, company: ctx.companyId }).lean();
    if (!g)
        throw AppError.notFound('Group');
    await Party.updateMany({ company: ctx.companyId, group: g._id }, { $unset: { group: 1 } });
    await audit(ctx, 'delete', 'PartyGroup', g._id, `Party group ${g.name} deleted`);
}
registerApprovalHandler('party_group_delete', { approve: (ctx, a) => deleteGroup(ctx, a.entityId) });
router.delete('/groups/:id', requirePermission('parties.delete'), async (req, res) => {
    const ctx = ctxOf(req);
    const g = await PartyGroup.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
    if (!g)
        throw AppError.notFound('Group');
    if (needsApproval(ctx, 'parties.delete')) {
        const parties = await Party.countDocuments({ company: ctx.companyId, group: g._id });
        return queueForApproval(res, ctx, { kind: 'party_group_delete', entity: 'PartyGroup', entityId: g._id, label: `Delete party group ${g.name}`, before: { ...g, parties } });
    }
    await deleteGroup(ctx, g._id);
    ok(res, { deleted: true });
});
router.post('/move-group', requirePermission('parties.edit'), validate(z.object({ parties: z.array(objectId).min(1), group: optionalId })), async (req, res) => {
    const ctx = ctxOf(req);
    await assertGroup(ctx.companyId, req.body.group);
    const update = req.body.group ? { $set: { group: req.body.group } } : { $unset: { group: 1 } };
    const r = await Party.updateMany({ company: ctx.companyId, _id: { $in: req.body.parties } }, update);
    await audit(ctx, 'update', 'Party', undefined, `${r.modifiedCount} part${r.modifiedCount === 1 ? 'y' : 'ies'} moved to another group`);
    ok(res, { moved: r.modifiedCount });
});
/* ---------------- Bulk import / export ---------------- */
const IMPORT_HEADERS = ['Party Name*', 'Phone', 'Email', 'BIN', 'VAT Type', 'Division', 'Billing Address', 'Shipping Address', 'Group', 'Party Type', 'Opening Balance', 'Balance Type', 'Credit Limit', 'Notes'];
router.get('/import/template', requirePermission('parties.import'), async (_req, res) => {
    const buf = await templateXlsx('Parties', IMPORT_HEADERS, [
        ['Hossain Electronics', '01712345678', 'accounts@hossain.example', '000123456-0101', 'VAT Registered', 'Dhaka', 'Shop 4, Elephant Road, Dhaka', '', 'Retailers', 'Customer', 12500, 'To receive', 50000, ''],
        ['Chowdhury Wholesale Suppliers', '01812345678', '', '', 'Unregistered', 'Chattogram', 'Khatunganj, Chattogram', '', 'Suppliers', 'Supplier', 8000, 'To pay', '', 'Pays by cheque'],
    ], ['Phone', 'BIN']);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="parties-import-template.xlsx"');
    res.send(buf);
});
/** VAT registration types; the stored keys stay regular / composition so existing parties keep their type. */
const VAT_TYPES = {
    unregistered: 'unregistered', 'unregistered / consumer': 'unregistered', consumer: 'consumer',
    regular: 'regular', registered: 'regular', 'vat registered': 'regular', vat: 'regular',
    composition: 'composition', 'turnover tax': 'composition', 'turnover tax enlisted': 'composition', enlisted: 'composition',
};
const PARTY_TYPES = { customer: 'customer', supplier: 'supplier', vendor: 'supplier', both: 'both' };
const TO_PAY = /^(to pay|pay|payable|cr|credit)$/i;
const TO_RECEIVE = /^(to receive|receive|receivable|dr|debit)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Turns one sheet row into a party, with every problem the row has in plain words. */
function readPartyRow(r) {
    const errors = [];
    const name = (r['Party Name*'] ?? r['Party Name'] ?? r['Name'] ?? '').trim();
    if (!name)
        errors.push('Name is required');
    if (name.length > 150)
        errors.push('Name is longer than 150 characters');
    const phoneNo = (r['Phone'] ?? r['Phone No'] ?? '').trim();
    if (phoneNo && !/^[+\d][\d\s-]{5,19}$/.test(phoneNo))
        errors.push('Phone is not a valid number');
    const mail = (r['Email'] ?? '').trim().toLowerCase();
    if (mail && !EMAIL_RE.test(mail))
        errors.push('Email is not valid');
    const gstin = (r['BIN'] ?? '').trim();
    if (gstin && !BIN_RE.test(gstin))
        errors.push('BIN must be 9 digits, optionally with a 4 digit branch suffix (000123456-0101)');
    const vatText = (r['VAT Type'] ?? '').trim().toLowerCase();
    const gstType = vatText ? VAT_TYPES[vatText] : gstin ? 'regular' : 'unregistered';
    if (!gstType)
        errors.push('VAT Type must be Unregistered, VAT Registered or Turnover Tax');
    const divisionText = (r['Division'] ?? '').trim();
    const state = divisionText ? normalizeDivision(divisionText) : undefined;
    if (divisionText && !state)
        errors.push(`"${divisionText}" is not a division of Bangladesh`);
    const typeText = (r['Party Type'] ?? '').trim().toLowerCase();
    const partyType = typeText ? PARTY_TYPES[typeText] : 'both';
    if (!partyType)
        errors.push('Party Type must be Customer, Supplier or Both');
    const openingRaw = (r['Opening Balance'] ?? '').replace(/,/g, '').trim();
    const opening = openingRaw ? Number(openingRaw) : 0;
    if (!Number.isFinite(opening))
        errors.push('Opening Balance is not a number');
    const balanceText = (r['Balance Type'] ?? '').trim();
    if (balanceText && !TO_PAY.test(balanceText) && !TO_RECEIVE.test(balanceText))
        errors.push('Balance Type must be To receive or To pay');
    // A negative balance with no type means the business owes the party
    const openingType = TO_PAY.test(balanceText) || (!balanceText && opening < 0) ? 'pay' : 'receive';
    const limitRaw = (r['Credit Limit'] ?? '').replace(/,/g, '').trim();
    const creditLimit = limitRaw ? Number(limitRaw) : undefined;
    if (creditLimit !== undefined && !(creditLimit >= 0))
        errors.push('Credit Limit is not a number');
    const billingAddress = (r['Billing Address'] ?? r['Address'] ?? '').trim() || undefined;
    return {
        name,
        phone: phoneNo || undefined,
        email: mail || undefined,
        gstin: gstin || undefined,
        gstType: gstType ?? 'unregistered',
        state,
        billingAddress,
        shippingAddress: (r['Shipping Address'] ?? '').trim() || undefined,
        group: (r['Group'] ?? '').trim() || undefined,
        partyType: partyType ?? 'both',
        openingBalance: Number.isFinite(opening) ? Math.abs(opening) : 0,
        openingType,
        creditLimit: creditLimit !== undefined && creditLimit >= 0 ? creditLimit : undefined,
        notes: (r['Notes'] ?? '').trim() || undefined,
        errors,
    };
}
router.post('/import/parse', requirePermission('parties.import'), memoryUpload.single('file'), async (req, res) => {
    const ctx = ctxOf(req);
    if (!req.file)
        throw AppError.badRequest('Upload an .xlsx or .csv file');
    const raw = await parseSheet(req.file.buffer, req.file.originalname);
    const existing = new Set((await Party.find({ company: ctx.companyId }).select('name').lean()).map((p) => p.name.toLowerCase()));
    const seen = new Set();
    const rows = raw.slice(0, 5000).map((r, i) => {
        const row = readPartyRow(r);
        const key = row.name.toLowerCase();
        if (key && existing.has(key))
            row.errors.push('Already exists');
        if (key && seen.has(key))
            row.errors.push('Duplicate in file');
        seen.add(key);
        return { row: i + 2, ...row };
    });
    ok(res, { rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length });
});
const bulkPartySchema = partySchema.omit({ group: true, openingBalanceDate: true, isActive: true }).extend({
    state: optStr.refine((s) => !s || !!normalizeDivision(s), 'Unknown division'),
    gstin: optStr.refine((g) => !g || BIN_RE.test(g), 'BIN is not valid'),
    group: z.string().trim().max(80).optional(),
});
router.post('/bulk', requirePermission('parties.import'), validate(z.object({ parties: z.array(bulkPartySchema).min(1).max(5000) })), async (req, res) => {
    const ctx = ctxOf(req);
    const rows = req.body.parties;
    const groups = new Map();
    for (const g of await PartyGroup.find({ company: ctx.companyId }).lean())
        groups.set(g.name.toLowerCase(), g._id);
    const groupId = async (name) => {
        if (!name)
            return undefined;
        const k = name.toLowerCase();
        if (!groups.has(k))
            groups.set(k, (await PartyGroup.create({ company: ctx.companyId, name }))._id);
        return groups.get(k);
    };
    // Opening balances are as of today in the company's time zone, stored as UTC midnight like every business date
    const asOf = new Date(`${zonedNow(ctx.settings.general.timezone).day}T00:00:00.000Z`);
    const existing = new Set((await Party.find({ company: ctx.companyId }).select('name').lean()).map((p) => p.name.toLowerCase()));
    const createdIds = [];
    const skipped = [];
    for (const r of rows) {
        if (existing.has(r.name.toLowerCase())) {
            skipped.push({ name: r.name, reason: 'Already exists' });
            continue;
        }
        try {
            const { group, openingType, openingBalance, ...rest } = r;
            const party = await Party.create({
                ...rest,
                state: rest.state ? normalizeDivision(rest.state) : undefined,
                group: await groupId(group),
                openingBalance: openingType === 'pay' ? -openingBalance : openingBalance,
                openingBalanceDate: asOf,
                company: ctx.companyId,
                createdBy: ctx.userId,
            });
            existing.add(r.name.toLowerCase());
            createdIds.push(party._id);
        }
        catch (err) {
            skipped.push({ name: r.name, reason: err instanceof Error ? err.message : 'Failed' });
        }
    }
    await recalcParties(ctx.companyId, createdIds);
    await audit(ctx, 'import', 'Party', undefined, `${createdIds.length} part${createdIds.length === 1 ? 'y' : 'ies'} imported${skipped.length ? `, ${skipped.length} skipped` : ''}`);
    ok(res, { created: createdIds.length, skipped });
});
router.get('/export', requirePermission('parties.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const parties = await Party.find({ company: ctx.companyId }).populate('group', 'name').sort({ name: 1 }).collation({ locale: 'en' }).lean();
    const VAT_LABEL = { unregistered: 'Unregistered', consumer: 'Consumer', regular: 'VAT Registered', composition: 'Turnover Tax' };
    const rows = parties.map((p) => ({
        name: p.name, phone: p.phone, email: p.email, gstin: p.gstin, gstType: VAT_LABEL[p.gstType ?? ''] ?? p.gstType, state: p.state, billingAddress: p.billingAddress,
        group: p.group?.name, partyType: p.partyType, receivable: p.balance > 0 ? p.balance : 0, payable: p.balance < 0 ? -p.balance : 0,
        creditLimit: p.creditLimit, status: p.isActive === false ? 'Inactive' : 'Active',
    }));
    const buf = await toXlsx({
        title: 'Parties',
        subtitle: `${ctx.companyName} — exported ${new Date().toLocaleString('en-IN')}`,
        columns: [
            { key: 'name', label: 'Party Name', width: 30 }, { key: 'phone', label: 'Phone', width: 16 }, { key: 'email', label: 'Email' }, { key: 'gstin', label: 'BIN', width: 18 },
            { key: 'gstType', label: 'VAT Type', width: 16 }, { key: 'state', label: 'Division' }, { key: 'billingAddress', label: 'Billing Address', width: 32 }, { key: 'group', label: 'Group' },
            { key: 'partyType', label: 'Party Type', width: 12 }, { key: 'receivable', label: 'To Receive', type: 'money' }, { key: 'payable', label: 'To Pay', type: 'money' },
            { key: 'creditLimit', label: 'Credit Limit', type: 'money' }, { key: 'status', label: 'Status', width: 10 },
        ],
        rows,
        totals: { receivable: round2(rows.reduce((s, r) => s + r.receivable, 0)), payable: round2(rows.reduce((s, r) => s + r.payable, 0)) },
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="parties.xlsx"');
    res.send(buf);
});
/* ---------------- Parties ---------------- */
router.get('/', requirePermission('parties.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const q = pageQuery(req, 500, 5000);
    const filter = { company: ctx.companyId };
    const rx = searchRegex(req.query.search);
    if (rx)
        filter.$or = [{ name: rx }, { phone: rx }, { email: rx }, { gstin: rx }];
    const group = str(req.query.group);
    if (group === 'none')
        filter.group = { $exists: false };
    else if (group)
        filter.group = oid(group, 'group');
    if (req.query.balance === 'receivable')
        filter.balance = { $gt: 0 };
    if (req.query.balance === 'payable')
        filter.balance = { $lt: 0 };
    if (str(req.query.partyType))
        filter.partyType = { $in: [req.query.partyType, 'both'] };
    if (req.query.active !== 'all')
        filter.isActive = { $ne: false };
    const sort = req.query.sort === 'balance' ? { balance: -1 } : { name: 1 };
    const [rows, total, sums] = await Promise.all([
        Party.find(filter).sort(sort).skip(q.skip).limit(q.limit).populate('group', 'name').collation({ locale: 'en' }).lean(),
        Party.countDocuments(filter),
        Party.aggregate([
            { $match: { company: ctx.companyId } },
            {
                $group: {
                    _id: null,
                    receivable: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } },
                    payable: { $sum: { $cond: [{ $lt: ['$balance', 0] }, { $abs: '$balance' }, 0] } },
                },
            },
        ]),
    ]);
    ok(res, rows, { ...pageMeta(total, q), summary: { receivable: round2(sums[0]?.receivable ?? 0), payable: round2(sums[0]?.payable ?? 0) } });
});
router.get('/:id', requirePermission('parties.view'), async (req, res) => {
    const ctx = ctxOf(req);
    const party = await Party.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('group', 'name').lean();
    if (!party)
        throw AppError.notFound('Party');
    const stats = await Transaction.aggregate([
        { $match: { company: ctx.companyId, party: party._id, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: '$type', total: { $sum: '$total' }, balance: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]);
    ok(res, { ...party, stats });
});
router.post('/', requirePermission('parties.create'), validate(partySchema), async (req, res) => {
    const ctx = ctxOf(req);
    const body = req.body;
    await assertUniqueName(ctx.companyId, body.name);
    await assertGroup(ctx.companyId, body.group);
    const party = await Party.create({ ...toDoc(body), company: ctx.companyId, createdBy: ctx.userId });
    await recalcParties(ctx.companyId, [party._id]);
    await audit(ctx, 'create', 'Party', party._id, `Party ${party.name} created`);
    created(res, await Party.findById(party._id).lean());
});
async function updateParty(ctx, id, body) {
    const party = await Party.findOne({ _id: id, company: ctx.companyId });
    if (!party)
        throw AppError.notFound('Party');
    await assertUniqueName(ctx.companyId, body.name, party._id);
    await assertGroup(ctx.companyId, body.group);
    const before = party.toObject();
    party.set(toDoc(body));
    if (!body.group)
        party.set('group', undefined);
    await party.save();
    if (before.name !== party.name)
        await Transaction.updateMany({ company: ctx.companyId, party: party._id }, { $set: { partyName: party.name } });
    await recalcParties(ctx.companyId, [party._id]);
    await audit(ctx, 'update', 'Party', party._id, `Party ${party.name} updated`, before, party.toObject());
    return Party.findById(party._id).lean();
}
async function assertPartyDeletable(ctx, party) {
    const used = await Transaction.countDocuments({ company: ctx.companyId, party: party._id });
    if (used)
        throw AppError.badRequest(`${party.name} has ${used} transaction(s). Delete those first or mark the party inactive.`);
}
async function deleteParty(ctx, id) {
    const party = await Party.findOne({ _id: id, company: ctx.companyId });
    if (!party)
        throw AppError.notFound('Party');
    await assertPartyDeletable(ctx, party);
    await party.deleteOne();
    await audit(ctx, 'delete', 'Party', party._id, `Party ${party.name} deleted`, party.toObject());
}
registerApprovalHandler('party_update', { approve: (ctx, a) => updateParty(ctx, a.entityId, partySchema.parse(a.payload)) });
registerApprovalHandler('party_delete', { approve: (ctx, a) => deleteParty(ctx, a.entityId) });
router.put('/:id', requirePermission('parties.edit'), validate(partySchema), async (req, res) => {
    const ctx = ctxOf(req);
    const body = req.body;
    const party = await Party.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!party)
        throw AppError.notFound('Party');
    if (needsApproval(ctx, 'parties.edit')) {
        await assertUniqueName(ctx.companyId, body.name, party._id);
        await assertGroup(ctx.companyId, body.group);
        return queueForApproval(res, ctx, { kind: 'party_update', entity: 'Party', entityId: party._id, label: `Edit party ${party.name}`, payload: body, before: party.toObject() });
    }
    ok(res, await updateParty(ctx, party._id, body));
});
router.delete('/:id', requirePermission('parties.delete'), async (req, res) => {
    const ctx = ctxOf(req);
    const party = await Party.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!party)
        throw AppError.notFound('Party');
    if (needsApproval(ctx, 'parties.delete')) {
        await assertPartyDeletable(ctx, party);
        return queueForApproval(res, ctx, { kind: 'party_delete', entity: 'Party', entityId: party._id, label: `Delete party ${party.name}`, before: party.toObject() });
    }
    await deleteParty(ctx, party._id);
    ok(res, { deleted: true });
});
export default router;
//# sourceMappingURL=routes.js.map