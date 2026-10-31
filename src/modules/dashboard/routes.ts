import { Router } from 'express';
import { ctxOf } from '../../core/ctx.js';
import { ok, round2, str } from '../../core/http.js';
import { requirePermission } from '../../middleware/company.js';
import { ApprovalRequest, Item, Party, Transaction } from '../../models/index.js';
import { accountBalances, cashEffectExpr, loanBalances, loanCosts } from '../../services/ledger.js';

const router = Router();

router.get('/', requirePermission('dashboard.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const c = ctx.companyId;
  const now = new Date();
  const from = str(req.query.from) ? new Date(String(req.query.from)) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = str(req.query.to) ? new Date(String(req.query.to)) : now;
  to.setHours(23, 59, 59, 999);
  from.setHours(0, 0, 0, 0);
  const notCancelled = { status: { $ne: 'CANCELLED' } };
  const yearStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  const [byType, parties, stock, lowStock, monthly, recent, openDocs, approvals, topItems, topParties, cogs, accounts, overdue, cheques, loanCost, loans] = await Promise.all([
    Transaction.aggregate([
      { $match: { company: c, ...notCancelled, date: { $gte: from, $lte: to } } },
      { $group: { _id: '$type', total: { $sum: '$total' }, settled: { $sum: { $add: ['$settled', { $ifNull: ['$paidViaPayments', 0] }] } }, balance: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]),
    Party.aggregate([
      { $match: { company: c } },
      { $group: { _id: null, receivable: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } }, payable: { $sum: { $cond: [{ $lt: ['$balance', 0] }, { $abs: '$balance' }, 0] } }, count: { $sum: 1 } } },
    ]),
    Item.aggregate([
      { $match: { company: c, type: 'product' } },
      { $group: { _id: null, value: { $sum: { $multiply: [{ $max: ['$stock', 0] }, '$purchasePrice'] } }, count: { $sum: 1 } } },
    ]),
    Item.find({ company: c, type: 'product', isActive: { $ne: false }, minStock: { $gt: 0 }, $expr: { $lte: ['$stock', '$minStock'] } }).select('name stock minStock').populate('baseUnit', 'shortName').limit(8).lean(),
    Transaction.aggregate([
      { $match: { company: c, ...notCancelled, type: { $in: ['SALE', 'PURCHASE', 'EXPENSE', 'SALE_RETURN', 'PURCHASE_RETURN'] }, date: { $gte: yearStart } } },
      { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' }, t: '$type' }, total: { $sum: '$total' } } },
    ]),
    Transaction.find({ company: c }).sort({ createdAt: -1 }).limit(10).select('type number partyName date total balance status').lean(),
    Transaction.aggregate([
      { $match: { company: c, status: 'OPEN', type: { $in: ['ESTIMATE', 'PROFORMA', 'SALE_ORDER', 'DELIVERY_CHALLAN', 'PURCHASE_ORDER'] } } },
      { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$total' } } },
    ]),
    ApprovalRequest.countDocuments({ company: c, status: 'pending' }),
    Transaction.aggregate([
      { $match: { company: c, ...notCancelled, type: 'SALE', date: { $gte: from, $lte: to } } },
      { $unwind: '$items' },
      { $group: { _id: { $ifNull: ['$items.item', '$items.name'] }, name: { $first: '$items.name' }, qty: { $sum: '$items.qty' }, amount: { $sum: '$items.amount' } } },
      { $sort: { amount: -1 } },
      { $limit: 5 },
    ]),
    Transaction.aggregate([
      { $match: { company: c, ...notCancelled, type: 'SALE', party: { $ne: null }, date: { $gte: from, $lte: to } } },
      { $group: { _id: '$party', name: { $first: '$partyName' }, total: { $sum: '$total' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]),
    Transaction.aggregate([
      { $match: { company: c, ...notCancelled, type: { $in: ['SALE', 'SALE_RETURN'] }, date: { $gte: from, $lte: to } } },
      { $unwind: '$items' },
      { $group: { _id: '$type', cost: { $sum: { $multiply: ['$items.baseQty', '$items.costPrice'] } }, tax: { $sum: '$items.taxAmount' } } },
    ]),
    accountBalances(c),
    Transaction.aggregate([
      { $match: { company: c, type: 'SALE', status: { $in: ['UNPAID', 'PARTIAL'] }, dueDate: { $lt: now } } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$balance' } } },
    ]),
    // Cheques not yet deposited (received) or withdrawn (issued)
    Transaction.aggregate<{ _id: boolean; count: number; total: number }>([
      { $match: { company: c, ...notCancelled, 'cheque.status': 'OPEN' } },
      { $project: { amount: cashEffectExpr } },
      { $group: { _id: { $gt: ['$amount', 0] }, count: { $sum: 1 }, total: { $sum: { $abs: '$amount' } } } },
    ]),
    loanCosts(c, { $gte: from, $lte: to }),
    loanBalances(c),
  ]);

  const t = (type: string) => byType.find((x) => x._id === type) ?? { total: 0, settled: 0, balance: 0, count: 0 };
  const sale = t('SALE'), purchase = t('PURCHASE'), expense = t('EXPENSE'), saleReturn = t('SALE_RETURN'), purchaseReturn = t('PURCHASE_RETURN');
  const cogsSale = cogs.find((x) => x._id === 'SALE') ?? { cost: 0, tax: 0 };
  const cogsReturn = cogs.find((x) => x._id === 'SALE_RETURN') ?? { cost: 0, tax: 0 };
  const netSales = sale.total - saleReturn.total - (cogsSale.tax - cogsReturn.tax);
  const grossProfit = netSales - (cogsSale.cost - cogsReturn.cost);

  const months: { key: string; label: string; sale: number; purchase: number; expense: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const get = (type: string) => monthly.find((x) => x._id.y === y && x._id.m === m && x._id.t === type)?.total ?? 0;
    months.push({
      key: `${y}-${String(m).padStart(2, '0')}`,
      label: d.toLocaleString('en', { month: 'short' }) + ' ' + String(y).slice(2),
      sale: round2(get('SALE') - get('SALE_RETURN')),
      purchase: round2(get('PURCHASE') - get('PURCHASE_RETURN')),
      expense: round2(get('EXPENSE')),
    });
  }

  ok(res, {
    range: { from, to },
    sales: { total: round2(sale.total), received: round2(sale.settled), balance: round2(sale.balance), count: sale.count, returns: round2(saleReturn.total) },
    purchases: { total: round2(purchase.total), paid: round2(purchase.settled), balance: round2(purchase.balance), count: purchase.count, returns: round2(purchaseReturn.total) },
    expenses: { total: round2(expense.total), count: expense.count },
    paymentIn: round2(t('PAYMENT_IN').total),
    paymentOut: round2(t('PAYMENT_OUT').total),
    profit: { gross: round2(grossProfit), net: round2(grossProfit - expense.total - loanCost) },
    receivable: round2(parties[0]?.receivable ?? 0),
    payable: round2(parties[0]?.payable ?? 0),
    partyCount: parties[0]?.count ?? 0,
    stock: { value: round2(stock[0]?.value ?? 0), items: stock[0]?.count ?? 0, low: lowStock },
    cash: round2(accounts.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0)),
    bank: round2(accounts.filter((a) => a.kind !== 'cash').reduce((s, a) => s + a.balance, 0)),
    accounts: accounts.map((a) => ({ _id: a._id, name: a.name, kind: a.kind, balance: a.balance })),
    overdue: { count: overdue[0]?.count ?? 0, amount: round2(overdue[0]?.amount ?? 0) },
    openDocs: Object.fromEntries(openDocs.map((o) => [o._id, { count: o.count, total: round2(o.total) }])),
    cheques: Object.fromEntries(cheques.map((x) => [x._id ? 'received' : 'issued', { count: x.count, total: round2(x.total) }])),
    loans: { count: loans.filter((l) => l.balance > 0.005).length, outstanding: round2(loans.reduce((s, l) => s + l.balance, 0)) },
    pendingApprovals: approvals,
    monthly: months,
    recent,
    topItems: topItems.map((i) => ({ name: i.name, qty: round2(i.qty), amount: round2(i.amount) })),
    topParties: topParties.map((p) => ({ _id: p._id, name: p.name, total: round2(p.total), count: p.count })),
  });
});

export default router;
