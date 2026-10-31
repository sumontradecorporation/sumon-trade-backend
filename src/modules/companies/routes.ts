import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { BIN_RE } from '../../core/bangladesh.js';
import { AppError } from '../../core/errors.js';
import { created, ok, oid, searchRegex } from '../../core/http.js';
import { email, optStr } from '../../core/zod.js';
import { requireSuperAdmin } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { Company, Party, Transaction, User } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { bootstrapCompany } from '../../services/bootstrap.js';

const router = Router();

const companySchema = z.object({
  name: z.string().trim().min(2, 'Business name is required').max(150),
  phone: z.string().trim().min(5, 'Phone number is required').max(20),
  email,
  address: optStr,
  city: optStr,
  state: optStr,
  pincode: optStr,
  gstin: optStr.refine((v) => !v || BIN_RE.test(v), 'BIN must be 9 digits, optionally with a 4 digit branch suffix'),
  businessType: optStr,
  businessCategory: optStr,
});

const sysCtx = (req: Request, companyId?: unknown) => ({
  companyId: companyId as never,
  userId: req.user!._id,
  userName: req.user!.name,
  ip: req.ip,
});

/** Super admin: all companies with quick stats. Other users: every active company to switch into, without stats. */
router.get('/', async (req, res) => {
  const user = req.user!;
  const filter: Record<string, unknown> = {};
  if (!user.isSuperAdmin) filter.isActive = true;
  else if (req.query.status === 'archived') filter.isActive = false;
  else if (req.query.status !== 'all') filter.isActive = true;
  const rx = searchRegex(req.query.search);
  if (rx) filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
  const companies = await Company.find(filter).select('-settings').sort({ createdAt: -1 }).lean();
  // Sales and receivable figures across companies are a platform view; company users see them inside each company's dashboard
  if (!user.isSuperAdmin) return ok(res, companies);
  const ids = companies.map((c) => c._id);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [users, parties, sales] = await Promise.all([
    User.aggregate([{ $match: { company: { $in: ids } } }, { $group: { _id: '$company', n: { $sum: 1 } } }]),
    Party.aggregate([{ $match: { company: { $in: ids } } }, { $group: { _id: '$company', n: { $sum: 1 }, receivable: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } } } }]),
    Transaction.aggregate([
      { $match: { company: { $in: ids }, type: 'SALE', status: { $ne: 'CANCELLED' }, date: { $gte: monthStart } } },
      { $group: { _id: '$company', total: { $sum: '$total' }, n: { $sum: 1 } } },
    ]),
  ]);
  const m = <T extends { _id: unknown }>(arr: T[]) => new Map(arr.map((x) => [String(x._id), x]));
  const um = m(users), pm = m(parties), sm = m(sales);
  ok(
    res,
    companies.map((c) => ({
      ...c,
      stats: {
        users: um.get(String(c._id))?.n ?? 0,
        parties: pm.get(String(c._id))?.n ?? 0,
        receivable: pm.get(String(c._id))?.receivable ?? 0,
        monthSales: sm.get(String(c._id))?.total ?? 0,
        monthInvoices: sm.get(String(c._id))?.n ?? 0,
      },
    })),
  );
});

router.post('/', requireSuperAdmin, validate(companySchema), async (req, res) => {
  const company = await Company.create({ ...req.body, createdBy: req.user!._id, settings: {} });
  await bootstrapCompany(company._id);
  await audit(sysCtx(req, company._id), 'create', 'Company', company._id, `Company ${company.name} created`);
  created(res, company.toObject());
});

router.get('/:id', async (req, res) => {
  const id = oid(req.params.id);
  const company = await Company.findById(id).select('-settings').lean();
  if (!company || (!company.isActive && !req.user!.isSuperAdmin)) throw AppError.notFound('Company');
  ok(res, company);
});

router.put('/:id', requireSuperAdmin, validate(companySchema), async (req, res) => {
  const company = await Company.findById(oid(req.params.id));
  if (!company) throw AppError.notFound('Company');
  const before = company.toObject();
  company.set(req.body);
  await company.save();
  await audit(sysCtx(req, company._id), 'update', 'Company', company._id, `Company ${company.name} updated`, before, company.toObject());
  ok(res, company.toObject());
});

router.patch('/:id/status', requireSuperAdmin, validate(z.object({ isActive: z.boolean() })), async (req, res) => {
  const company = await Company.findById(oid(req.params.id));
  if (!company) throw AppError.notFound('Company');
  company.isActive = req.body.isActive;
  await company.save();
  await audit(sysCtx(req, company._id), company.isActive ? 'restore' : 'archive', 'Company', company._id, `Company ${company.name} ${company.isActive ? 'restored' : 'archived'}`);
  ok(res, company.toObject());
});

/* -------- Platform super admins -------- */

router.get('/platform/admins', requireSuperAdmin, async (_req, res) => {
  ok(res, await User.find({ isSuperAdmin: true }).select('name email phone status lastLoginAt createdAt').lean());
});

const adminSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  phone: optStr,
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/platform/admins', requireSuperAdmin, validate(adminSchema), async (req, res) => {
  const body = req.body as z.infer<typeof adminSchema>;
  const u = await User.create({ name: body.name, email: body.email, phone: body.phone, isSuperAdmin: true, passwordHash: await bcrypt.hash(body.password, 12) });
  await audit(sysCtx(req), 'create', 'User', u._id, `Super admin ${u.name} created`);
  const { passwordHash: _ph, ...rest } = u.toObject();
  created(res, rest);
});

router.patch('/platform/admins/:id/status', requireSuperAdmin, validate(z.object({ status: z.enum(['active', 'inactive']) })), async (req, res) => {
  const id = oid(req.params.id);
  if (String(id) === String(req.user!._id)) throw AppError.badRequest('You cannot deactivate yourself');
  const u = await User.findOneAndUpdate({ _id: id, isSuperAdmin: true }, { $set: { status: req.body.status } }, { returnDocument: 'after' }).lean();
  if (!u) throw AppError.notFound('Super admin');
  ok(res, u);
});

export default router;
