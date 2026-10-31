/**
 * Ledger: recomputes every derived balance from source documents.
 * Writes never increment balances; they call these idempotent recalculations instead.
 */
import { Types } from 'mongoose';
import { BankAccount, BankEntry, Item, LoanAccount, LoanEntry, Party, StockAdjustment, Transaction } from '../models/index.js';
import { TXN_CONFIG, TXN_TYPES, type TxnType } from '../core/txn.js';
import { round2 } from '../core/http.js';

type Id = Types.ObjectId | string;
const uniqIds = (ids: (Id | null | undefined)[]) =>
  [...new Set(ids.filter(Boolean).map(String))].map((s) => new Types.ObjectId(s));

const signSwitch = (key: 'stock' | 'party' | 'cash') => ({
  $switch: {
    branches: TXN_TYPES.filter((t) => TXN_CONFIG[t][key] !== 0).map((t) => ({ case: { $eq: ['$type', t] }, then: TXN_CONFIG[t][key] })),
    default: 0,
  },
});

const PAYMENT_TYPES = TXN_TYPES.filter((t) => TXN_CONFIG[t].isPayment);

/** Party balance effect of one document (positive = receivable). Used by aggregations and in memory. */
export const partyEffectExpr = {
  $multiply: [
    signSwitch('party'),
    { $cond: [{ $in: ['$type', PAYMENT_TYPES] }, '$total', { $subtract: ['$total', '$settled'] }] },
  ],
};

/** Cash effect of one document on its payment account. */
export const cashEffectExpr = {
  $multiply: [signSwitch('cash'), { $cond: [{ $in: ['$type', PAYMENT_TYPES] }, '$total', '$settled'] }],
};

export const stockSignExpr = signSwitch('stock');

export async function recalcParties(companyId: Types.ObjectId, ids: (Id | null | undefined)[]) {
  const partyIds = uniqIds(ids);
  if (!partyIds.length) return;
  const sums = await Transaction.aggregate<{ _id: Types.ObjectId; sum: number }>([
    { $match: { company: companyId, party: { $in: partyIds }, status: { $ne: 'CANCELLED' } } },
    { $group: { _id: '$party', sum: { $sum: partyEffectExpr } } },
  ]);
  const map = new Map(sums.map((s) => [String(s._id), s.sum]));
  const parties = await Party.find({ _id: { $in: partyIds }, company: companyId }).select('openingBalance').lean();
  if (!parties.length) return;
  await Party.bulkWrite(
    parties.map((p) => ({
      updateOne: { filter: { _id: p._id }, update: { $set: { balance: round2((p.openingBalance ?? 0) + (map.get(String(p._id)) ?? 0)) } } },
    })),
  );
}

export async function recalcItems(companyId: Types.ObjectId, ids: (Id | null | undefined)[]) {
  const itemIds = uniqIds(ids);
  if (!itemIds.length) return;
  const stockTypes = TXN_TYPES.filter((t) => TXN_CONFIG[t].stock !== 0);
  const [txnSums, adjSums, items] = await Promise.all([
    Transaction.aggregate<{ _id: Types.ObjectId; qty: number }>([
      { $match: { company: companyId, type: { $in: stockTypes }, status: { $ne: 'CANCELLED' }, 'items.item': { $in: itemIds } } },
      { $unwind: '$items' },
      { $match: { 'items.item': { $in: itemIds } } },
      { $group: { _id: '$items.item', qty: { $sum: { $multiply: [stockSignExpr, '$items.baseQty'] } } } },
    ]),
    StockAdjustment.aggregate<{ _id: Types.ObjectId; qty: number }>([
      { $match: { company: companyId, item: { $in: itemIds } } },
      { $group: { _id: '$item', qty: { $sum: { $cond: [{ $eq: ['$kind', 'add'] }, '$qty', { $multiply: ['$qty', -1] }] } } } },
    ]),
    Item.find({ _id: { $in: itemIds }, company: companyId }).select('openingQty type').lean(),
  ]);
  const t = new Map(txnSums.map((s) => [String(s._id), s.qty]));
  const a = new Map(adjSums.map((s) => [String(s._id), s.qty]));
  if (!items.length) return;
  await Item.bulkWrite(
    items.map((it) => ({
      updateOne: {
        filter: { _id: it._id },
        update: { $set: { stock: it.type === 'service' ? 0 : round2((it.openingQty ?? 0) + (t.get(String(it._id)) ?? 0) + (a.get(String(it._id)) ?? 0)) } },
      },
    })),
  );
}

