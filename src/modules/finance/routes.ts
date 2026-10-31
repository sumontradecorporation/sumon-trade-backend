import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, dateRange, ok, oid, round2, searchRegex, str } from '../../core/http.js';
import { TXN_CONFIG, TXN_TYPES, type TxnType } from '../../core/txn.js';
import { objectId, optDate, optStr, optionalId } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { BankAccount, BankEntry, ExpenseCategory, LoanAccount, LoanEntry, Transaction } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { accountBalances, accountStatement, cashEffectExpr, loanBalances, loanStatementRows } from '../../services/ledger.js';
import { chequeAmount, closeCheque, day, reopenCheque } from './cheques.js';

const router = Router();

/* ---------------- Cash & bank accounts ---------------- */

/** Light list for payment-type dropdowns (any user who can create documents needs it). */
router.get('/accounts/options', async (req, res) => {
  const ctx = ctxOf(req);
  ok(res, await BankAccount.find({ company: ctx.companyId }).select('name kind isDefault').sort({ isDefault: -1, kind: 1, name: 1 }).lean());
});

router.get('/accounts', requirePermission('cash_bank.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const accounts = await accountBalances(ctx.companyId);
  ok(res, accounts, {
    summary: {
      cash: round2(accounts.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0)),
      bank: round2(accounts.filter((a) => a.kind !== 'cash').reduce((s, a) => s + a.balance, 0)),
    },
  });
});

const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['cash', 'bank', 'wallet']).default('bank'),
  bankName: optStr,
  accountNumber: optStr,
  ifsc: optStr,
  holderName: optStr,
  upiId: optStr,
  openingBalance: z.coerce.number().default(0),
  openingDate: optDate,
  printOnInvoice: z.boolean().default(false),
});

router.post('/accounts', requirePermission('cash_bank.manage'), validate(accountSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const acc = await BankAccount.create({ ...req.body, company: ctx.companyId, openingDate: req.body.openingDate ?? new Date() });
  await audit(ctx, 'create', 'BankAccount', acc._id, `Account ${acc.name} created`);
  created(res, acc.toObject());
});

router.put('/accounts/:id', requirePermission('cash_bank.manage'), validate(accountSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const acc = await BankAccount.findOne({ _id: oid(req.params.id), company: ctx.companyId });
  if (!acc) throw AppError.notFound('Account');
  const before = acc.toObject();
  acc.set({ ...req.body, kind: acc.isDefault ? 'cash' : req.body.kind });
  await acc.save();
  if (before.name !== acc.name) await Transaction.updateMany({ company: ctx.companyId, paymentAccount: acc._id }, { $set: { paymentType: acc.name } });
  await audit(ctx, 'update', 'BankAccount', acc._id, `Account ${acc.name} updated`, before, acc.toObject());
  ok(res, acc.toObject());
});

router.delete('/accounts/:id', requirePermission('cash_bank.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const acc = await BankAccount.findOne({ _id: oid(req.params.id), company: ctx.companyId });
  if (!acc) throw AppError.notFound('Account');
  if (acc.isDefault) throw AppError.badRequest('The default cash account cannot be deleted');
  const counts = await Promise.all([
    Transaction.countDocuments({ company: ctx.companyId, $or: [{ paymentAccount: acc._id }, { 'cheque.account': acc._id }] }),
    BankEntry.countDocuments({ company: ctx.companyId, $or: [{ account: acc._id }, { toAccount: acc._id }] }),
    LoanAccount.countDocuments({ company: ctx.companyId, $or: [{ receivedIn: acc._id }, { feePaidFrom: acc._id }] }),
    LoanEntry.countDocuments({ company: ctx.companyId, account: acc._id }),
  ]);
  const used = counts.reduce((a, b) => a + b, 0);
  if (used) throw AppError.badRequest(`This account has ${used} transaction${used === 1 ? '' : 's'} and cannot be deleted`);
  await acc.deleteOne();
  await audit(ctx, 'delete', 'BankAccount', acc._id, `Account ${acc.name} deleted`);
  ok(res, { deleted: true });
});

/** Statement: opening + every movement with running balance (newest first) */
router.get('/accounts/:id/statement', requirePermission('cash_bank.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const acc = await BankAccount.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!acc) throw AppError.notFound('Account');
  const st = await accountStatement(ctx.companyId, [acc._id], dateRange(req.query.from, req.query.to));
  ok(res, { account: acc, ...st, rows: st.rows.reverse() });
});

