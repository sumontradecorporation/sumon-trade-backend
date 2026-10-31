import { AppError } from '../../core/errors.js';
import { round2 } from '../../core/http.js';
import { TXN_CONFIG } from '../../core/txn.js';
import { BankAccount, BankEntry, Transaction } from '../../models/index.js';
import { audit } from '../../services/audit.js';
/** Business dates are stored as UTC midnight; this prints them as the user picked them. */
export const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** Money a cheque moves: the payment amount, or what was received / paid on an invoice or bill. */
export const chequeAmount = (t) => round2(TXN_CONFIG[t.type].isPayment ? t.total : t.settled);
/** Deposit a received cheque into an account, or withdraw an issued one from it. */
export async function closeCheque(ctx, id, input) {
    const current = await Transaction.findOne({ _id: id, company: ctx.companyId, 'cheque.status': { $in: ['OPEN', 'CLOSED'] } }).select('type number date status cheque').lean();
    if (!current)
        throw AppError.notFound('Cheque');
    if (current.status === 'CANCELLED')
        throw AppError.badRequest('This document is cancelled');
    if (current.cheque?.status === 'CLOSED')
        throw AppError.conflict('This cheque has already cleared');
    const acc = await BankAccount.findOne({ _id: input.account, company: ctx.companyId }).lean();
    if (!acc)
        throw AppError.badRequest('Account not found');
    // Compared by calendar day: business dates are UTC midnight, but a document saved through the API without a date carries the time too
    if (input.date.toISOString().slice(0, 10) < new Date(current.date).toISOString().slice(0, 10))
        throw AppError.badRequest(`The cheque is dated ${day(current.date)}. It cannot clear before that.`);
    // Claim the cheque first so two clicks cannot clear it twice
    const t = await Transaction.findOneAndUpdate({ _id: current._id, company: ctx.companyId, status: { $ne: 'CANCELLED' }, 'cheque.status': 'OPEN' }, { $set: { 'cheque.status': 'CLOSED', 'cheque.account': acc._id, 'cheque.closedOn': input.date, 'cheque.closedBy': ctx.userId } }, { returnDocument: 'after' });
    if (!t)
        throw AppError.conflict('This cheque has already cleared');
    const cfg = TXN_CONFIG[t.type];
    const incoming = cfg.cash > 0;
    const amount = chequeAmount(t);
    try {
        const entry = await BankEntry.create({ company: ctx.companyId, kind: incoming ? 'add' : 'reduce', account: acc._id, amount, date: input.date, description: input.description, cheque: t._id, createdBy: ctx.userId });
        await Transaction.updateOne({ _id: t._id }, { $set: { 'cheque.entry': entry._id } });
    }
    catch (err) {
        await Transaction.updateOne({ _id: t._id }, { $set: { cheque: { status: 'OPEN' } } });
        throw err;
    }
    await audit(ctx, 'update', 'Transaction', t._id, `Cheque${t.paymentRef ? ` ${t.paymentRef}` : ''} of ${amount} on ${cfg.label} ${t.number} ${incoming ? 'deposited into' : 'withdrawn from'} ${acc.name}`);
    return { _id: t._id, status: 'CLOSED', account: { _id: acc._id, name: acc.name }, closedOn: input.date };
}
/** Undo a deposit or withdrawal: the money leaves (or returns to) the account and the cheque is open again. */
export async function reopenCheque(ctx, id) {
    const t = await Transaction.findOneAndUpdate({ _id: id, company: ctx.companyId, 'cheque.status': 'CLOSED' }, { $set: { cheque: { status: 'OPEN' } } });
    if (!t)
        throw AppError.notFound('Cleared cheque');
    await BankEntry.deleteMany({ company: ctx.companyId, cheque: t._id });
    await audit(ctx, 'update', 'Transaction', t._id, `Cheque${t.paymentRef ? ` ${t.paymentRef}` : ''} on ${TXN_CONFIG[t.type].label} ${t.number} reopened`);
    return { _id: t._id, status: 'OPEN' };
}
//# sourceMappingURL=cheques.js.map