/** Recomputes paidViaPayments / balance / payment status for invoices, bills, returns, expenses and payments. */
export async function recalcDocuments(companyId: Types.ObjectId, ids: (Id | null | undefined)[]) {
  const docIds = uniqIds(ids);
  if (!docIds.length) return;
  const [docs, allocs] = await Promise.all([
    Transaction.find({ _id: { $in: docIds }, company: companyId }).select('type total settled status allocations').lean(),
    Transaction.aggregate<{ _id: Types.ObjectId; paid: number }>([
      { $match: { company: companyId, 'allocations.transaction': { $in: docIds }, status: { $ne: 'CANCELLED' } } },
      { $unwind: '$allocations' },
      { $match: { 'allocations.transaction': { $in: docIds } } },
      { $group: { _id: '$allocations.transaction', paid: { $sum: '$allocations.amount' } } },
    ]),
  ]);
  const paidMap = new Map(allocs.map((a) => [String(a._id), a.paid]));
  const ops = docs.map((d) => {
    const cfg = TXN_CONFIG[d.type as TxnType];
    const set: Record<string, unknown> = {};
    if (cfg.isPayment) {
      const used = (d.allocations ?? []).reduce((s, x) => s + x.amount, 0);
      set.paidViaPayments = round2(used);
      set.balance = round2(d.total - used); // unused (advance) amount
      if (d.status !== 'CANCELLED') set.status = 'COMPLETED';
    } else if (cfg.settles) {
      const paid = round2(paidMap.get(String(d._id)) ?? 0);
      const balance = round2(d.total - d.settled - paid);
      set.paidViaPayments = paid;
      set.balance = Math.max(0, balance);
      if (d.status !== 'CANCELLED') set.status = balance <= 0.004 ? 'PAID' : d.settled + paid > 0 ? 'PARTIAL' : 'UNPAID';
    } else {
      set.balance = 0;
    }
    return { updateOne: { filter: { _id: d._id }, update: { $set: set } } };
  });
  if (ops.length) await Transaction.bulkWrite(ops);
}

/** Signed amount of a loan entry for the account it went through: extra loan comes in, everything else goes out. */
const loanCashExpr = { $cond: [{ $eq: ['$kind', 'increase'] }, '$amount', { $multiply: ['$amount', -1] }] };

/**
 * Balance of each cash/bank account = opening + document cash effects + manual entries (adjustments,
 * transfers, cleared cheques) + loan money received, EMIs paid and loan charges.
 */
export async function accountBalances(companyId: Types.ObjectId, until?: Date) {
  const dateFilter = until ? { date: { $lte: until } } : {};
  const [accounts, txn, entries, loans, loanMoves] = await Promise.all([
    BankAccount.find({ company: companyId }).sort({ isDefault: -1, name: 1 }).lean(),
    Transaction.aggregate<{ _id: Types.ObjectId; sum: number }>([
      { $match: { company: companyId, status: { $ne: 'CANCELLED' }, paymentAccount: { $ne: null }, ...dateFilter } },
      { $group: { _id: '$paymentAccount', sum: { $sum: cashEffectExpr } } },
    ]),
    BankEntry.aggregate<{ _id: Types.ObjectId; sum: number }>([
      { $match: { company: companyId, ...dateFilter } },
      {
        $project: {
          moves: {
            $switch: {
              branches: [
                { case: { $eq: ['$kind', 'add'] }, then: [{ a: '$account', v: '$amount' }] },
                { case: { $eq: ['$kind', 'reduce'] }, then: [{ a: '$account', v: { $multiply: ['$amount', -1] } }] },
              ],
              default: [{ a: '$account', v: { $multiply: ['$amount', -1] } }, { a: '$toAccount', v: '$amount' }],
            },
          },
        },
      },
      { $unwind: '$moves' },
      { $group: { _id: '$moves.a', sum: { $sum: '$moves.v' } } },
    ]),
    LoanAccount.find({ company: companyId, ...(until ? { openingDate: { $lte: until } } : {}) }).select('receivedIn feePaidFrom openingBalance processingFee').lean(),
    LoanEntry.aggregate<{ _id: Types.ObjectId; sum: number }>([
      { $match: { company: companyId, ...dateFilter } },
      { $group: { _id: '$account', sum: { $sum: loanCashExpr } } },
    ]),
  ]);
  const sums = new Map<string, number>();
  const add = (id: unknown, v: number) => id && sums.set(String(id), (sums.get(String(id)) ?? 0) + v);
  for (const x of [...txn, ...entries, ...loanMoves]) add(x._id, x.sum);
  for (const l of loans) {
    add(l.receivedIn, l.openingBalance ?? 0);
    add(l.feePaidFrom, -(l.processingFee ?? 0));
  }
  return accounts.map((acc) => ({ ...acc, balance: round2((acc.openingBalance ?? 0) + (sums.get(String(acc._id)) ?? 0)) }));
}