const entrySchema = z
  .object({
    kind: z.enum(['add', 'reduce', 'transfer']),
    account: objectId,
    toAccount: optionalId,
    amount: z.coerce.number().positive('Amount must be greater than 0'),
    date: z.coerce.date().default(() => new Date()),
    description: optStr,
  })
  .refine((v) => v.kind !== 'transfer' || (v.toAccount && v.toAccount !== v.account), { message: 'Choose a different destination account', path: ['toAccount'] });

router.post('/entries', requirePermission('cash_bank.manage'), validate(entrySchema), async (req, res) => {
  const ctx = ctxOf(req);
  const ids = [req.body.account, req.body.toAccount].filter(Boolean);
  const n = await BankAccount.countDocuments({ company: ctx.companyId, _id: { $in: ids } });
  if (n !== ids.length) throw AppError.badRequest('Account not found');
  const e = await BankEntry.create({ ...req.body, company: ctx.companyId, createdBy: ctx.userId });
  await audit(ctx, 'create', 'BankEntry', e._id, `Cash/bank ${e.kind} of ${e.amount}`);
  created(res, e.toObject());
});

router.delete('/entries/:id', requirePermission('cash_bank.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const found = await BankEntry.findOne({ _id: oid(req.params.id), company: ctx.companyId }).select('cheque').lean();
  if (!found) throw AppError.notFound('Entry');
  if (found.cheque) throw AppError.badRequest('This is a cheque being cleared. Reopen the cheque in Cash & Bank ▸ Cheques to undo it.');
  const e = await BankEntry.findOneAndDelete({ _id: found._id, company: ctx.companyId }).lean();
  if (!e) throw AppError.notFound('Entry');
  await audit(ctx, 'delete', 'BankEntry', e._id, `Cash/bank ${e.kind} of ${e.amount} deleted`);
  ok(res, { deleted: true });
});

/* ---------------- Cheques ---------------- */

const IN_TYPES = TXN_TYPES.filter((t) => TXN_CONFIG[t].cash > 0);
const OUT_TYPES = TXN_TYPES.filter((t) => TXN_CONFIG[t].cash < 0);

/** Cheques received and issued: open ones still have to be deposited or withdrawn; closed ones have cleared. */
router.get('/cheques', requirePermission('cash_bank.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const status = str(req.query.status);
  const direction = str(req.query.direction);
  const filter: Record<string, unknown> = {
    company: ctx.companyId,
    status: { $ne: 'CANCELLED' },
    'cheque.status': status === 'open' ? 'OPEN' : status === 'closed' ? 'CLOSED' : { $in: ['OPEN', 'CLOSED'] },
  };
  if (direction === 'in') filter.type = { $in: IN_TYPES };
  if (direction === 'out') filter.type = { $in: OUT_TYPES };
  const rx = searchRegex(req.query.q);
  if (rx) filter.$or = [{ number: rx }, { partyName: rx }, { paymentRef: rx }];
  const [docs, open] = await Promise.all([
    Transaction.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(2000)
      .select('type number date partyName party total settled paymentRef cheque')
      .populate<{ cheque: { status: 'OPEN' | 'CLOSED'; account?: { _id: string; name: string } | null; closedOn?: Date } }>('cheque.account', 'name')
      .lean(),
    Transaction.aggregate<{ _id: boolean; total: number; count: number }>([
      { $match: { company: ctx.companyId, status: { $ne: 'CANCELLED' }, 'cheque.status': 'OPEN' } },
      { $project: { amount: cashEffectExpr } },
      { $group: { _id: { $gt: ['$amount', 0] }, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
    ]),
  ]);
  const sum = (incoming: boolean) => open.find((o) => o._id === incoming) ?? { total: 0, count: 0 };
  ok(
    res,
    docs.map((d) => ({
      _id: d._id, type: d.type, number: d.number, date: d.date, partyName: d.partyName, party: d.party, chequeNo: d.paymentRef ?? '',
      amount: chequeAmount(d), direction: TXN_CONFIG[d.type as TxnType].cash > 0 ? 'in' : 'out',
      status: d.cheque.status, account: d.cheque.account ?? null, closedOn: d.cheque.closedOn ?? null,
    })),
    { summary: { received: { total: round2(sum(true).total), count: sum(true).count }, issued: { total: round2(sum(false).total), count: sum(false).count } } },
  );
});

const chequeCloseSchema = z.object({ account: objectId, date: z.coerce.date(), description: optStr });

/** Deposit a received cheque into an account, or withdraw an issued one from it. */
router.post('/cheques/:id/close', requirePermission('cash_bank.manage'), validate(chequeCloseSchema), async (req, res) => {
  ok(res, await closeCheque(ctxOf(req), oid(req.params.id), req.body));
});

/** Undo a deposit or withdrawal: the money leaves the account again and the cheque is open. */
router.post('/cheques/:id/reopen', requirePermission('cash_bank.manage'), async (req, res) => {
  ok(res, await reopenCheque(ctxOf(req), oid(req.params.id)));
});

/* ---------------- Loan accounts ---------------- */

const loanSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name for the loan').max(80),
    lender: optStr,
    accountNumber: optStr,
    description: optStr,
    interestRate: z.coerce.number().min(0).max(100).default(0),
    termMonths: z.coerce.number().int().min(0).max(600).default(0),
    openingBalance: z.coerce.number().positive('Enter the loan amount'),
    openingDate: z.coerce.date(),
    receivedIn: optionalId,
    processingFee: z.coerce.number().min(0).default(0),
    feePaidFrom: optionalId,
  })
  .refine((v) => !v.processingFee || v.feePaidFrom, { message: 'Choose the account the processing fee was paid from', path: ['feePaidFrom'] });

