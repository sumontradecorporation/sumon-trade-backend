import { Router, type Request } from 'express';
import { can, ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { endOfDay, ok, optOid, startOfDay, str } from '../../core/http.js';
import { TXN_TYPES, type TxnType } from '../../core/txn.js';
import { requirePermission } from '../../middleware/company.js';
import { audit } from '../../services/audit.js';
import { toCsv, toXlsx } from '../../services/excel.js';
import { REPORTS, type ReportParams } from './engine.js';

const router = Router();
router.use(requirePermission('reports.view'));

function params(req: Request): ReportParams {
  const q = req.query;
  const type = (str(q.type) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((t) => TXN_TYPES.includes(t as TxnType)) as TxnType[];
  const month = str(q.month);
  return {
    from: str(q.from) ? startOfDay(new Date(String(q.from))) : undefined,
    to: str(q.to) ? endOfDay(new Date(String(q.to))) : undefined,
    party: optOid(q.party),
    item: optOid(q.item),
    category: optOid(q.category),
    account: optOid(q.account),
    loan: optOid(q.loan),
    employee: optOid(q.employee),
    group: optOid(q.group),
    user: optOid(q.user),
    status: str(q.status),
    type: type.length ? type : undefined,
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : undefined,
  };
}

function findReport(req: Request) {
  const ctx = ctxOf(req);
  const def = REPORTS.find((r) => r.key === req.params.key);
  if (!def) throw AppError.notFound('Report');
  if (def.permission && !can(ctx, def.permission)) throw AppError.forbidden();
  return { ctx, def };
}

router.get('/', (req, res) => {
  const ctx = ctxOf(req);
  ok(res, REPORTS.filter((r) => !r.permission || can(ctx, r.permission)).map(({ run: _run, ...r }) => r));
});

router.get('/:key', async (req, res) => {
  const { ctx, def } = findReport(req);
  const p = params(req);
  for (const f of def.required ?? []) if (!(p as Record<string, unknown>)[f]) throw AppError.badRequest(`Select a ${f} to run this report`);
  const result = await def.run(ctx, p);
  ok(res, { key: def.key, title: def.title, ...result });
});

router.get('/:key/export', requirePermission('reports.export'), async (req, res) => {
  const { ctx, def } = findReport(req);
  const p = params(req);
  for (const f of def.required ?? []) if (!(p as Record<string, unknown>)[f]) throw AppError.badRequest(`Select a ${f} to run this report`);
  const result = await def.run(ctx, p);
  const period = p.from || p.to ? `${p.from ? p.from.toLocaleDateString('en-IN') : '…'} – ${p.to ? p.to.toLocaleDateString('en-IN') : '…'}` : p.month ?? '';
  const subtitle = [ctx.companyName, result.subtitle, period].filter(Boolean).join(' · ');
  const filename = `${def.key}-${new Date().toISOString().slice(0, 10)}`;
  await audit(ctx, 'export', 'Report', undefined, `Exported ${def.title}`);
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(toCsv(result.columns, result.rows, result.totals));
  }
  const buf = await toXlsx({ title: def.title, subtitle, columns: result.columns, rows: result.rows, totals: result.totals });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

export default router;
