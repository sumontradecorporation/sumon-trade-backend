import { AppError } from '../../core/errors.js';
import { round2 } from '../../core/http.js';
import { zonedNow } from '../../core/time.js';
import { TXN_CONFIG, TXN_TYPES } from '../../core/txn.js';
import { Attendance, AuditLog, BankAccount, Category, Employee, ExpenseCategory, Item, LoanAccount, Party, PartyGroup, Payroll, StockAdjustment, Transaction, } from '../../models/index.js';
import { accountBalances, accountStatement, loanBalances, loanCosts, loanStatementRows, partyEffectExpr, stockSignExpr } from '../../services/ledger.js';
/* ---------------- helpers ---------------- */
const col = (key, label, type = 'text', width) => ({ key, label, type, width });
const sum = (rows, keys) => Object.fromEntries(keys.map((k) => [k, round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0))]));
const dateMatch = (p, field = 'date') => {
    const r = {};
    if (p.from)
        r.$gte = p.from;
    if (p.to)
        r.$lte = p.to;
    return Object.keys(r).length ? { [field]: r } : {};
};
const label = (t) => TXN_CONFIG[t]?.label ?? t.replace(/_/g, ' ');
const live = { status: { $ne: 'CANCELLED' } };
function txnListReport(types, opts) {
    return async (ctx, p) => {
        const match = { company: ctx.companyId, type: { $in: p.type?.length ? p.type.filter((t) => types.includes(t)) : types }, ...dateMatch(p) };
        if (p.party)
            match.party = p.party;
        if (p.category)
            match.expenseCategory = p.category;
        if (p.user)
            match.createdBy = p.user;
        if (p.status)
            match.status = p.status;
        const docs = await Transaction.find(match).sort({ date: 1, createdAt: 1 }).populate('expenseCategory', 'name').lean();
        const rows = docs.map((d) => {
            const sign = d.type.endsWith('RETURN') ? -1 : 1;
            return {
                _id: d._id,
                txnType: d.type,
                date: d.date,
                number: d.number,
                party: d.partyName ?? '',
                category: d.expenseCategory?.name ?? '',
                type: label(d.type),
                paymentType: d.paymentType ?? '',
                total: d.status === 'CANCELLED' ? 0 : sign * d.total,
                tax: d.status === 'CANCELLED' ? 0 : sign * d.taxTotal,
                settled: d.status === 'CANCELLED' ? 0 : sign * round2(d.settled + (d.paidViaPayments ?? 0)),
                balance: d.status === 'CANCELLED' ? 0 : sign * d.balance,
                status: d.status,
            };
        });
        const columns = [
            col('date', 'Date', 'date'), col('number', 'Ref No.'), opts.withCategory ? col('category', 'Category') : col('party', 'Party Name', 'text', 28),
            ...(opts.withCategory ? [col('party', 'Party')] : []), col('type', 'Type'), col('paymentType', 'Payment Type'), col('total', 'Total', 'money'), col('tax', 'Tax', 'money'),
            col('settled', opts.settledLabel, 'money'), col('balance', 'Balance', 'money'), ...(opts.withStatus !== false ? [col('status', 'Status')] : []),
        ];
        const totals = sum(rows, ['total', 'tax', 'settled', 'balance']);
        return {
            columns,
            rows,
            totals,
            summary: [
                { label: 'Total', value: totals.total, type: 'money' },
                { label: opts.settledLabel, value: totals.settled, type: 'money' },
                { label: 'Balance', value: totals.balance, type: 'money' },
                { label: 'Documents', value: rows.length, type: 'number' },
            ],
        };
    };
}
/** Quantity (base unit) of every product as of a date, honouring opening dates. */
async function stockAsOf(companyId, asOf, before = false) {
    const dateCond = asOf ? { date: before ? { $lt: asOf } : { $lte: asOf } } : {};
    const items = await Item.find({ company: companyId, type: 'product' }).select('name openingQty openingDate purchasePrice salePrice stock minStock category baseUnit').populate('category', 'name').populate('baseUnit', 'shortName').lean();
    const [txn, adj] = await Promise.all([
        Transaction.aggregate([
            { $match: { company: companyId, ...live, type: { $in: TXN_TYPES.filter((t) => TXN_CONFIG[t].stock !== 0) }, ...dateCond } },
            { $unwind: '$items' },
            { $match: { 'items.item': { $ne: null } } },
            { $group: { _id: '$items.item', qty: { $sum: { $multiply: [stockSignExpr, '$items.baseQty'] } } } },
        ]),
        StockAdjustment.aggregate([
            { $match: { company: companyId, ...dateCond } },
            { $group: { _id: '$item', qty: { $sum: { $cond: [{ $eq: ['$kind', 'add'] }, '$qty', { $multiply: ['$qty', -1] }] } } } },
        ]),
    ]);
    const t = new Map(txn.map((x) => [String(x._id), x.qty]));
    const a = new Map(adj.map((x) => [String(x._id), x.qty]));
    return items.map((it) => {
        const openingCounts = !asOf || !it.openingDate || (before ? it.openingDate < asOf : it.openingDate <= asOf);
        const qty = round2((openingCounts ? it.openingQty : 0) + (t.get(String(it._id)) ?? 0) + (a.get(String(it._id)) ?? 0));
        return { ...it, qty, value: round2(Math.max(qty, 0) * it.purchasePrice) };
    });
}
async function partyStatement(ctx, p) {
    if (!p.party)
        throw AppError.badRequest('Select a party');
    const party = await Party.findOne({ _id: p.party, company: ctx.companyId }).lean();
    if (!party)
        throw AppError.notFound('Party');
    const docs = await Transaction.find({ company: ctx.companyId, party: party._id, ...live, type: { $in: TXN_TYPES.filter((t) => TXN_CONFIG[t].party !== 0) } }).sort({ date: 1, createdAt: 1 }).lean();
    let running = party.openingBalance ?? 0;
    let opening = running;
    const rows = [];
    for (const d of docs) {
        const cfg = TXN_CONFIG[d.type];
        let debit = 0;
        let credit = 0;
        if (cfg.isPayment) {
            if (cfg.party > 0)
                debit = d.total;
            else
                credit = d.total;
        }
        else if (cfg.party > 0) {
            debit = d.total;
            credit = d.settled;
        }
        else {
            credit = d.total;
            debit = d.settled;
        }
        running = round2(running + debit - credit);
        if (p.from && d.date < p.from) {
            opening = running;
            continue;
        }
        if (p.to && d.date > p.to)
            continue;
        rows.push({ _id: d._id, txnType: d.type, date: d.date, type: label(d.type), number: d.number, description: d.description ?? '', debit: round2(debit), credit: round2(credit), balance: running });
    }
    if (!p.from)
        opening = party.openingBalance ?? 0;
    const closing = rows.length ? rows[rows.length - 1].balance : opening;
    const fmt = (n) => `${Math.abs(n).toFixed(2)} ${n >= 0 ? '(To receive)' : '(To pay)'}`;
    return {
        subtitle: `${party.name}${party.phone ? ` · ${party.phone}` : ''}`,
        columns: [col('date', 'Date', 'date'), col('type', 'Txn Type'), col('number', 'Ref No.'), col('description', 'Description', 'text', 30), col('debit', 'Debit (+)', 'money'), col('credit', 'Credit (−)', 'money'), col('balance', 'Running Balance', 'money')],
        rows: [{ date: p.from ?? party.openingBalanceDate, type: 'Opening Balance', number: '', description: '', debit: opening > 0 ? opening : 0, credit: opening < 0 ? -opening : 0, balance: opening }, ...rows],
        totals: sum(rows, ['debit', 'credit']),
        summary: [
            { label: 'Opening', value: fmt(opening), type: 'text' },
            { label: 'Total Debit', value: sum(rows, ['debit']).debit, type: 'money' },
            { label: 'Total Credit', value: sum(rows, ['credit']).credit, type: 'money' },
            { label: 'Closing', value: fmt(closing), type: 'text' },
        ],
    };
}
async function itemPnl(ctx, p, byParty = false) {
    const groupKey = byParty ? '$partyName' : { $ifNull: ['$items.item', '$items.name'] };
    const rows = await Transaction.aggregate([
        { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'SALE_RETURN'] }, ...dateMatch(p), ...(p.party ? { party: p.party } : {}) } },
        { $unwind: '$items' },
        ...(p.item ? [{ $match: { 'items.item': p.item } }] : []),
        {
            $project: {
                key: groupKey,
                name: byParty ? { $ifNull: ['$partyName', 'Cash'] } : '$items.name',
                sign: { $cond: [{ $eq: ['$type', 'SALE'] }, 1, -1] },
                qty: '$items.qty',
                taxable: { $subtract: ['$items.amount', '$items.taxAmount'] },
                cost: { $multiply: ['$items.baseQty', '$items.costPrice'] },
            },
        },
        {
            $group: {
                _id: '$key',
                name: { $first: '$name' },
                qty: { $sum: { $multiply: ['$sign', '$qty'] } },
                sales: { $sum: { $multiply: ['$sign', '$taxable'] } },
                cost: { $sum: { $multiply: ['$sign', '$cost'] } },
            },
        },
        { $sort: { sales: -1 } },
    ]);
    const out = rows.map((r) => ({ name: r.name, qty: round2(r.qty), sales: round2(r.sales), cost: round2(r.cost), profit: round2(r.sales - r.cost), margin: r.sales ? round2(((r.sales - r.cost) / r.sales) * 100) : 0 }));
    const totals = sum(out, ['qty', 'sales', 'cost', 'profit']);
    return {
        columns: [col('name', byParty ? 'Party' : 'Item Name', 'text', 30), ...(byParty ? [] : [col('qty', 'Qty Sold', 'number')]), col('sales', 'Sale Amount (ex. tax)', 'money'), col('cost', 'Purchase Cost', 'money'), col('profit', 'Profit', 'money'), col('margin', 'Margin', 'percent')],
        rows: out,
        totals,
        summary: [
            { label: 'Sales', value: totals.sales, type: 'money' },
            { label: 'Cost', value: totals.cost, type: 'money' },
            { label: 'Profit', value: totals.profit, type: 'money' },
        ],
    };
}
async function profitLoss(ctx, p) {
    const sums = await Transaction.aggregate([
        { $match: { company: ctx.companyId, ...live, ...dateMatch(p), type: { $in: ['SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN', 'EXPENSE', 'PAYMENT_IN', 'PAYMENT_OUT'] } } },
        { $lookup: { from: 'expensecategories', localField: 'expenseCategory', foreignField: '_id', as: 'cat' } },
        { $group: { _id: { type: '$type', kind: { $first: '$cat.kind' } }, total: { $sum: '$total' }, tax: { $sum: '$taxTotal' }, charges: { $sum: { $sum: '$additionalCharges.amount' } } } },
    ]);
    const get = (type, kind) => sums.filter((s) => s._id.type === type && (!kind || s._id.kind === kind)).reduce((a, s) => ({ total: a.total + s.total, tax: a.tax + s.tax }), { total: 0, tax: 0 });
    const sale = get('SALE'), saleRet = get('SALE_RETURN'), pur = get('PURCHASE'), purRet = get('PURCHASE_RETURN');
    const direct = get('EXPENSE', 'direct').total;
    const indirect = sums.filter((s) => s._id.type === 'EXPENSE' && s._id.kind !== 'direct').reduce((a, s) => a + s.total, 0);
    const [openingStock, closingStock, newItems] = await Promise.all([
        p.from ? stockAsOf(ctx.companyId, p.from, true) : Promise.resolve([]),
        stockAsOf(ctx.companyId, p.to),
        // Opening stock of items first stocked inside the period counts as stock brought in.
        Item.find({ company: ctx.companyId, type: 'product', ...(p.from || p.to ? { openingDate: { ...(p.from ? { $gte: p.from } : {}), ...(p.to ? { $lte: p.to } : {}) } } : {}) }).select('openingQty openingPrice').lean(),
    ]);
    const openingValue = round2(openingStock.reduce((s, i) => s + i.value, 0) + newItems.reduce((s, i) => s + Math.max(0, i.openingQty) * (i.openingPrice ?? 0), 0));
    const closingValue = round2(closingStock.reduce((s, i) => s + i.value, 0));
    const netSale = round2(sale.total - sale.tax - (saleRet.total - saleRet.tax));
    const netPurchase = round2(pur.total - pur.tax - (purRet.total - purRet.tax));
    const gross = round2(netSale - netPurchase - direct + closingValue - openingValue);
    const loanCost = await loanCosts(ctx.companyId, { ...(p.from ? { $gte: p.from } : {}), ...(p.to ? { $lte: p.to } : {}) });
    const net = round2(gross - indirect - loanCost);
    const rows = [
        { particular: 'Sale (+)', amount: round2(sale.total - sale.tax), section: 'income' },
        { particular: 'Credit Note / Sale Return (−)', amount: -round2(saleRet.total - saleRet.tax), section: 'income' },
        { particular: 'Purchase (−)', amount: -round2(pur.total - pur.tax), section: 'cost' },
        { particular: 'Debit Note / Purchase Return (+)', amount: round2(purRet.total - purRet.tax), section: 'cost' },
        { particular: 'Direct Expenses (−)', amount: -round2(direct), section: 'cost' },
        { particular: 'Opening Stock (−)', amount: -openingValue, section: 'stock' },
        { particular: 'Closing Stock (+)', amount: closingValue, section: 'stock' },
        { particular: 'Gross Profit', amount: gross, section: 'result', strong: true },
        { particular: 'Indirect Expenses (−)', amount: -round2(indirect), section: 'cost' },
        ...(loanCost ? [{ particular: 'Loan Interest & Charges (−)', amount: -loanCost, section: 'cost' }] : []),
        { particular: 'Net Profit', amount: net, section: 'result', strong: true },
        { particular: 'Tax collected on sales (for reference)', amount: round2(sale.tax - saleRet.tax), section: 'info' },
        { particular: 'Tax paid on purchases (for reference)', amount: round2(pur.tax - purRet.tax), section: 'info' },
    ];
    return {
        columns: [col('particular', 'Particulars', 'text', 40), col('amount', 'Amount', 'money')],
        rows,
        summary: [
            { label: 'Net Sales', value: netSale, type: 'money' },
            { label: 'Gross Profit', value: gross, type: 'money' },
            { label: net >= 0 ? 'Net Profit' : 'Net Loss', value: net, type: 'money' },
        ],
    };
}
async function balanceSheet(ctx, p) {
    const asOf = p.to ?? new Date();
    const [accounts, stock, partyBal, loans] = await Promise.all([
        accountBalances(ctx.companyId, asOf),
        stockAsOf(ctx.companyId, asOf),
        Transaction.aggregate([
            { $match: { company: ctx.companyId, ...live, party: { $ne: null }, date: { $lte: asOf } } },
            { $group: { _id: '$party', sum: { $sum: partyEffectExpr } } },
        ]),
        loanBalances(ctx.companyId, asOf),
    ]);
    const parties = await Party.find({ company: ctx.companyId }).select('openingBalance openingBalanceDate').lean();
    const m = new Map(partyBal.map((x) => [String(x._id), x.sum]));
    let receivable = 0;
    let payable = 0;
    for (const party of parties) {
        const b = (party.openingBalanceDate && party.openingBalanceDate > asOf ? 0 : party.openingBalance ?? 0) + (m.get(String(party._id)) ?? 0);
        if (b > 0)
            receivable += b;
        else
            payable += -b;
    }
    const cash = accounts.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0);
    const bank = accounts.filter((a) => a.kind !== 'cash').reduce((s, a) => s + a.balance, 0);
    const stockValue = stock.reduce((s, i) => s + i.value, 0);
    const assets = round2(cash + bank + receivable + stockValue);
    const owedLoans = loans.filter((l) => Math.abs(l.balance) >= 0.005);
    const liabilities = round2(payable + owedLoans.reduce((s, l) => s + l.balance, 0));
    const rows = [
        { section: 'Assets', particular: 'Cash in hand', amount: round2(cash) },
        ...accounts.filter((a) => a.kind !== 'cash').map((a) => ({ section: 'Assets', particular: `Bank: ${a.name}`, amount: a.balance })),
        { section: 'Assets', particular: 'Sundry Debtors (Receivables)', amount: round2(receivable) },
        { section: 'Assets', particular: 'Closing Stock', amount: round2(stockValue) },
        { section: 'Assets', particular: 'Total Assets', amount: assets, strong: true },
        { section: 'Liabilities', particular: 'Sundry Creditors (Payables)', amount: round2(payable) },
        ...owedLoans.map((l) => ({ section: 'Liabilities', particular: `Loan: ${l.name}`, amount: l.balance })),
        { section: 'Liabilities', particular: "Owner's Capital & Retained Earnings", amount: round2(assets - liabilities) },
        { section: 'Liabilities', particular: 'Total Liabilities & Equity', amount: assets, strong: true },
    ];
    return {
        subtitle: `As of ${asOf.toLocaleDateString('en-IN')}`,
        columns: [col('section', 'Section'), col('particular', 'Particulars', 'text', 40), col('amount', 'Amount', 'money')],
        rows,
        summary: [
            { label: 'Total Assets', value: assets, type: 'money' },
            { label: 'Liabilities', value: liabilities, type: 'money' },
            { label: 'Net Worth', value: round2(assets - liabilities), type: 'money' },
        ],
    };
}
/** VAT sales (Mushak 6.2) or purchase (Mushak 6.1) register: one row per invoice and VAT rate. */
async function vatRegister(ctx, p, side) {
    const types = side === 'sale' ? ['SALE', 'SALE_RETURN'] : ['PURCHASE', 'PURCHASE_RETURN'];
    const rows = await Transaction.aggregate([
        { $match: { company: ctx.companyId, ...live, type: { $in: types }, ...dateMatch(p) } },
        { $lookup: { from: 'parties', localField: 'party', foreignField: '_id', as: 'p' } },
        { $unwind: '$items' },
        {
            $group: {
                _id: { t: '$_id', rate: '$items.taxRate' },
                type: { $first: '$type' }, number: { $first: '$number' }, date: { $first: '$date' }, party: { $first: '$partyName' },
                gstin: { $first: { $first: '$p.gstin' } }, total: { $first: '$total' },
                taxable: { $sum: { $subtract: ['$items.amount', '$items.taxAmount'] } }, tax: { $sum: '$items.taxAmount' },
            },
        },
        { $sort: { date: 1, number: 1 } },
    ]);
    const out = rows.map((r) => {
        const sign = String(r.type).endsWith('RETURN') ? -1 : 1;
        return {
            _id: r._id.t, txnType: r.type, gstin: r.gstin ?? '', party: r.party ?? '', number: r.number, date: r.date, type: label(r.type),
            rate: r._id.rate, taxable: round2(sign * r.taxable), vat: round2(sign * r.tax), invoiceValue: round2(sign * r.total),
        };
    });
    const totals = sum(out, ['taxable', 'vat']);
    return {
        columns: [col('gstin', side === 'sale' ? 'Buyer BIN' : 'Supplier BIN'), col('party', 'Party Name', 'text', 26), col('number', 'Invoice No.'), col('date', 'Date', 'date'), col('type', 'Type'), col('invoiceValue', 'Invoice Value', 'money'), col('rate', 'VAT Rate %', 'percent'), col('taxable', 'Taxable Value', 'money'), col('vat', 'VAT', 'money')],
        rows: out,
        totals,
        summary: [
            { label: 'Taxable Value', value: totals.taxable, type: 'money' },
            { label: side === 'sale' ? 'Output VAT' : 'Input VAT', value: totals.vat, type: 'money' },
        ],
    };
}
/* ---------------- definitions ---------------- */
export const REPORTS = [
    {
        key: 'sale', title: 'Sale Report', group: 'Transaction', description: 'All sale invoices and credit notes with received and balance amounts',
        filters: ['dateRange', 'party', 'user'], permission: 'sale_invoice.view',
        run: txnListReport(['SALE', 'SALE_RETURN'], { settledLabel: 'Received' }),
    },
    {
        key: 'purchase', title: 'Purchase Report', group: 'Transaction', description: 'All purchase bills and debit notes with paid and balance amounts',
        filters: ['dateRange', 'party', 'user'], permission: 'purchase_bill.view',
        run: txnListReport(['PURCHASE', 'PURCHASE_RETURN'], { settledLabel: 'Paid' }),
    },
    {
        key: 'day-book', title: 'Day Book', group: 'Transaction', description: 'Every transaction of the selected period with money in and money out',
        filters: ['dateRange', 'txnType', 'user'],
        run: async (ctx, p) => {
            const match = { company: ctx.companyId, ...live, ...dateMatch(p) };
            if (p.type?.length)
                match.type = { $in: p.type };
            if (p.user)
                match.createdBy = p.user;
            const docs = await Transaction.find(match).sort({ date: 1, createdAt: 1 }).populate('createdBy', 'name').lean();
            const rows = docs.map((d) => {
                const cfg = TXN_CONFIG[d.type];
                const moved = cfg.isPayment ? d.total : d.settled;
                return {
                    _id: d._id, txnType: d.type, date: d.date, number: d.number, party: d.partyName ?? '', type: cfg.label, total: d.total,
                    moneyIn: cfg.cash > 0 ? moved : 0, moneyOut: cfg.cash < 0 ? moved : 0, by: d.createdBy?.name ?? '',
                };
            });
            const totals = sum(rows, ['total', 'moneyIn', 'moneyOut']);
            return {
                columns: [col('date', 'Date', 'date'), col('number', 'Ref No.'), col('party', 'Name', 'text', 26), col('type', 'Type'), col('total', 'Total', 'money'), col('moneyIn', 'Money In', 'money'), col('moneyOut', 'Money Out', 'money'), col('by', 'Created By')],
                rows,
                totals,
                summary: [
                    { label: 'Money In', value: totals.moneyIn, type: 'money' },
                    { label: 'Money Out', value: totals.moneyOut, type: 'money' },
                    { label: 'Net', value: round2(totals.moneyIn - totals.moneyOut), type: 'money' },
                ],
            };
        },
    },
    {
        key: 'all-transactions', title: 'All Transactions', group: 'Transaction', description: 'Filter every document by type, party, date and status',
        filters: ['dateRange', 'txnType', 'party', 'user'],
        run: txnListReport([...TXN_TYPES], { settledLabel: 'Received / Paid' }),
    },
    { key: 'profit-loss', title: 'Profit & Loss', group: 'Transaction', description: 'Income statement with gross and net profit including stock movement', filters: ['dateRange'], run: profitLoss },
    {
        key: 'bill-wise-profit', title: 'Bill Wise Profit', group: 'Transaction', description: 'Profit earned on every sale invoice',
        filters: ['dateRange', 'party'],
        run: async (ctx, p) => {
            const docs = await Transaction.find({ company: ctx.companyId, ...live, type: 'SALE', ...dateMatch(p), ...(p.party ? { party: p.party } : {}) }).sort({ date: 1 }).lean();
            const rows = docs.map((d) => {
                const sales = round2(d.total - d.taxTotal);
                const cost = round2(d.items.reduce((s, l) => s + (l.baseQty ?? 0) * (l.costPrice ?? 0), 0));
                return { _id: d._id, txnType: d.type, date: d.date, number: d.number, party: d.partyName ?? '', sales, cost, profit: round2(sales - cost), margin: sales ? round2(((sales - cost) / sales) * 100) : 0 };
            });
            const totals = sum(rows, ['sales', 'cost', 'profit']);
            return {
                columns: [col('date', 'Date', 'date'), col('number', 'Invoice No.'), col('party', 'Party', 'text', 26), col('sales', 'Sale Amount (ex. tax)', 'money'), col('cost', 'Cost', 'money'), col('profit', 'Profit', 'money'), col('margin', 'Margin', 'percent')],
                rows, totals,
                summary: [{ label: 'Sales', value: totals.sales, type: 'money' }, { label: 'Profit', value: totals.profit, type: 'money' }],
            };
        },
    },
    {
        key: 'cash-flow', title: 'Cash Flow', group: 'Transaction', description: 'Money in and out of cash & bank accounts with running balance',
        filters: ['dateRange', 'account'], permission: 'cash_bank.view',
        run: async (ctx, p) => {
            const accounts = await BankAccount.find({ company: ctx.companyId, ...(p.account ? { _id: p.account } : {}) }).select('name').lean();
            const names = new Map(accounts.map((a) => [String(a._id), a.name]));
            // For all accounts together, money moved between them is neither in nor out
            const st = await accountStatement(ctx.companyId, accounts.map((a) => a._id), { ...(p.from ? { $gte: p.from } : {}), ...(p.to ? { $lte: p.to } : {}) }, { skipInternal: !p.account });
            const rows = st.rows.map((m) => ({
                _id: m.link?.id ?? m._id, txnType: m.link?.type, date: m.date, number: m.number, party: m.party, type: m.label, account: names.get(m.account) ?? '',
                cashIn: m.amount > 0 ? m.amount : 0, cashOut: m.amount < 0 ? -m.amount : 0, balance: m.balance,
            }));
            return {
                columns: [col('date', 'Date', 'date'), col('number', 'Ref No.'), col('party', 'Name', 'text', 24), col('type', 'Type'), col('account', 'Account'), col('cashIn', 'Cash In', 'money'), col('cashOut', 'Cash Out', 'money'), col('balance', 'Running Balance', 'money')],
                rows,
                totals: { cashIn: st.moneyIn, cashOut: st.moneyOut },
                summary: [
                    { label: 'Opening', value: st.opening, type: 'money' }, { label: 'Cash In', value: st.moneyIn, type: 'money' },
                    { label: 'Cash Out', value: st.moneyOut, type: 'money' }, { label: 'Closing', value: st.closing, type: 'money' },
                ],
                subtitle: p.account ? undefined : 'Transfers between your own accounts are left out',
            };
        },
    },
    { key: 'balance-sheet', title: 'Balance Sheet', group: 'Transaction', description: 'Assets, liabilities and net worth as of a date', filters: ['asOf'], run: balanceSheet },
    /* Party */
    { key: 'party-statement', title: 'Party Statement (Ledger)', group: 'Party', description: 'Debit, credit and running balance of one party', filters: ['dateRange', 'party'], required: ['party'], permission: 'parties.view', run: partyStatement },
    {
        key: 'all-parties', title: 'All Parties', group: 'Party', description: 'Receivable and payable balance of every party', filters: ['group'], permission: 'parties.view',
        run: async (ctx, p) => {
            const parties = await Party.find({ company: ctx.companyId, ...(p.group ? { group: p.group } : {}) }).populate('group', 'name').sort({ name: 1 }).collation({ locale: 'en' }).lean();
            const rows = parties.map((x) => ({
                _id: x._id, name: x.name, phone: x.phone ?? '', email: x.email ?? '', group: x.group?.name ?? '', gstin: x.gstin ?? '',
                receivable: x.balance > 0 ? x.balance : 0, payable: x.balance < 0 ? -x.balance : 0, creditLimit: x.creditLimit ?? '',
            }));
            const totals = sum(rows, ['receivable', 'payable']);
            return {
                columns: [col('name', 'Party Name', 'text', 28), col('phone', 'Phone'), col('email', 'Email'), col('group', 'Group'), col('gstin', 'BIN'), col('receivable', 'Receivable', 'money'), col('payable', 'Payable', 'money'), col('creditLimit', 'Credit Limit', 'money')],
                rows, totals,
                summary: [{ label: 'Total Receivable', value: totals.receivable, type: 'money' }, { label: 'Total Payable', value: totals.payable, type: 'money' }],
            };
        },
    },
    { key: 'party-wise-pnl', title: 'Party Wise Profit & Loss', group: 'Party', description: 'Sales, cost and profit per customer', filters: ['dateRange'], run: (ctx, p) => itemPnl(ctx, p, true) },
    {
        key: 'party-by-item', title: 'Party Report by Item', group: 'Party', description: 'Items sold to / bought from each party', filters: ['dateRange', 'party', 'item'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'PURCHASE'] }, ...dateMatch(p), ...(p.party ? { party: p.party } : {}) } },
                { $unwind: '$items' },
                ...(p.item ? [{ $match: { 'items.item': p.item } }] : []),
                {
                    $group: {
                        _id: { party: '$partyName', item: '$items.name' },
                        saleQty: { $sum: { $cond: [{ $eq: ['$type', 'SALE'] }, '$items.qty', 0] } },
                        saleAmount: { $sum: { $cond: [{ $eq: ['$type', 'SALE'] }, '$items.amount', 0] } },
                        purchaseQty: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE'] }, '$items.qty', 0] } },
                        purchaseAmount: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE'] }, '$items.amount', 0] } },
                    },
                },
                { $sort: { '_id.party': 1, '_id.item': 1 } },
            ]);
            const out = rows.map((r) => ({ party: r._id.party ?? 'Cash', item: r._id.item, saleQty: round2(r.saleQty), saleAmount: round2(r.saleAmount), purchaseQty: round2(r.purchaseQty), purchaseAmount: round2(r.purchaseAmount) }));
            return { columns: [col('party', 'Party', 'text', 24), col('item', 'Item', 'text', 24), col('saleQty', 'Sale Qty', 'number'), col('saleAmount', 'Sale Amount', 'money'), col('purchaseQty', 'Purchase Qty', 'number'), col('purchaseAmount', 'Purchase Amount', 'money')], rows: out, totals: sum(out, ['saleQty', 'saleAmount', 'purchaseQty', 'purchaseAmount']) };
        },
    },
    {
        key: 'sale-purchase-by-party', title: 'Sale / Purchase by Party', group: 'Party', description: 'Total sales and purchases per party', filters: ['dateRange', 'group'],
        run: async (ctx, p) => {
            const partyFilter = p.group ? (await Party.find({ company: ctx.companyId, group: p.group }).select('_id').lean()).map((x) => x._id) : null;
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN'] }, ...dateMatch(p), ...(partyFilter ? { party: { $in: partyFilter } } : {}) } },
                {
                    $group: {
                        _id: { $ifNull: ['$partyName', 'Cash'] },
                        sale: { $sum: { $switch: { branches: [{ case: { $eq: ['$type', 'SALE'] }, then: '$total' }, { case: { $eq: ['$type', 'SALE_RETURN'] }, then: { $multiply: ['$total', -1] } }], default: 0 } } },
                        purchase: { $sum: { $switch: { branches: [{ case: { $eq: ['$type', 'PURCHASE'] }, then: '$total' }, { case: { $eq: ['$type', 'PURCHASE_RETURN'] }, then: { $multiply: ['$total', -1] } }], default: 0 } } },
                    },
                },
                { $sort: { _id: 1 } },
            ]);
            const out = rows.map((r) => ({ party: r._id, sale: round2(r.sale), purchase: round2(r.purchase) }));
            return { columns: [col('party', 'Party Name', 'text', 30), col('sale', 'Sale Amount', 'money'), col('purchase', 'Purchase Amount', 'money')], rows: out, totals: sum(out, ['sale', 'purchase']) };
        },
    },
    {
        key: 'sale-purchase-by-group', title: 'Sale / Purchase by Party Group', group: 'Party', description: 'Totals per party group', filters: ['dateRange'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'PURCHASE'] }, ...dateMatch(p) } },
                { $lookup: { from: 'parties', localField: 'party', foreignField: '_id', as: 'p' } },
                { $group: { _id: { $first: '$p.group' }, sale: { $sum: { $cond: [{ $eq: ['$type', 'SALE'] }, '$total', 0] } }, purchase: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE'] }, '$total', 0] } } } },
            ]);
            const groups = new Map((await PartyGroup.find({ company: ctx.companyId }).lean()).map((g) => [String(g._id), g.name]));
            const out = rows.map((r) => ({ group: r._id ? (groups.get(String(r._id)) ?? 'Deleted group') : 'No group', sale: round2(r.sale), purchase: round2(r.purchase) })).sort((a, b) => a.group.localeCompare(b.group));
            return { columns: [col('group', 'Group', 'text', 30), col('sale', 'Sale Amount', 'money'), col('purchase', 'Purchase Amount', 'money')], rows: out, totals: sum(out, ['sale', 'purchase']) };
        },
    },
    {
        key: 'receivable-ageing', title: 'Receivable Ageing', group: 'Party', description: 'Outstanding sale invoices bucketed by days overdue', filters: ['party'],
        run: async (ctx, p) => {
            const now = Date.now();
            const docs = await Transaction.find({ company: ctx.companyId, type: 'SALE', status: { $in: ['UNPAID', 'PARTIAL'] }, ...(p.party ? { party: p.party } : {}) }).select('partyName party date dueDate balance').lean();
            const map = new Map();
            for (const d of docs) {
                const key = String(d.party ?? d.partyName);
                const row = map.get(key) ?? { party: d.partyName ?? 'Cash', current: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0 };
                const days = Math.floor((now - new Date(d.dueDate ?? d.date).getTime()) / 86400000);
                const bucket = days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'd90p';
                row[bucket] = round2(row[bucket] + d.balance);
                row.total = round2(row.total + d.balance);
                map.set(key, row);
            }
            const rows = [...map.values()].sort((a, b) => b.total - a.total);
            return {
                columns: [col('party', 'Party', 'text', 28), col('current', 'Not Due', 'money'), col('d30', '1-30 Days', 'money'), col('d60', '31-60 Days', 'money'), col('d90', '61-90 Days', 'money'), col('d90p', '90+ Days', 'money'), col('total', 'Total Due', 'money')],
                rows, totals: sum(rows, ['current', 'd30', 'd60', 'd90', 'd90p', 'total']),
            };
        },
    },
    /* Item / stock */
    {
        key: 'stock-summary', title: 'Stock Summary', group: 'Item / Stock', description: 'Stock quantity and value of every item as of a date', filters: ['asOf', 'category'], permission: 'items.view',
        run: async (ctx, p) => {
            const items = (await stockAsOf(ctx.companyId, p.to)).filter((i) => !p.category || String(i.category?._id) === String(p.category));
            const rows = items.map((i) => ({ _id: i._id, name: i.name, category: i.category?.name ?? '', salePrice: i.salePrice, purchasePrice: i.purchasePrice, qty: i.qty, unit: i.baseUnit?.shortName ?? '', value: i.value }));
            rows.sort((a, b) => a.name.localeCompare(b.name));
            const totals = sum(rows, ['qty', 'value']);
            return {
                columns: [col('name', 'Item Name', 'text', 30), col('category', 'Category'), col('salePrice', 'Sale Price', 'money'), col('purchasePrice', 'Purchase Price', 'money'), col('qty', 'Stock Qty', 'number'), col('unit', 'Unit'), col('value', 'Stock Value', 'money')],
                rows, totals, summary: [{ label: 'Items', value: rows.length, type: 'number' }, { label: 'Stock Value', value: totals.value, type: 'money' }],
            };
        },
    },
    { key: 'item-wise-pnl', title: 'Item Wise Profit & Loss', group: 'Item / Stock', description: 'Quantity sold, sales, cost and profit per item', filters: ['dateRange', 'party'], run: (ctx, p) => itemPnl(ctx, p) },
    {
        key: 'low-stock', title: 'Low Stock Summary', group: 'Item / Stock', description: 'Items at or below their minimum stock level', filters: ['category'], permission: 'items.view',
        run: async (ctx, p) => {
            const items = await Item.find({ company: ctx.companyId, type: 'product', minStock: { $gt: 0 }, $expr: { $lte: ['$stock', '$minStock'] }, ...(p.category ? { category: p.category } : {}) }).populate('category', 'name').populate('baseUnit', 'shortName').sort({ name: 1 }).lean();
            const rows = items.map((i) => ({ _id: i._id, name: i.name, category: i.category?.name ?? '', minStock: i.minStock, stock: i.stock, unit: i.baseUnit?.shortName ?? '', shortBy: round2(i.minStock - i.stock), value: round2(Math.max(0, i.stock) * i.purchasePrice) }));
            return { columns: [col('name', 'Item Name', 'text', 30), col('category', 'Category'), col('minStock', 'Min Stock', 'number'), col('stock', 'Current Stock', 'number'), col('unit', 'Unit'), col('shortBy', 'Short By', 'number'), col('value', 'Stock Value', 'money')], rows };
        },
    },
    {
        key: 'item-details', title: 'Item Details (Stock Ledger)', group: 'Item / Stock', description: 'Every stock movement of one item with running quantity', filters: ['dateRange', 'item'], required: ['item'], permission: 'items.view',
        run: async (ctx, p) => {
            const item = await Item.findOne({ _id: p.item, company: ctx.companyId }).lean();
            if (!item)
                throw AppError.notFound('Item');
            const [txns, adjs] = await Promise.all([
                Transaction.aggregate([
                    { $match: { company: ctx.companyId, ...live, 'items.item': item._id, type: { $in: TXN_TYPES.filter((t) => TXN_CONFIG[t].stock !== 0) } } },
                    { $unwind: '$items' },
                    { $match: { 'items.item': item._id } },
                    { $project: { date: 1, type: 1, number: 1, partyName: 1, createdAt: 1, qty: { $multiply: [stockSignExpr, '$items.baseQty'] }, price: '$items.price' } },
                ]),
                StockAdjustment.find({ company: ctx.companyId, item: item._id }).lean(),
            ]);
            const moves = [
                { date: item.openingDate ?? item.createdAt, type: 'Opening Stock', number: '', party: '', qty: item.openingQty, price: item.openingPrice, _id: undefined, txnType: undefined },
                ...txns.map((t) => ({ _id: t._id, txnType: t.type, date: t.date, type: label(t.type), number: t.number, party: t.partyName ?? '', qty: t.qty, price: t.price })),
                ...adjs.map((a) => ({ _id: undefined, txnType: undefined, date: a.date, type: a.kind === 'add' ? 'Add Stock' : 'Reduce Stock', number: '', party: a.details ?? '', qty: a.kind === 'add' ? a.qty : -a.qty, price: a.price })),
            ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
            let running = 0;
            const rows = moves.map((m) => ({ ...m, qtyIn: m.qty > 0 ? round2(m.qty) : 0, qtyOut: m.qty < 0 ? round2(-m.qty) : 0, closing: round2((running += m.qty)) }))
                .filter((r) => (!p.from || new Date(r.date) >= p.from) && (!p.to || new Date(r.date) <= p.to));
            return { subtitle: item.name, columns: [col('date', 'Date', 'date'), col('type', 'Type'), col('number', 'Ref No.'), col('party', 'Party / Details', 'text', 24), col('price', 'Price', 'money'), col('qtyIn', 'Qty In', 'number'), col('qtyOut', 'Qty Out', 'number'), col('closing', 'Closing Qty', 'number')], rows, totals: sum(rows, ['qtyIn', 'qtyOut']) };
        },
    },
    {
        key: 'stock-detail', title: 'Stock Detail', group: 'Item / Stock', description: 'Opening, in, out and closing quantity per item for a period', filters: ['dateRange', 'category'], permission: 'items.view',
        run: async (ctx, p) => {
            const [opening, closing] = await Promise.all([p.from ? stockAsOf(ctx.companyId, p.from, true) : Promise.resolve(null), stockAsOf(ctx.companyId, p.to)]);
            const inOut = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, ...dateMatch(p), type: { $in: TXN_TYPES.filter((t) => TXN_CONFIG[t].stock !== 0) } } },
                { $unwind: '$items' },
                { $project: { item: '$items.item', q: { $multiply: [stockSignExpr, '$items.baseQty'] } } },
                { $group: { _id: '$item', in: { $sum: { $cond: [{ $gt: ['$q', 0] }, '$q', 0] } }, out: { $sum: { $cond: [{ $lt: ['$q', 0] }, { $abs: '$q' }, 0] } } } },
            ]);
            const io = new Map(inOut.map((x) => [String(x._id), x]));
            const op = new Map((opening ?? []).map((x) => [String(x._id), x.qty]));
            const rows = closing
                .filter((i) => !p.category || String(i.category?._id) === String(p.category))
                .map((i) => {
                const begin = opening ? (op.get(String(i._id)) ?? 0) : 0;
                return { _id: i._id, name: i.name, opening: round2(begin), qtyIn: round2(io.get(String(i._id))?.in ?? 0), qtyOut: round2(io.get(String(i._id))?.out ?? 0), closing: i.qty, value: i.value };
            })
                .sort((a, b) => a.name.localeCompare(b.name));
            return { columns: [col('name', 'Item Name', 'text', 30), col('opening', 'Beginning Qty', 'number'), col('qtyIn', 'Qty In', 'number'), col('qtyOut', 'Qty Out', 'number'), col('closing', 'Closing Qty', 'number'), col('value', 'Closing Value', 'money')], rows, totals: sum(rows, ['value']) };
        },
    },
    {
        key: 'sale-purchase-by-category', title: 'Sale / Purchase by Item Category', group: 'Item / Stock', description: 'Quantities and amounts grouped by item category', filters: ['dateRange'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'PURCHASE'] }, ...dateMatch(p) } },
                { $unwind: '$items' },
                { $lookup: { from: 'items', localField: 'items.item', foreignField: '_id', as: 'it' } },
                {
                    $group: {
                        _id: { $first: '$it.category' },
                        saleQty: { $sum: { $cond: [{ $eq: ['$type', 'SALE'] }, '$items.qty', 0] } }, saleAmount: { $sum: { $cond: [{ $eq: ['$type', 'SALE'] }, '$items.amount', 0] } },
                        purchaseQty: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE'] }, '$items.qty', 0] } }, purchaseAmount: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE'] }, '$items.amount', 0] } },
                    },
                },
            ]);
            const cats = new Map((await Category.find({ company: ctx.companyId }).lean()).map((c) => [String(c._id), c.name]));
            const out = rows.map((r) => ({ category: r._id ? (cats.get(String(r._id)) ?? '—') : 'Uncategorised', saleQty: round2(r.saleQty), saleAmount: round2(r.saleAmount), purchaseQty: round2(r.purchaseQty), purchaseAmount: round2(r.purchaseAmount) }));
            return { columns: [col('category', 'Category', 'text', 26), col('saleQty', 'Sale Qty', 'number'), col('saleAmount', 'Sale Amount', 'money'), col('purchaseQty', 'Purchase Qty', 'number'), col('purchaseAmount', 'Purchase Amount', 'money')], rows: out, totals: sum(out, ['saleQty', 'saleAmount', 'purchaseQty', 'purchaseAmount']) };
        },
    },
    {
        key: 'item-discount', title: 'Item Wise Discount', group: 'Item / Stock', description: 'Discount given on each item in sales', filters: ['dateRange', 'party'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: 'SALE', ...dateMatch(p), ...(p.party ? { party: p.party } : {}) } },
                { $unwind: '$items' },
                { $group: { _id: '$items.name', qty: { $sum: '$items.qty' }, gross: { $sum: { $multiply: ['$items.qty', '$items.price'] } }, discount: { $sum: '$items.discountAmount' } } },
                { $sort: { discount: -1 } },
            ]);
            const out = rows.map((r) => ({ item: r._id, qty: round2(r.qty), gross: round2(r.gross), discount: round2(r.discount), avg: r.gross ? round2((r.discount / r.gross) * 100) : 0 }));
            return { columns: [col('item', 'Item', 'text', 30), col('qty', 'Qty Sold', 'number'), col('gross', 'Gross Amount', 'money'), col('discount', 'Discount', 'money'), col('avg', 'Avg Discount', 'percent')], rows: out, totals: sum(out, ['qty', 'gross', 'discount']) };
        },
    },
    /* Business status */
    {
        key: 'bank-statement', title: 'Bank Statement', group: 'Business Status', description: 'Movements of a cash or bank account', filters: ['dateRange', 'account'], required: ['account'], permission: 'cash_bank.view',
        run: async (ctx, p) => {
            const acc = await BankAccount.findOne({ _id: p.account, company: ctx.companyId }).lean();
            if (!acc)
                throw AppError.notFound('Account');
            const cashFlow = REPORTS.find((r) => r.key === 'cash-flow');
            const r = await cashFlow.run(ctx, p);
            return { ...r, subtitle: `${acc.name}${acc.accountNumber ? ` · A/c ${acc.accountNumber}` : ''}` };
        },
    },
    {
        key: 'loan-statement', title: 'Loan Statement', group: 'Business Status', description: 'Loan taken, EMIs split into principal and interest, and what is still owed', filters: ['dateRange', 'loan'], required: ['loan'], permission: 'cash_bank.view',
        run: async (ctx, p) => {
            const loan = await LoanAccount.findOne({ _id: p.loan, company: ctx.companyId }).lean();
            if (!loan)
                throw AppError.notFound('Loan');
            const all = await loanStatementRows(ctx.companyId, loan._id);
            const rows = all
                .filter((r) => (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to))
                .map((r) => ({ _id: r._id, date: r.date, label: r.label, account: r.account?.name ?? '', description: r.description ?? '', principal: r.principal, interest: r.interest, amount: r.amount, balance: r.balance }));
            const totals = sum(rows, ['principal', 'interest']);
            return {
                columns: [col('date', 'Date', 'date'), col('label', 'Type'), col('account', 'Paid / received in'), col('description', 'Note', 'text', 24), col('amount', 'Amount', 'money'), col('principal', 'Principal', 'money'), col('interest', 'Interest', 'money'), col('balance', 'Still Owed', 'money')],
                rows,
                totals,
                summary: [
                    { label: 'Principal repaid', value: totals.principal, type: 'money' },
                    { label: 'Interest paid', value: totals.interest, type: 'money' },
                    { label: 'Still owed', value: all.length ? all[all.length - 1].balance : 0, type: 'money' },
                ],
                subtitle: [loan.name, loan.lender, loan.accountNumber && `A/c ${loan.accountNumber}`].filter(Boolean).join(' · '),
            };
        },
    },
    {
        key: 'discount', title: 'Discount Report', group: 'Business Status', description: 'Item and bill discounts allowed and received per party', filters: ['dateRange'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'PURCHASE'] }, ...dateMatch(p) } },
                {
                    $group: {
                        _id: { $ifNull: ['$partyName', 'Cash'] },
                        saleDiscount: { $sum: { $cond: [{ $eq: ['$type', 'SALE'] }, { $add: ['$itemDiscount', '$discountAmount'] }, 0] } },
                        purchaseDiscount: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE'] }, { $add: ['$itemDiscount', '$discountAmount'] }, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]);
            const out = rows.map((r) => ({ party: r._id, saleDiscount: round2(r.saleDiscount), purchaseDiscount: round2(r.purchaseDiscount) })).filter((r) => r.saleDiscount || r.purchaseDiscount);
            return { columns: [col('party', 'Party', 'text', 30), col('saleDiscount', 'Sale Discount (allowed)', 'money'), col('purchaseDiscount', 'Purchase Discount (received)', 'money')], rows: out, totals: sum(out, ['saleDiscount', 'purchaseDiscount']) };
        },
    },
    /* Taxes */
    { key: 'vat-sales', title: 'VAT Sales Register (Mushak 6.2)', group: 'Taxes', description: 'Sales with buyer BIN, taxable value and output VAT per rate', filters: ['dateRange'], run: (ctx, p) => vatRegister(ctx, p, 'sale') },
    { key: 'vat-purchases', title: 'VAT Purchase Register (Mushak 6.1)', group: 'Taxes', description: 'Purchases with supplier BIN, taxable value and input VAT per rate', filters: ['dateRange'], run: (ctx, p) => vatRegister(ctx, p, 'purchase') },
    {
        key: 'tax-rate', title: 'Tax Rate Report', group: 'Taxes', description: 'Taxable value and tax in/out per tax rate', filters: ['dateRange'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN'] }, ...dateMatch(p) } },
                { $unwind: '$items' },
                {
                    $project: {
                        rate: '$items.taxRate',
                        sign: { $cond: [{ $in: ['$type', ['SALE', 'PURCHASE']] }, 1, -1] },
                        side: { $cond: [{ $in: ['$type', ['SALE', 'SALE_RETURN']] }, 'sale', 'purchase'] },
                        taxable: { $subtract: ['$items.amount', '$items.taxAmount'] },
                        tax: '$items.taxAmount',
                    },
                },
                {
                    $group: {
                        _id: '$rate',
                        saleTaxable: { $sum: { $cond: [{ $eq: ['$side', 'sale'] }, { $multiply: ['$sign', '$taxable'] }, 0] } },
                        taxIn: { $sum: { $cond: [{ $eq: ['$side', 'sale'] }, { $multiply: ['$sign', '$tax'] }, 0] } },
                        purchaseTaxable: { $sum: { $cond: [{ $eq: ['$side', 'purchase'] }, { $multiply: ['$sign', '$taxable'] }, 0] } },
                        taxOut: { $sum: { $cond: [{ $eq: ['$side', 'purchase'] }, { $multiply: ['$sign', '$tax'] }, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]);
            const out = rows.map((r) => ({ rate: r._id, saleTaxable: round2(r.saleTaxable), taxIn: round2(r.taxIn), purchaseTaxable: round2(r.purchaseTaxable), taxOut: round2(r.taxOut), net: round2(r.taxIn - r.taxOut) }));
            const totals = sum(out, ['saleTaxable', 'taxIn', 'purchaseTaxable', 'taxOut', 'net']);
            return {
                columns: [col('rate', 'Tax Rate', 'percent'), col('saleTaxable', 'Taxable Sale', 'money'), col('taxIn', 'Tax In (collected)', 'money'), col('purchaseTaxable', 'Taxable Purchase', 'money'), col('taxOut', 'Tax Out (paid)', 'money'), col('net', 'Net Tax Payable', 'money')],
                rows: out, totals, summary: [{ label: 'Tax collected', value: totals.taxIn, type: 'money' }, { label: 'Tax paid', value: totals.taxOut, type: 'money' }, { label: 'Net payable', value: totals.net, type: 'money' }],
            };
        },
    },
    {
        key: 'tax-by-party', title: 'Tax Report by Party', group: 'Taxes', description: 'Tax collected from and paid to each party', filters: ['dateRange'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: { $in: ['SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN'] }, ...dateMatch(p) } },
                {
                    $group: {
                        _id: { $ifNull: ['$partyName', 'Cash'] },
                        taxIn: { $sum: { $switch: { branches: [{ case: { $eq: ['$type', 'SALE'] }, then: '$taxTotal' }, { case: { $eq: ['$type', 'SALE_RETURN'] }, then: { $multiply: ['$taxTotal', -1] } }], default: 0 } } },
                        taxOut: { $sum: { $switch: { branches: [{ case: { $eq: ['$type', 'PURCHASE'] }, then: '$taxTotal' }, { case: { $eq: ['$type', 'PURCHASE_RETURN'] }, then: { $multiply: ['$taxTotal', -1] } }], default: 0 } } },
                    },
                },
                { $sort: { _id: 1 } },
            ]);
            const out = rows.map((r) => ({ party: r._id, taxIn: round2(r.taxIn), taxOut: round2(r.taxOut) }));
            return { columns: [col('party', 'Party', 'text', 30), col('taxIn', 'Sale Tax', 'money'), col('taxOut', 'Purchase Tax', 'money')], rows: out, totals: sum(out, ['taxIn', 'taxOut']) };
        },
    },
    /* Expense */
    { key: 'expense', title: 'Expense Report', group: 'Expense', description: 'All expenses with category, paid and balance', filters: ['dateRange', 'category'], permission: 'expense.view', run: txnListReport(['EXPENSE'], { settledLabel: 'Paid', withCategory: true }) },
    {
        key: 'expense-category', title: 'Expense Category Report', group: 'Expense', description: 'Total spent in each expense category', filters: ['dateRange'], permission: 'expense.view',
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: 'EXPENSE', ...dateMatch(p) } },
                { $group: { _id: '$expenseCategory', total: { $sum: '$total' }, count: { $sum: 1 } } },
            ]);
            const cats = new Map((await ExpenseCategory.find({ company: ctx.companyId }).lean()).map((c) => [String(c._id), c]));
            const out = rows.map((r) => ({ category: cats.get(String(r._id))?.name ?? '—', kind: cats.get(String(r._id))?.kind === 'direct' ? 'Direct' : 'Indirect', count: r.count, total: round2(r.total) })).sort((a, b) => b.total - a.total);
            return { columns: [col('category', 'Category', 'text', 30), col('kind', 'Type'), col('count', 'Entries', 'number'), col('total', 'Amount', 'money')], rows: out, totals: sum(out, ['count', 'total']) };
        },
    },
    {
        key: 'expense-item', title: 'Expense Item Report', group: 'Expense', description: 'Expense line items grouped by name', filters: ['dateRange', 'category'], permission: 'expense.view',
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, ...live, type: 'EXPENSE', ...dateMatch(p), ...(p.category ? { expenseCategory: p.category } : {}) } },
                { $unwind: '$items' },
                { $group: { _id: '$items.name', qty: { $sum: '$items.qty' }, amount: { $sum: '$items.amount' } } },
                { $sort: { amount: -1 } },
            ]);
            const out = rows.map((r) => ({ item: r._id, qty: round2(r.qty), amount: round2(r.amount) }));
            return { columns: [col('item', 'Expense Item', 'text', 30), col('qty', 'Qty', 'number'), col('amount', 'Amount', 'money')], rows: out, totals: sum(out, ['qty', 'amount']) };
        },
    },
    /* Orders */
    {
        key: 'sale-orders', title: 'Sale Order Report', group: 'Sale / Purchase Orders', description: 'Sale orders with status and linked invoices', filters: ['dateRange', 'party'], permission: 'sale_order.view',
        run: async (ctx, p) => orderReport(ctx, p, 'SALE_ORDER'),
    },
    {
        key: 'purchase-orders', title: 'Purchase Order Report', group: 'Sale / Purchase Orders', description: 'Purchase orders with status and linked bills', filters: ['dateRange', 'party'], permission: 'purchase_order.view',
        run: async (ctx, p) => orderReport(ctx, p, 'PURCHASE_ORDER'),
    },
    {
        key: 'order-items', title: 'Order Item Report', group: 'Sale / Purchase Orders', description: 'Quantities of items on open orders', filters: ['dateRange'],
        run: async (ctx, p) => {
            const rows = await Transaction.aggregate([
                { $match: { company: ctx.companyId, status: 'OPEN', type: { $in: ['SALE_ORDER', 'PURCHASE_ORDER'] }, ...dateMatch(p) } },
                { $unwind: '$items' },
                { $group: { _id: '$items.name', saleQty: { $sum: { $cond: [{ $eq: ['$type', 'SALE_ORDER'] }, '$items.qty', 0] } }, purchaseQty: { $sum: { $cond: [{ $eq: ['$type', 'PURCHASE_ORDER'] }, '$items.qty', 0] } }, amount: { $sum: '$items.amount' } } },
                { $sort: { _id: 1 } },
            ]);
            const out = rows.map((r) => ({ item: r._id, saleQty: round2(r.saleQty), purchaseQty: round2(r.purchaseQty), amount: round2(r.amount) }));
            return { columns: [col('item', 'Item', 'text', 30), col('saleQty', 'Qty on Sale Orders', 'number'), col('purchaseQty', 'Qty on Purchase Orders', 'number'), col('amount', 'Amount', 'money')], rows: out };
        },
    },
    /* HR */
    {
        key: 'attendance', title: 'Attendance Report', group: 'HR', description: 'Monthly attendance summary per employee', filters: ['month', 'employee'], permission: 'attendance.view',
        run: async (ctx, p) => {
            const month = p.month ?? zonedNow(ctx.settings.general.timezone).month;
            const emps = await Employee.find({ company: ctx.companyId, ...(p.employee ? { _id: p.employee } : {}) }).sort({ name: 1 }).lean();
            const att = await Attendance.aggregate([
                { $match: { company: ctx.companyId, day: { $regex: `^${month}` } } },
                { $group: { _id: { e: '$employee', s: '$status' }, n: { $sum: 1 } } },
            ]);
            const get = (e, s) => att.find((a) => String(a._id.e) === String(e) && a._id.s === s)?.n ?? 0;
            const rows = emps.map((e) => ({ name: e.name, designation: e.designation ?? '', present: get(e._id, 'present'), half: get(e._id, 'half_day'), absent: get(e._id, 'absent'), leave: get(e._id, 'leave'), holiday: get(e._id, 'holiday') }));
            return { subtitle: `Month: ${month}`, columns: [col('name', 'Employee', 'text', 26), col('designation', 'Designation'), col('present', 'Present', 'number'), col('half', 'Half Day', 'number'), col('absent', 'Absent', 'number'), col('leave', 'Leave', 'number'), col('holiday', 'Holiday', 'number')], rows };
        },
    },
    {
        key: 'salary', title: 'Salary Report', group: 'HR', description: 'Payroll of a month with deductions and net pay', filters: ['month', 'employee'], permission: 'payroll.view',
        run: async (ctx, p) => {
            const month = p.month ?? zonedNow(ctx.settings.general.timezone).month;
            const rows = (await Payroll.find({ company: ctx.companyId, month, ...(p.employee ? { employee: p.employee } : {}) }).populate('employee', 'name designation').lean()).map((r) => ({
                name: r.employee?.name ?? '', designation: r.employee?.designation ?? '', payableDays: r.payableDays ?? 0,
                basic: r.basic, earned: r.earned, allowances: r.allowances, bonus: r.bonus, deductions: r.deductions, advance: r.advanceDeduction, net: r.net, status: r.status === 'paid' ? 'Paid' : 'Draft',
            }));
            const totals = sum(rows, ['basic', 'earned', 'allowances', 'bonus', 'deductions', 'advance', 'net']);
            return {
                subtitle: `Month: ${month}`,
                columns: [col('name', 'Employee', 'text', 24), col('designation', 'Designation'), col('payableDays', 'Payable Days', 'number'), col('basic', 'Salary', 'money'), col('earned', 'Earned', 'money'), col('allowances', 'Allowances', 'money'), col('bonus', 'Bonus', 'money'), col('deductions', 'Deductions', 'money'), col('advance', 'Advance', 'money'), col('net', 'Net Pay', 'money'), col('status', 'Status')],
                rows, totals, summary: [{ label: 'Net payroll', value: totals.net, type: 'money' }],
            };
        },
    },
    {
        key: 'activity', title: 'User Activity Report', group: 'Audit', description: 'Who did what and when', filters: ['dateRange', 'user'], permission: 'audit.view',
        run: async (ctx, p) => {
            const logs = await AuditLog.find({ company: ctx.companyId, ...dateMatch(p, 'createdAt'), ...(p.user ? { user: p.user } : {}) }).sort({ createdAt: -1 }).limit(5000).lean();
            const rows = logs.map((l) => ({ date: l.createdAt, user: l.userName ?? '', action: l.action, entity: l.entity, label: l.label ?? '', ip: l.ip ?? '' }));
            return { columns: [col('date', 'Date', 'date'), col('user', 'User'), col('action', 'Action'), col('entity', 'Module'), col('label', 'Details', 'text', 50), col('ip', 'IP')], rows };
        },
    },
];
async function orderReport(ctx, p, type) {
    const docs = await Transaction.find({ company: ctx.companyId, type, ...dateMatch(p), ...(p.party ? { party: p.party } : {}) }).sort({ date: 1 }).lean();
    const rows = docs.map((d) => ({ _id: d._id, txnType: d.type, date: d.date, number: d.number, party: d.partyName ?? '', dueDate: d.dueDate, total: d.total, status: d.status, linked: d.links.map((l) => l.number).join(', ') }));
    return {
        columns: [col('date', 'Date', 'date'), col('number', 'Order No.'), col('party', 'Party', 'text', 26), col('dueDate', 'Due Date', 'date'), col('total', 'Total', 'money'), col('status', 'Status'), col('linked', 'Converted To')],
        rows, totals: sum(rows, ['total']),
        summary: [{ label: 'Open', value: rows.filter((r) => r.status === 'OPEN').length, type: 'number' }, { label: 'Converted', value: rows.filter((r) => r.status === 'CONVERTED').length, type: 'number' }],
    };
}
//# sourceMappingURL=engine.js.map