async function assertAccounts(ctx: ReturnType<typeof ctxOf>, ids: (string | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  if (list.length && (await BankAccount.countDocuments({ company: ctx.companyId, _id: { $in: list } })) !== list.length) throw AppError.badRequest('Account not found');
}

/** Loans with what is still owed. */
router.get('/loans', requirePermission('cash_bank.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const [loans, accounts] = await Promise.all([loanBalances(ctx.companyId), BankAccount.find({ company: ctx.companyId }).select('name').lean()]);
  const names = new Map(accounts.map((a) => [String(a._id), a.name]));
  const named = (id: unknown) => (id ? { _id: String(id), name: names.get(String(id)) ?? '' } : null);
  ok(
    res,
    loans.map((l) => ({ ...l, receivedIn: named(l.receivedIn), feePaidFrom: named(l.feePaidFrom) })),
    { summary: { outstanding: round2(loans.reduce((s, l) => s + l.balance, 0)), interestPaid: round2(loans.reduce((s, l) => s + l.interestPaid, 0)) } },
  );
});

router.post('/loans', requirePermission('cash_bank.manage'), validate(loanSchema), async (req, res) => {
  const ctx = ctxOf(req);
  await assertAccounts(ctx, [req.body.receivedIn, req.body.feePaidFrom]);
  if (await LoanAccount.exists({ company: ctx.companyId, name: req.body.name })) throw AppError.conflict(`A loan named ${req.body.name} already exists`);
  const loan = await LoanAccount.create({ ...req.body, feePaidFrom: req.body.processingFee ? req.body.feePaidFrom : undefined, company: ctx.companyId, createdBy: ctx.userId });
  await audit(ctx, 'create', 'LoanAccount', loan._id, `Loan ${loan.name} of ${loan.openingBalance} added`);
  created(res, loan.toObject());
});

router.put('/loans/:id', requirePermission('cash_bank.manage'), validate(loanSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const loan = await LoanAccount.findOne({ _id: oid(req.params.id), company: ctx.companyId });
  if (!loan) throw AppError.notFound('Loan');
  await assertAccounts(ctx, [req.body.receivedIn, req.body.feePaidFrom]);
  if (await LoanAccount.exists({ company: ctx.companyId, name: req.body.name, _id: { $ne: loan._id } })) throw AppError.conflict(`A loan named ${req.body.name} already exists`);
  const first = await LoanEntry.findOne({ company: ctx.companyId, loan: loan._id }).sort({ date: 1 }).select('date').lean();
  if (first && first.date < req.body.openingDate) throw AppError.badRequest(`This loan has entries from ${day(first.date)}. The loan cannot start after that.`);
  const [paid] = await LoanEntry.aggregate<{ principal: number; increase: number }>([
    { $match: { company: ctx.companyId, loan: loan._id } },
    { $group: { _id: null, principal: { $sum: '$principal' }, increase: { $sum: { $cond: [{ $eq: ['$kind', 'increase'] }, '$amount', 0] } } } },
  ]);
  if (paid && req.body.openingBalance + paid.increase < paid.principal - 0.001) throw AppError.badRequest(`৳${round2(paid.principal).toLocaleString('en-IN')} of principal is already repaid, which is more than this loan amount`);
  const before = loan.toObject();
  loan.set({ ...req.body, receivedIn: req.body.receivedIn ?? null, feePaidFrom: req.body.processingFee ? req.body.feePaidFrom : null, termMonths: req.body.termMonths });
  await loan.save();
  await audit(ctx, 'update', 'LoanAccount', loan._id, `Loan ${loan.name} updated`, before, loan.toObject());
  ok(res, loan.toObject());
});

router.delete('/loans/:id', requirePermission('cash_bank.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const loan = await LoanAccount.findOneAndDelete({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!loan) throw AppError.notFound('Loan');
  const { deletedCount } = await LoanEntry.deleteMany({ company: ctx.companyId, loan: loan._id });
  await audit(ctx, 'delete', 'LoanAccount', loan._id, `Loan ${loan.name} deleted with ${deletedCount} entr${deletedCount === 1 ? 'y' : 'ies'}`, loan);
  ok(res, { deleted: true });
});

/** Loan statement: the loan taken, every EMI split into principal and interest, extra loan and charges. */
router.get('/loans/:id/statement', requirePermission('cash_bank.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const loan = await LoanAccount.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('receivedIn feePaidFrom', 'name').lean();
  if (!loan) throw AppError.notFound('Loan');
  const rows = await loanStatementRows(ctx.companyId, loan._id);
  const range = dateRange(req.query.from, req.query.to);
  const visible = range ? rows.filter((r) => (!range.$gte || r.date >= range.$gte) && (!range.$lte || r.date <= range.$lte)) : rows;
  const total = (kind: string, key: 'principal' | 'interest' | 'amount') => round2(rows.filter((r) => r.kind === kind).reduce((s, r) => s + r[key], 0));
  const totals = {
    outstanding: rows.length ? rows[rows.length - 1].balance : 0,
    taken: round2(total('opening', 'amount') + total('increase', 'amount')),
    principalPaid: total('payment', 'principal'),
    interestPaid: total('payment', 'interest'),
    charges: round2(total('charge', 'amount') + total('fee', 'amount')),
  };
  ok(res, { loan, totals, rows: visible.reverse() });
});

const loanEntryBody = z.object({
  kind: z.enum(['payment', 'increase', 'charge']),
  principal: z.coerce.number().min(0).default(0),
  interest: z.coerce.number().min(0).default(0),
  amount: z.coerce.number().min(0).default(0),
  account: objectId,
  date: z.coerce.date(),
  description: optStr,
});

/** Checks an EMI, top-up or charge against its loan and returns the fields to save. */
async function loanEntryFields(ctx: ReturnType<typeof ctxOf>, loanId: unknown, body: z.infer<typeof loanEntryBody>, editing?: { _id: unknown; principal: number; kind: string; amount: number }) {
  const loan = await LoanAccount.findOne({ _id: loanId, company: ctx.companyId }).lean();
  if (!loan) throw AppError.notFound('Loan');
  await assertAccounts(ctx, [body.account]);
  if (body.date < loan.openingDate) throw AppError.badRequest(`This loan starts on ${day(loan.openingDate)}. Pick a date on or after it.`);
  const principal = body.kind === 'payment' ? round2(body.principal) : 0;
  const interest = body.kind === 'payment' ? round2(body.interest) : 0;
  const amount = body.kind === 'payment' ? round2(principal + interest) : round2(body.amount);
  if (amount <= 0) throw AppError.badRequest(body.kind === 'payment' ? 'Enter the principal or the interest paid' : 'Enter the amount');
  if (principal > 0 || editing) {
    const [balance] = await loanBalances(ctx.companyId).then((all) => all.filter((l) => String(l._id) === String(loan._id)));
    // What would be owed without this entry
    const owed = round2((balance?.balance ?? 0) + (editing?.kind === 'payment' ? editing.principal : 0) - (editing?.kind === 'increase' ? editing.amount : 0));
    // Lowering an extra loan (or changing it to another kind of entry) below what EMIs already repaid would leave a negative amount owed
    if (round2(owed + (body.kind === 'increase' ? amount : 0)) < -0.001)
      throw AppError.badRequest(`EMIs already repay ৳${round2(-owed).toLocaleString('en-IN')} of this extra loan, so it cannot be less than that. Delete those EMIs first to lower it further.`);
    if (principal > 0 && principal > owed + 0.001) throw AppError.badRequest(`The principal paid (৳${principal.toLocaleString('en-IN')}) is more than the ৳${owed.toLocaleString('en-IN')} still owed on this loan`);
  }
  return { loan, fields: { kind: body.kind, principal, interest, amount, account: body.account, date: body.date, description: body.description } };
}

router.post('/loans/:id/entries', requirePermission('cash_bank.manage'), validate(loanEntryBody), async (req, res) => {
  const ctx = ctxOf(req);
  const { loan, fields } = await loanEntryFields(ctx, oid(req.params.id), req.body);
  const e = await LoanEntry.create({ ...fields, company: ctx.companyId, loan: loan._id, createdBy: ctx.userId });
  const what = e.kind === 'payment' ? `EMI of ${e.amount} (principal ${e.principal}, interest ${e.interest})` : e.kind === 'increase' ? `More loan of ${e.amount}` : `Charges of ${e.amount}`;
  await audit(ctx, 'create', 'LoanEntry', e._id, `${what} recorded on loan ${loan.name}`);
  created(res, e.toObject());
});

router.put('/loans/entries/:entryId', requirePermission('cash_bank.manage'), validate(loanEntryBody), async (req, res) => {
  const ctx = ctxOf(req);
  const e = await LoanEntry.findOne({ _id: oid(req.params.entryId), company: ctx.companyId });
  if (!e) throw AppError.notFound('Loan entry');
  const { loan, fields } = await loanEntryFields(ctx, e.loan, req.body, { _id: e._id, principal: e.principal ?? 0, kind: e.kind, amount: e.amount });
  const before = e.toObject();
  e.set(fields);
  await e.save();
  await audit(ctx, 'update', 'LoanEntry', e._id, `Entry on loan ${loan.name} updated`, before, e.toObject());
  ok(res, e.toObject());
});

router.delete('/loans/entries/:entryId', requirePermission('cash_bank.manage'), async (req, res) => {
  const ctx = ctxOf(req);
  const e = await LoanEntry.findOne({ _id: oid(req.params.entryId), company: ctx.companyId }).populate<{ loan: { _id: string; name: string; openingBalance: number } | null }>('loan', 'name openingBalance');
  if (!e) throw AppError.notFound('Loan entry');
  if (e.kind === 'increase' && e.loan) {
    // Removing extra loan must not leave more principal repaid than was borrowed
    const [l] = (await loanBalances(ctx.companyId)).filter((x) => String(x._id) === String(e.loan!._id));
    if (l && l.balance - e.amount < -0.001) throw AppError.badRequest('Repayments already cover part of this extra loan. Delete those EMIs first.');
  }
  await e.deleteOne();
  await audit(ctx, 'delete', 'LoanEntry', e._id, `${e.kind === 'payment' ? 'EMI' : e.kind === 'increase' ? 'Extra loan' : 'Charges'} of ${e.amount} on loan ${e.loan?.name ?? ''} deleted`, e.toObject());
  ok(res, { deleted: true });
});

/* ---------------- Expense categories ---------------- */

router.get('/expense-categories', async (req, res) => {
  const ctx = ctxOf(req);
  const range = dateRange(req.query.from, req.query.to);
  const [cats, sums] = await Promise.all([
    ExpenseCategory.find({ company: ctx.companyId }).sort({ name: 1 }).lean(),
    Transaction.aggregate([
      { $match: { company: ctx.companyId, type: 'EXPENSE', status: { $ne: 'CANCELLED' }, ...(range ? { date: range } : {}) } },
      { $group: { _id: '$expenseCategory', total: { $sum: '$total' }, balance: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]),
  ]);
  const m = new Map(sums.map((s) => [String(s._id), s]));
  ok(res, cats.map((c) => ({ ...c, total: round2(m.get(String(c._id))?.total ?? 0), balance: round2(m.get(String(c._id))?.balance ?? 0), count: m.get(String(c._id))?.count ?? 0 })));
});

const expCatSchema = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['direct', 'indirect']).default('indirect') });