/** One movement of money in or out of a cash/bank account, as statements and the cash flow report list it. */
export interface AccountMove {
  _id: string;
  kind: 'txn' | 'entry' | 'cheque' | 'loan';
  /** Document type for documents; ADD, REDUCE or TRANSFER for manual entries; CHEQUE; LOAN */
  type: string;
  label: string;
  number: string;
  party: string;
  date: Date;
  createdAt: Date;
  account: string;
  /** Positive into the account, negative out of it */
  amount: number;
  /** The document a row opens (documents, and cheques by their payment) */
  link?: { type: TxnType; id: string };
  loan?: string;
  /** Manual adjustments and transfers are removed from the statement; the rest from their own screens */
  deletable: boolean;
}

/**
 * Every movement through the given accounts, oldest first. With `skipInternal`, a transfer between two of the
 * given accounts is left out (it moves nothing in or out of the group).
 */
export async function accountMoves(companyId: Types.ObjectId, accountIds: Types.ObjectId[], opts: { skipInternal?: boolean } = {}): Promise<AccountMove[]> {
  const inSet = new Set(accountIds.map(String));
  type Named = { _id: Types.ObjectId; name: string } | null;
  const [txns, entries, loans, loanEntries] = await Promise.all([
    Transaction.aggregate<{ _id: Types.ObjectId; type: TxnType; number: string; partyName?: string; date: Date; createdAt: Date; paymentAccount: Types.ObjectId; amount: number }>([
      { $match: { company: companyId, paymentAccount: { $in: accountIds }, status: { $ne: 'CANCELLED' } } },
      { $project: { type: 1, number: 1, partyName: 1, date: 1, createdAt: 1, paymentAccount: 1, amount: cashEffectExpr } },
    ]),
    BankEntry.find({ company: companyId, $or: [{ account: { $in: accountIds } }, { toAccount: { $in: accountIds } }] })
      .populate<{ account: Named; toAccount: Named }>('account toAccount', 'name')
      .populate<{ cheque: { _id: Types.ObjectId; type: TxnType; number: string; partyName?: string; paymentRef?: string } | null }>('cheque', 'type number partyName paymentRef')
      .lean(),
    LoanAccount.find({ company: companyId, $or: [{ receivedIn: { $in: accountIds } }, { feePaidFrom: { $in: accountIds } }] }).lean(),
    LoanEntry.find({ company: companyId, account: { $in: accountIds } }).populate<{ loan: { _id: Types.ObjectId; name: string } | null }>('loan', 'name').lean(),
  ]);
  const moves: AccountMove[] = [];
  for (const t of txns) {
    if (!t.amount) continue;
    moves.push({ _id: String(t._id), kind: 'txn', type: t.type, label: TXN_CONFIG[t.type]?.label ?? t.type, number: t.number, party: t.partyName ?? '', date: t.date, createdAt: t.createdAt, account: String(t.paymentAccount), amount: round2(t.amount), link: { type: t.type, id: String(t._id) }, deletable: false });
  }
  for (const e of entries) {
    const base = { _id: String(e._id), date: e.date as Date, createdAt: e.createdAt as Date };
    const from = e.account?._id ? String(e.account._id) : '';
    if (e.cheque) {
      const c = e.cheque;
      moves.push({
        ...base, kind: 'cheque', type: 'CHEQUE', label: e.kind === 'add' ? 'Cheque deposited' : 'Cheque withdrawn', number: c.number,
        party: [c.partyName, c.paymentRef && `Cheque ${c.paymentRef}`].filter(Boolean).join(' · '), account: from,
        amount: round2(e.kind === 'add' ? e.amount : -e.amount), link: { type: c.type, id: String(c._id) }, deletable: false,
      });
      continue;
    }
    if (e.kind !== 'transfer') {
      moves.push({ ...base, kind: 'entry', type: e.kind.toUpperCase(), label: e.kind === 'add' ? 'Balance added' : 'Balance reduced', number: '', party: e.description ?? '', account: from, amount: round2(e.kind === 'add' ? e.amount : -e.amount), deletable: true });
      continue;
    }
    const to = e.toAccount?._id ? String(e.toAccount._id) : '';
    if (opts.skipInternal && inSet.has(from) && inSet.has(to)) continue;
    if (inSet.has(from)) moves.push({ ...base, kind: 'entry', type: 'TRANSFER', label: `Transfer to ${e.toAccount?.name ?? 'another account'}`, number: '', party: e.description ?? '', account: from, amount: -round2(e.amount), deletable: true });
    if (inSet.has(to)) moves.push({ ...base, kind: 'entry', type: 'TRANSFER', label: `Transfer from ${e.account?.name ?? 'another account'}`, number: '', party: e.description ?? '', account: to, amount: round2(e.amount), deletable: true });
  }
  for (const l of loans) {
    const base = { kind: 'loan' as const, type: 'LOAN', number: l.accountNumber ?? '', party: l.name, date: l.openingDate as Date, createdAt: l.createdAt as Date, loan: String(l._id), deletable: false };
    if (l.receivedIn && inSet.has(String(l.receivedIn)) && l.openingBalance > 0) moves.push({ ...base, _id: `${l._id}:in`, label: 'Loan received', account: String(l.receivedIn), amount: round2(l.openingBalance) });
    if (l.feePaidFrom && inSet.has(String(l.feePaidFrom)) && (l.processingFee ?? 0) > 0) moves.push({ ...base, _id: `${l._id}:fee`, label: 'Loan processing fee', account: String(l.feePaidFrom), amount: -round2(l.processingFee ?? 0) });
  }
  const LOAN_LABEL = { payment: 'Loan EMI paid', increase: 'More loan taken', charge: 'Loan charges' } as const;
  for (const e of loanEntries) {
    moves.push({
      _id: String(e._id), kind: 'loan', type: 'LOAN', label: LOAN_LABEL[e.kind], number: '', party: [e.loan?.name, e.description].filter(Boolean).join(' · '),
      date: e.date, createdAt: e.createdAt as Date, account: String(e.account), amount: round2(e.kind === 'increase' ? e.amount : -e.amount), loan: e.loan ? String(e.loan._id) : undefined, deletable: false,
    });
  }
  return moves.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * Statement of one account or a group of accounts: running balance from the opening balances, and the
 * opening, money in, money out and closing of the period. The Cash & Bank screen and the cash flow and
 * bank statement reports all use it, so they always agree.
 */
export async function accountStatement(companyId: Types.ObjectId, accountIds: Types.ObjectId[], range?: { $gte?: Date; $lte?: Date }, opts: { skipInternal?: boolean } = {}) {
  const [accounts, moves] = await Promise.all([
    BankAccount.find({ company: companyId, _id: { $in: accountIds } }).select('openingBalance').lean(),
    accountMoves(companyId, accountIds, opts),
  ]);
  let running = accounts.reduce((s, a) => s + (a.openingBalance ?? 0), 0);
  const rows = moves.map((m) => ({ ...m, balance: round2((running += m.amount)) }));
  // Opening of the period = running balance after the last movement before it starts
  let opening = round2(accounts.reduce((s, a) => s + (a.openingBalance ?? 0), 0));
  if (range?.$gte) for (const r of rows) if (new Date(r.date) < range.$gte) opening = r.balance;
  const visible = rows.filter((r) => (!range?.$gte || new Date(r.date) >= range.$gte) && (!range?.$lte || new Date(r.date) <= range.$lte));
  return {
    opening,
    moneyIn: round2(visible.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
    moneyOut: round2(visible.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0)),
    closing: visible.length ? visible[visible.length - 1].balance : opening,
    currentBalance: round2(running),
    rows: visible,
  };
}

/** What is still owed on each loan, and the interest and charges paid on it, as of a date. */
export async function loanBalances(companyId: Types.ObjectId, until?: Date) {
  const [loans, sums] = await Promise.all([
    LoanAccount.find({ company: companyId }).sort({ name: 1 }).lean(),
    LoanEntry.aggregate<{ _id: Types.ObjectId; increase: number; principal: number; interest: number; charges: number; payments: number }>([
      { $match: { company: companyId, ...(until ? { date: { $lte: until } } : {}) } },
      {
        $group: {
          _id: '$loan',
          increase: { $sum: { $cond: [{ $eq: ['$kind', 'increase'] }, '$amount', 0] } },
          principal: { $sum: { $cond: [{ $eq: ['$kind', 'payment'] }, '$principal', 0] } },
          interest: { $sum: { $cond: [{ $eq: ['$kind', 'payment'] }, '$interest', 0] } },
          charges: { $sum: { $cond: [{ $eq: ['$kind', 'charge'] }, '$amount', 0] } },
          payments: { $sum: { $cond: [{ $eq: ['$kind', 'payment'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const m = new Map(sums.map((x) => [String(x._id), x]));
  return loans.map((l) => {
    const x = m.get(String(l._id));
    const opened = !until || l.openingDate <= until;
    return {
      ...l,
      balance: round2((opened ? l.openingBalance : 0) + (x?.increase ?? 0) - (x?.principal ?? 0)),
      principalPaid: round2(x?.principal ?? 0),
      interestPaid: round2(x?.interest ?? 0),
      chargesPaid: round2((x?.charges ?? 0) + (opened ? (l.processingFee ?? 0) : 0)),
      payments: x?.payments ?? 0,
    };
  });
}

/** One line of a loan statement. `change` is what the line does to the amount owed. */
export interface LoanRow {
  _id: string;
  kind: 'opening' | 'fee' | 'payment' | 'increase' | 'charge';
  label: string;
  date: Date;
  account: { _id: string; name: string } | null;
  principal: number;
  interest: number;
  amount: number;
  change: number;
  balance: number;
  description?: string | null;
  /** Rows that are loan entries (edited and deleted on their own); the opening and fee belong to the loan */
  entry: boolean;
}

/** The loan taken, its processing fee, then every EMI, extra loan and charge, oldest first with the balance owed. */
export async function loanStatementRows(companyId: Types.ObjectId, loanId: Types.ObjectId): Promise<LoanRow[]> {
  type Named = { _id: string; name: string } | null;
  const [loan, entries] = await Promise.all([
    LoanAccount.findOne({ _id: loanId, company: companyId }).populate<{ receivedIn: Named; feePaidFrom: Named }>('receivedIn feePaidFrom', 'name').lean(),
    LoanEntry.find({ company: companyId, loan: loanId }).populate<{ account: Named }>('account', 'name').sort({ date: 1, createdAt: 1 }).lean(),
  ]);
  if (!loan) return [];
  const LABEL = { payment: 'EMI paid', increase: 'More loan taken', charge: 'Charges paid' } as const;
  const rows: Omit<LoanRow, 'balance'>[] = [
    { _id: `${loan._id}:opening`, kind: 'opening', label: 'Loan taken', date: loan.openingDate, account: loan.receivedIn, principal: 0, interest: 0, amount: loan.openingBalance, change: loan.openingBalance, description: loan.description, entry: false },
    ...((loan.processingFee ?? 0) > 0
      ? [{ _id: `${loan._id}:fee`, kind: 'fee' as const, label: 'Processing fee', date: loan.openingDate, account: loan.feePaidFrom, principal: 0, interest: 0, amount: loan.processingFee ?? 0, change: 0, entry: false }]
      : []),
    ...entries.map((e) => ({
      _id: String(e._id), kind: e.kind, label: LABEL[e.kind], date: e.date, account: e.account, principal: e.principal ?? 0, interest: e.interest ?? 0, amount: e.amount,
      change: e.kind === 'increase' ? e.amount : e.kind === 'payment' ? -(e.principal ?? 0) : 0, description: e.description, entry: true,
    })),
  ];
  let balance = 0;
  return rows.map((r) => ({ ...r, balance: round2((balance += r.change)) }));
}

/** Interest and charges on loans in a period: an indirect expense in the profit and loss. */
export async function loanCosts(companyId: Types.ObjectId, range?: { $gte?: Date; $lte?: Date }) {
  const date = range && Object.keys(range).length ? { date: range } : {};
  const [entries, fees] = await Promise.all([
    LoanEntry.aggregate<{ total: number }>([
      { $match: { company: companyId, kind: { $in: ['payment', 'charge'] }, ...date } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$kind', 'payment'] }, '$interest', '$amount'] } } } },
    ]),
    LoanAccount.aggregate<{ total: number }>([
      { $match: { company: companyId, processingFee: { $gt: 0 }, ...(range && Object.keys(range).length ? { openingDate: range } : {}) } },
      { $group: { _id: null, total: { $sum: '$processingFee' } } },
    ]),
  ]);
  return round2((entries[0]?.total ?? 0) + (fees[0]?.total ?? 0));
}

export async function defaultCashAccount(companyId: Types.ObjectId) {
  let acc = await BankAccount.findOne({ company: companyId, kind: 'cash', isDefault: true });
  if (!acc) acc = await BankAccount.findOne({ company: companyId, kind: 'cash' });
  if (!acc) acc = await BankAccount.create({ company: companyId, name: 'Cash', kind: 'cash', isDefault: true });
  return acc;
}
