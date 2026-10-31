import { Types } from 'mongoose';
import { can } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { round2 } from '../../core/http.js';
import { PAYMENT_ALLOCATES_TO, TXN_CONFIG } from '../../core/txn.js';
import { BankAccount, ExpenseCategory, Item, Party, Transaction, Unit } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { defaultCashAccount, recalcDocuments, recalcItems, recalcParties } from '../../services/ledger.js';
import { bumpCounterFor, nextNumber } from '../../services/numbering.js';
import { day } from '../finance/cheques.js';
const CONVERTIBLE_SOURCE_STATUS = ['ESTIMATE', 'PROFORMA', 'SALE_ORDER', 'DELIVERY_CHALLAN', 'PURCHASE_ORDER'];
export function assertCan(ctx, type, action) {
    if (!can(ctx, `${TXN_CONFIG[type].permission}.${action}`)) {
        throw AppError.forbidden(`You do not have permission to ${action} ${TXN_CONFIG[type].label.toLowerCase()}s`);
    }
}
export async function getTxnOrThrow(ctx, id) {
    if (!Types.ObjectId.isValid(String(id)))
        throw AppError.badRequest('Invalid transaction id');
    const doc = await Transaction.findOne({ _id: id, company: ctx.companyId });
    if (!doc)
        throw AppError.notFound('Transaction');
    return doc;
}
/** Pure money maths (exported for unit tests). */
export function computeLine(l) {
    const gross = l.qty * l.price;
    const discountAmount = l.discountPercent ? round2((gross * l.discountPercent) / 100) : round2(Math.min(l.discountAmount ?? 0, gross));
    const afterDiscount = gross - discountAmount;
    const rate = l.taxRate ?? 0;
    let taxable;
    let taxAmount;
    if (l.taxInclusive) {
        taxable = afterDiscount / (1 + rate / 100);
        taxAmount = afterDiscount - taxable;
    }
    else {
        taxable = afterDiscount;
        taxAmount = (taxable * rate) / 100;
    }
    return { discountAmount, taxAmount: round2(taxAmount), amount: round2(taxable + taxAmount), taxable: round2(taxable) };
}
export function computeTotals(lines, opts) {
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const itemDiscount = round2(lines.reduce((s, l) => s + l.discountAmount, 0));
    const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
    const discountAmount = opts.discountPercent ? round2((subtotal * opts.discountPercent) / 100) : round2(Math.min(opts.discountAmount ?? 0, subtotal));
    const charges = round2((opts.charges ?? []).reduce((s, c) => s + (c.amount || 0), 0));
    const pre = round2(subtotal - discountAmount + charges);
    const total = opts.roundOff ? Math.round(pre) : pre;
    return { subtotal, itemDiscount, taxTotal, discountAmount, total, roundOff: round2(total - pre) };
}
/* ------------------------------------------------------------------ */
/* Build a document from the request body                              */
/* ------------------------------------------------------------------ */
async function buildLines(ctx, type, body) {
    const itemIds = body.items.map((l) => l.item).filter(Boolean);
    const items = itemIds.length
        ? await Item.find({ _id: { $in: itemIds }, company: ctx.companyId }).populate('baseUnit secondaryUnit', 'shortName').lean()
        : [];
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const pickedUnitIds = [...new Set(body.items.map((l) => l.unit).filter(Boolean))];
    const pickedUnits = pickedUnitIds.length ? await Unit.find({ _id: { $in: pickedUnitIds }, company: ctx.companyId }, 'shortName').lean() : [];
    const unitById = new Map(pickedUnits.map((u) => [String(u._id), u]));
    // Only the item's own secondary unit converts; any other picked unit is just the label printed on the document
    const perBase = (item, unitId) => (item.secondaryUnit && String(item.secondaryUnit._id) === unitId ? item.conversionRate || 1 : 1);
    return body.items.map((l) => {
        const item = l.item ? byId.get(l.item) : undefined;
        if (l.item && !item)
            throw AppError.badRequest(`Item "${l.name}" no longer exists`);
        let baseQty = l.qty;
        let unitName;
        let unit;
        if (item) {
            const picked = l.unit ? unitById.get(l.unit) : undefined;
            if (picked) {
                unit = picked._id;
                unitName = picked.shortName;
                baseQty = l.qty / perBase(item, l.unit);
            }
            else {
                unit = item.baseUnit?._id ?? undefined;
                unitName = item.baseUnit?.shortName;
            }
            if (item.type === 'service')
                baseQty = 0;
        }
        else if (l.unit && unitById.has(l.unit)) {
            unit = unitById.get(l.unit)._id;
            unitName = unitById.get(l.unit).shortName;
        }
        const m = computeLine(l);
        return {
            item: item?._id,
            name: l.name,
            hsn: l.hsn ?? item?.hsn ?? undefined,
            description: l.description,
            qty: l.qty,
            unit,
            unitName,
            baseQty: round2(baseQty * 1000) / 1000,
            price: l.price,
            discountPercent: l.discountPercent,
            discountAmount: m.discountAmount,
            taxRate: l.taxRate,
            taxInclusive: l.taxInclusive,
            taxAmount: m.taxAmount,
            amount: m.amount,
            costPrice: TXN_CONFIG[type].side === 'purchase' && baseQty ? round2((m.amount - m.taxAmount) / baseQty) : (item?.purchasePrice ?? 0),
        };
    });
}
async function resolveAccount(ctx, id) {
    if (id) {
        const acc = await BankAccount.findOne({ _id: id, company: ctx.companyId }).lean();
        if (!acc)
            throw AppError.badRequest('Payment account not found');
        return acc;
    }
    return (await defaultCashAccount(ctx.companyId)).toObject();
}
/** Assembles the full document (all derived money fields) from a validated body. */
async function buildDoc(ctx, body, existing) {
    const type = body.type;
    const cfg = TXN_CONFIG[type];
    const doc = {
        type,
        date: body.date,
        dueDate: body.dueDate,
        stateOfSupply: body.stateOfSupply,
        refNo: body.refNo,
        description: body.description,
        terms: body.terms,
        attachments: body.attachments,
        docFiles: body.docFiles,
        template: body.template,
        paymentRef: body.paymentRef,
        additionalCharges: body.additionalCharges,
        discountPercent: body.discountPercent,
    };
    // Party
    if (body.party) {
        const party = await Party.findOne({ _id: body.party, company: ctx.companyId }).lean();
        if (!party)
            throw AppError.badRequest('Party not found');
        Object.assign(doc, {
            party: party._id,
            partyName: party.name,
            phone: body.phone ?? party.phone,
            billingAddress: body.billingAddress ?? party.billingAddress,
            shippingAddress: body.shippingAddress ?? party.shippingAddress,
            stateOfSupply: body.stateOfSupply ?? (ctx.settings.transaction.stateOfSupply ? party.state : undefined),
        });
    }
    else {
        if (cfg.isPayment)
            throw AppError.badRequest('Select a party for this payment');
        Object.assign(doc, { party: undefined, partyName: body.partyName ?? (type === 'EXPENSE' ? undefined : 'Cash'), phone: body.phone, billingAddress: body.billingAddress, shippingAddress: body.shippingAddress });
    }
    if (type === 'EXPENSE') {
        if (!body.expenseCategory)
            throw AppError.badRequest('Select an expense category');
        const cat = await ExpenseCategory.exists({ _id: body.expenseCategory, company: ctx.companyId });
        if (!cat)
            throw AppError.badRequest('Expense category not found');
        doc.expenseCategory = body.expenseCategory;
    }
    if (cfg.isPayment) {
        const amount = round2(body.amount ?? 0);
        if (amount <= 0)
            throw AppError.badRequest('Enter the payment amount');
        Object.assign(doc, { items: [], subtotal: amount, itemDiscount: 0, taxTotal: 0, discountAmount: 0, roundOff: 0, total: amount, settled: amount });
    }
    else {
        if (cfg.hasItems && type !== 'EXPENSE' && body.items.length === 0)
            throw AppError.badRequest('Add at least one item');
        const lines = await buildLines(ctx, type, body);
        const roundOff = body.roundOff ?? ctx.settings.transaction.roundOff;
        const totals = lines.length === 0 && type === 'EXPENSE'
            ? { subtotal: round2(body.amount ?? 0), itemDiscount: 0, taxTotal: 0, discountAmount: 0, total: round2(body.amount ?? 0), roundOff: 0 }
            : computeTotals(lines, { discountPercent: body.discountPercent, discountAmount: body.discountAmount, charges: body.additionalCharges, roundOff });
        if (totals.total < 0)
            throw AppError.badRequest('Total cannot be negative');
        if (type === 'EXPENSE' && totals.total <= 0)
            throw AppError.badRequest('Enter the expense amount');
        const settled = cfg.settles ? round2(body.settled) : 0;
        if (settled > totals.total + 0.001)
            throw AppError.badRequest(`${cfg.side === 'sale' ? 'Received' : 'Paid'} amount cannot be more than the total`);
        // Same rule as the form: only a cash sale or cash purchase goes without a party, and it is settled in full,
        // otherwise its balance would belong to nobody
        if (!body.party && type !== 'EXPENSE') {
            if (type !== 'SALE' && type !== 'PURCHASE')
                throw AppError.badRequest(`Select a ${cfg.side === 'sale' ? 'customer' : 'supplier'}`);
            if (settled < totals.total - 0.001)
                throw AppError.badRequest(type === 'SALE' ? 'Receive the full amount for a cash sale, or select a customer to sell on credit' : 'Pay the full amount for a cash purchase, or select a supplier to buy on credit');
        }
        Object.assign(doc, { items: lines, ...totals, settled });
    }
    if (cfg.settles && doc.settled > 0 && body.paymentMode === 'cheque') {
        // Counts against the party now; reaches cash or bank when the cheque is deposited or withdrawn
        doc.paymentAccount = undefined;
        doc.paymentType = 'Cheque';
        if (!existing?.cheque?.status)
            doc.cheque = { status: 'OPEN' };
    }
    else if (cfg.settles && doc.settled > 0) {
        const acc = await resolveAccount(ctx, body.paymentAccount);
        doc.paymentAccount = acc._id;
        doc.paymentType = acc.name;
        doc.cheque = undefined;
    }
    else {
        doc.paymentAccount = undefined;
        doc.paymentType = cfg.settles ? 'Credit' : undefined;
        doc.cheque = undefined;
    }
    // Initial status (payment statuses are finalised by recalcDocuments)
    if (!existing)
        doc.status = cfg.settles ? 'UNPAID' : 'OPEN';
    return doc;
}
/** A cleared cheque has moved money through an account; the document's payment must not change under it. */
function assertChequeOpen(doc, action) {
    if (doc.cheque?.status !== 'CLOSED')
        return;
    const cfg = TXN_CONFIG[doc.type];
    const cleared = `${cfg.cash > 0 ? 'deposited' : 'withdrawn'} on ${doc.cheque.closedOn ? day(doc.cheque.closedOn) : 'an earlier date'}`;
    throw AppError.badRequest(`The cheque on ${cfg.label} ${doc.number} was ${cleared}. Reopen it in Cash & Bank ▸ Cheques before you ${action}.`);
}
/* ------------------------------------------------------------------ */
/* Stock guard                                                         */
/* ------------------------------------------------------------------ */
async function guardNegativeStock(ctx, type, lines, existing) {
    if (ctx.settings.transaction.allowNegativeStock || TXN_CONFIG[type].stock !== -1)
        return;
    const need = new Map();
    for (const l of lines)
        if (l.item)
            need.set(String(l.item), (need.get(String(l.item)) ?? 0) + l.baseQty);
    if (existing && existing.status !== 'CANCELLED' && TXN_CONFIG[existing.type].stock === -1) {
        for (const l of existing.items)
            if (l.item)
                need.set(String(l.item), (need.get(String(l.item)) ?? 0) - (l.baseQty ?? 0));
    }
    const items = await Item.find({ _id: { $in: [...need.keys()] }, company: ctx.companyId, type: 'product' }).select('name stock').lean();
    for (const it of items) {
        const req = need.get(String(it._id)) ?? 0;
        if (req > 0 && it.stock - req < -0.0001)
            throw AppError.badRequest(`Not enough stock for "${it.name}" (available ${it.stock})`);
    }
}
/* ------------------------------------------------------------------ */
/* Payment allocation                                                   */
/* ------------------------------------------------------------------ */
async function buildAllocations(ctx, type, partyId, total, body, paymentId) {
    const target = PAYMENT_ALLOCATES_TO[type];
    if (!target)
        return [];
    const candidates = await Transaction.find({ company: ctx.companyId, type: target, party: partyId, status: { $ne: 'CANCELLED' } })
        .sort({ date: 1, createdAt: 1 })
        .select('number total settled paidViaPayments date')
        .lean();
    // Amount this payment already contributed to each invoice (when editing)
    const own = new Map();
    if (paymentId) {
        const prev = await Transaction.findById(paymentId).select('allocations').lean();
        for (const a of prev?.allocations ?? [])
            own.set(String(a.transaction), (own.get(String(a.transaction)) ?? 0) + a.amount);
    }
    const outstanding = new Map(candidates.map((c) => [String(c._id), round2(c.total - c.settled - (c.paidViaPayments ?? 0) + (own.get(String(c._id)) ?? 0))]));
    const numbers = new Map(candidates.map((c) => [String(c._id), c.number]));
    const result = [];
    let remaining = total;
    for (const a of body.allocations ?? []) {
        const out = outstanding.get(a.transaction);
        if (out === undefined)
            throw AppError.badRequest(`Linked ${TXN_CONFIG[target].label.toLowerCase()} not found for this party`);
        const amount = round2(Math.min(a.amount, out, remaining));
        if (amount <= 0)
            continue;
        result.push({ transaction: new Types.ObjectId(a.transaction), number: numbers.get(a.transaction), amount });
        outstanding.set(a.transaction, round2(out - amount));
        remaining = round2(remaining - amount);
    }
    if (body.autoAllocate && remaining > 0) {
        for (const c of candidates) {
            const out = outstanding.get(String(c._id)) ?? 0;
            if (out <= 0 || remaining <= 0)
                continue;
            const amount = round2(Math.min(out, remaining));
            const existing = result.find((r) => String(r.transaction) === String(c._id));
            if (existing)
                existing.amount = round2(existing.amount + amount);
            else
                result.push({ transaction: c._id, number: c.number, amount });
            remaining = round2(remaining - amount);
        }
    }
    return result;
}
/** When an invoice shrinks below what payments cover, trims the most recent allocations. */
async function trimOverAllocation(ctx, invoice) {
    const capacity = round2(invoice.total - invoice.settled);
    const payments = await Transaction.find({ company: ctx.companyId, 'allocations.transaction': invoice._id }).sort({ date: -1, createdAt: -1 });
    let covered = round2(payments.reduce((s, p) => s + p.allocations.filter((a) => String(a.transaction) === String(invoice._id)).reduce((x, a) => x + a.amount, 0), 0));
    const touched = [];
    for (const p of payments) {
        if (covered <= capacity)
            break;
        const alloc = p.allocations.find((a) => String(a.transaction) === String(invoice._id));
        if (!alloc)
            continue;
        const reduceBy = Math.min(alloc.amount, round2(covered - capacity));
        alloc.amount = round2(alloc.amount - reduceBy);
        covered = round2(covered - reduceBy);
        if (alloc.amount <= 0)
            p.set('allocations', p.allocations.filter((x) => String(x.transaction) !== String(invoice._id)));
        await p.save();
        touched.push(p._id);
    }
    return touched;
}
async function unlinkPayments(ctx, docId) {
    const payments = await Transaction.find({ company: ctx.companyId, 'allocations.transaction': docId }).select('_id').lean();
    if (payments.length)
        await Transaction.updateMany({ company: ctx.companyId, 'allocations.transaction': docId }, { $pull: { allocations: { transaction: docId } } });
    return payments.map((p) => p._id);
}
/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */
async function settle(ctx, opts) {
    await recalcDocuments(ctx.companyId, (opts.docs ?? []));
    await Promise.all([
        recalcParties(ctx.companyId, (opts.parties ?? [])),
        recalcItems(ctx.companyId, (opts.items ?? [])),
    ]);
}
const itemIdsOf = (d) => (d?.items ?? []).map((l) => l.item).filter(Boolean);
export async function createTxn(ctx, body) {
    const type = body.type;
    const cfg = TXN_CONFIG[type];
    assertCan(ctx, type, 'create');
    const data = await buildDoc(ctx, body);
    await guardNegativeStock(ctx, type, data.items);
    // Source (conversion)
    let source = null;
    if (body.sourceId) {
        source = await getTxnOrThrow(ctx, body.sourceId);
        if (!TXN_CONFIG[source.type].convertsTo.includes(type))
            throw AppError.badRequest(`A ${TXN_CONFIG[source.type].label} cannot be converted to a ${cfg.label}`);
        if (source.status === 'CANCELLED')
            throw AppError.badRequest('Cannot convert a cancelled document');
        data.source = { transaction: source._id, type: source.type, number: source.number };
    }
    // Number
    let number = body.number?.trim();
    if (number) {
        const taken = await Transaction.exists({ company: ctx.companyId, type, number });
        if (taken) {
            if (!body.autoNumber)
                throw AppError.conflict(`${cfg.label} number ${number} is already used`);
            number = await nextNumber(ctx.companyId, type, ctx.settings);
        }
        else {
            await bumpCounterFor(ctx.companyId, type, number, ctx.settings);
        }
    }
    else {
        number = await nextNumber(ctx.companyId, type, ctx.settings);
    }
    const doc = new Transaction({ ...data, company: ctx.companyId, number, createdBy: ctx.userId, updatedBy: ctx.userId });
    if (cfg.isPayment)
        doc.set('allocations', await buildAllocations(ctx, type, doc.party, doc.total, body));
    await doc.save();
    if (source) {
        source.links.push({ transaction: doc._id, type: doc.type, number: doc.number });
        if (CONVERTIBLE_SOURCE_STATUS.includes(source.type))
            source.status = 'CONVERTED';
        source.updatedBy = ctx.userId;
        await source.save();
        await audit(ctx, 'convert', 'Transaction', source._id, `${TXN_CONFIG[source.type].label} ${source.number} converted to ${cfg.label} ${doc.number}`);
    }
    await settle(ctx, { parties: [doc.party], items: itemIdsOf(doc), docs: [doc._id, ...doc.allocations.map((a) => a.transaction)] });
    const fresh = await Transaction.findById(doc._id).lean();
    await audit(ctx, 'create', 'Transaction', doc._id, `${cfg.label} ${doc.number} created${doc.partyName ? ` for ${doc.partyName}` : ''}`, undefined, fresh);
    return fresh;
}
export async function updateTxn(ctx, id, body) {
    const doc = await getTxnOrThrow(ctx, id);
    const type = doc.type;
    const cfg = TXN_CONFIG[type];
    assertCan(ctx, type, 'edit');
    if (body.type !== type)
        throw AppError.badRequest('Document type cannot be changed');
    if (doc.status === 'CANCELLED')
        throw AppError.badRequest('A cancelled document cannot be edited');
    const before = doc.toObject();
    const data = await buildDoc(ctx, body, doc);
    if (doc.cheque?.status === 'CLOSED') {
        const amount = (d) => round2(Number(cfg.isPayment ? d.total : d.settled) || 0);
        if (data.paymentType !== 'Cheque' || amount(data) !== amount(doc))
            assertChequeOpen(doc, 'change its amount or payment type');
    }
    await guardNegativeStock(ctx, type, data.items, doc);
    const number = body.number?.trim();
    if (number && number !== doc.number) {
        if (await Transaction.exists({ company: ctx.companyId, type, number, _id: { $ne: doc._id } }))
            throw AppError.conflict(`${cfg.label} number ${number} is already used`);
        data.number = number;
        await bumpCounterFor(ctx.companyId, type, number, ctx.settings);
    }
    delete data.status;
    const oldAllocs = doc.allocations.map((a) => a.transaction);
    doc.set({ ...data, updatedBy: ctx.userId });
    if (cfg.isPayment) {
        if (String(before.party) !== String(doc.party))
            doc.set('allocations', []);
        doc.set('allocations', await buildAllocations(ctx, type, doc.party, doc.total, body, doc._id));
    }
    await doc.save();
    let trimmed = [];
    if (cfg.allocatable) {
        if (String(before.party) !== String(doc.party))
            trimmed = await unlinkPayments(ctx, doc._id);
        else
            trimmed = await trimOverAllocation(ctx, doc);
    }
    // Keep link labels in sync when a number changes
    if (data.number) {
        await Transaction.updateMany({ company: ctx.companyId, 'links.transaction': doc._id }, { $set: { 'links.$.number': doc.number } });
        await Transaction.updateMany({ company: ctx.companyId, 'source.transaction': doc._id }, { $set: { 'source.number': doc.number } });
        await Transaction.updateMany({ company: ctx.companyId, 'allocations.transaction': doc._id }, { $set: { 'allocations.$.number': doc.number } });
    }
    await settle(ctx, {
        parties: [before.party, doc.party],
        items: [...itemIdsOf(before), ...itemIdsOf(doc)],
        docs: [doc._id, ...oldAllocs, ...doc.allocations.map((a) => a.transaction), ...trimmed],
    });
    const fresh = await Transaction.findById(doc._id).lean();
    await audit(ctx, 'update', 'Transaction', doc._id, `${cfg.label} ${doc.number} updated`, before, fresh);
    return fresh;
}
export async function cancelTxn(ctx, id, reason) {
    const doc = await getTxnOrThrow(ctx, id);
    const type = doc.type;
    const cfg = TXN_CONFIG[type];
    assertCan(ctx, type, 'edit');
    if (!cfg.cancellable)
        throw AppError.badRequest(`A ${cfg.label} cannot be cancelled`);
    if (doc.status === 'CANCELLED')
        throw AppError.badRequest('Already cancelled');
    assertChequeOpen(doc, 'cancel it');
    const before = doc.toObject();
    const unlinked = cfg.allocatable ? await unlinkPayments(ctx, doc._id) : [];
    doc.status = 'CANCELLED';
    doc.cancelledAt = new Date();
    doc.cancelReason = reason;
    doc.balance = 0;
    doc.updatedBy = ctx.userId;
    await doc.save();
    await settle(ctx, { parties: [doc.party], items: itemIdsOf(doc), docs: unlinked });
    await audit(ctx, 'cancel', 'Transaction', doc._id, `${cfg.label} ${doc.number} cancelled${reason ? `: ${reason}` : ''}`, before, doc.toObject());
    return doc.toObject();
}
export async function deleteTxn(ctx, id) {
    const doc = await getTxnOrThrow(ctx, id);
    const type = doc.type;
    const cfg = TXN_CONFIG[type];
    assertCan(ctx, type, 'delete');
    assertChequeOpen(doc, 'delete it');
    const before = doc.toObject();
    const unlinked = cfg.allocatable ? await unlinkPayments(ctx, doc._id) : [];
    const allocated = doc.allocations.map((a) => a.transaction);
    // Detach from the source document; reopen it if nothing else links to it
    if (doc.source?.transaction) {
        const src = await Transaction.findOne({ _id: doc.source.transaction, company: ctx.companyId });
        if (src) {
            src.set('links', src.links.filter((l) => String(l.transaction) !== String(doc._id)));
            if (src.links.length === 0 && src.status === 'CONVERTED')
                src.status = 'OPEN';
            await src.save();
        }
    }
    await doc.deleteOne();
    await settle(ctx, { parties: [doc.party], items: itemIdsOf(doc), docs: [...allocated, ...unlinked] });
    await audit(ctx, 'delete', 'Transaction', doc._id, `${cfg.label} ${doc.number} deleted`, before);
    return { deleted: true };
}
export async function addConfirmation(ctx, id, input) {
    const doc = await getTxnOrThrow(ctx, id);
    assertCan(ctx, doc.type, 'edit');
    doc.confirmations.push({ file: new Types.ObjectId(input.file), kind: input.kind, note: input.note, uploadedBy: ctx.userId, uploadedAt: new Date() });
    if (input.kind === 'confirmed_challan')
        doc.deliveryStatus = 'confirmed';
    await doc.save();
    await audit(ctx, 'upload', 'Transaction', doc._id, `${input.kind === 'bill_challan' ? 'Bill challan' : 'Confirmed challan'} uploaded for ${doc.number}`);
    return doc.toObject();
}
export async function removeConfirmation(ctx, id, confirmationId) {
    const doc = await getTxnOrThrow(ctx, id);
    assertCan(ctx, doc.type, 'edit');
    doc.confirmations.pull({ _id: confirmationId });
    if (!doc.confirmations.some((c) => c.kind === 'confirmed_challan') && doc.deliveryStatus === 'confirmed')
        doc.deliveryStatus = 'delivered';
    await doc.save();
    await audit(ctx, 'delete', 'Transaction', doc._id, `Confirmation document removed from ${doc.number}`);
    return doc.toObject();
}
//# sourceMappingURL=service.js.map