router.post('/expense-categories', requirePermission('expense.create'), validate(expCatSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const c = await ExpenseCategory.create({ ...req.body, company: ctx.companyId });
  await audit(ctx, 'create', 'ExpenseCategory', c._id, `Expense category ${c.name} created`);
  created(res, c.toObject());
});

router.put('/expense-categories/:id', requirePermission('expense.edit'), validate(expCatSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const c = await ExpenseCategory.findOneAndUpdate({ _id: oid(req.params.id), company: ctx.companyId }, { $set: req.body }, { returnDocument: 'after' }).lean();
  if (!c) throw AppError.notFound('Expense category');
  ok(res, c);
});

router.delete('/expense-categories/:id', requirePermission('expense.delete'), async (req, res) => {
  const ctx = ctxOf(req);
  const id = oid(req.params.id);
  const used = await Transaction.countDocuments({ company: ctx.companyId, expenseCategory: id });
  if (used) throw AppError.badRequest(`This category has ${used} expense(s)`);
  const c = await ExpenseCategory.findOneAndDelete({ _id: id, company: ctx.companyId }).lean();
  if (!c) throw AppError.notFound('Expense category');
  await audit(ctx, 'delete', 'ExpenseCategory', id, `Expense category ${c.name} deleted`);
  ok(res, { deleted: true });
});

export default router;
