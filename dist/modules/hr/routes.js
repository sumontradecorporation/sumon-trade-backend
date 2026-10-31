import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { can, ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, ok, oid, round2, searchRegex, str } from '../../core/http.js';
import { email, money, objectId, optDate, optStr, optionalId, phone } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { ApprovalRequest, Attendance, Employee, ExpenseCategory, HrRequest, Payroll, Transaction, User } from '../../models/index.js';
import { decideApproval, registerApprovalHandler, requestApproval } from '../../services/approvals.js';
import { audit } from '../../services/audit.js';
import { assertLinkable, linkEmployeeUser } from '../../services/employee-link.js';
import { nextSeq } from '../../services/numbering.js';
import { zonedNow } from '../../core/time.js';
import { createTxn, deleteTxn } from '../transactions/service.js';
import { hrRequestLabel } from './labels.js';
import { txnBodySchema } from '../transactions/schema.js';
const router = Router();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
/** Employee record linked to the signed-in user, if any. */
async function myEmployee(ctx) {
    const user = await User.findById(ctx.userId).select('employee').lean();
    if (user?.employee)
        return Employee.findOne({ _id: user.employee, company: ctx.companyId }).lean();
    return Employee.findOne({ company: ctx.companyId, user: ctx.userId }).lean();
}
/* ---------------- Employees ---------------- */
const employeeSchema = z.object({
    code: optStr,
    name: z.string().trim().min(2).max(100),
    phone,
    email,
    designation: optStr,
    department: optStr,
    joinDate: optDate,
    salaryType: z.enum(['monthly', 'daily']).default('monthly'),
    salary: money,
    allowances: money,
    deductions: money,
    bankName: optStr,
    accountNumber: optStr,
    ifsc: optStr,
    address: optStr,
    emergencyContact: optStr,
    user: optionalId,
    photo: optionalId,
    status: z.enum(['active', 'inactive']).default('active'),
});
router.get('/me', async (req, res) => {
    ok(res, await myEmployee(ctxOf(req)));
});
/** Own attendance for a month (self service, no HR permission needed) */
router.get('/me/attendance', async (req, res) => {
    const ctx = ctxOf(req);
    const now = zonedNow(ctx.settings.general.timezone);
    const month = str(req.query.month) ?? now.month;
    if (!MONTH.test(month))
        throw AppError.badRequest('Invalid month');
    const me = await myEmployee(ctx);
    if (!me)
        return ok(res, { month, today: now.day, employee: null, marks: [] });
    const marks = await Attendance.find({ company: ctx.companyId, employee: me._id, day: { $regex: `^${month}` } }).sort({ day: 1 }).lean();
    ok(res, { month, today: now.day, employee: { _id: me._id, name: me.name }, marks: marks.map((a) => ({ day: a.day, status: a.status, checkIn: a.checkIn, checkOut: a.checkOut, note: a.note })) });
});
/** Own paid salary slips (self service) */
router.get('/me/payslips', async (req, res) => {
    const ctx = ctxOf(req);
    const me = await myEmployee(ctx);
    if (!me)
        return ok(res, []);
    ok(res, await Payroll.find({ company: ctx.companyId, employee: me._id, status: 'paid' }).sort({ month: -1 }).limit(36).lean());
});
router.get('/employees', requirePermission('employees.view', 'attendance.view', 'payroll.view', 'hr_requests.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const filter = { company: ctx.companyId };
    const rx = searchRegex(req.query.search);
    if (rx)
        filter.$or = [{ name: rx }, { phone: rx }, { designation: rx }, { department: rx }, { code: rx }];
    if (str(req.query.status))
        filter.status = req.query.status;
    ok(res, await Employee.find(filter).populate('user', 'name email').sort({ name: 1 }).lean());
});
router.get('/employees/:id', requirePermission('employees.view', 'employees.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const e = await Employee.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('user', 'name email').lean();
    if (!e)
        throw AppError.notFound('Employee');
    const [payroll, requests] = await Promise.all([
        Payroll.find({ company: ctx.companyId, employee: e._id }).sort({ month: -1 }).limit(24).lean(),
        HrRequest.find({ company: ctx.companyId, employee: e._id }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    ok(res, { ...e, payroll, requests });
});
router.post('/employees', requirePermission('employees.manage'), validate(employeeSchema), async (req, res) => {
    const ctx = ctxOf(req);
    await assertLinkable(ctx.companyId, { user: req.body.user });
    const code = req.body.code || `EMP${String(await nextSeq(ctx.companyId, 'EMPLOYEE_CODE')).padStart(4, '0')}`;
    const e = await Employee.create({ ...req.body, code, company: ctx.companyId, joinDate: req.body.joinDate ?? new Date() });
    if (e.user)
        await linkEmployeeUser(ctx.companyId, e._id, e.user);
    await audit(ctx, 'create', 'Employee', e._id, `Employee ${e.name} added`);
    created(res, e.toObject());
});
router.put('/employees/:id', requirePermission('employees.manage'), validate(employeeSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const e = await Employee.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!e)
        throw AppError.notFound('Employee');
    await assertLinkable(ctx.companyId, { user: req.body.user });
    const before = e.toObject();
    e.set({ ...req.body, code: req.body.code || e.code });
    if (!req.body.user)
        e.set('user', undefined);
    if (!req.body.photo)
        e.set('photo', undefined);
    await e.save();
    await linkEmployeeUser(ctx.companyId, e._id, e.user ?? null);
    await audit(ctx, 'update', 'Employee', e._id, `Employee ${e.name} updated`, before, e.toObject());
    ok(res, e.toObject());
});
router.delete('/employees/:id', requirePermission('employees.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const e = await Employee.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!e)
        throw AppError.notFound('Employee');
    const paid = await Payroll.countDocuments({ company: ctx.companyId, employee: e._id, status: 'paid' });
    if (paid)
        throw AppError.badRequest('This employee has paid salary records. Mark the employee inactive instead.');
    await Promise.all([
        Attendance.deleteMany({ company: ctx.companyId, employee: e._id }),
        Payroll.deleteMany({ company: ctx.companyId, employee: e._id }),
        HrRequest.deleteMany({ company: ctx.companyId, employee: e._id }),
        User.updateMany({ employee: e._id }, { $unset: { employee: 1 } }),
    ]);
    await e.deleteOne();
    await audit(ctx, 'delete', 'Employee', e._id, `Employee ${e.name} deleted`, e.toObject());
    ok(res, { deleted: true });
});
/* ---------------- Attendance ---------------- */
router.get('/attendance', requirePermission('attendance.view', 'attendance.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const day = str(req.query.day) ?? zonedNow(ctx.settings.general.timezone).day;
    if (!DAY.test(day))
        throw AppError.badRequest('Invalid day');
    const [emps, marks] = await Promise.all([
        Employee.find({ company: ctx.companyId, status: 'active' }).sort({ name: 1 }).lean(),
        Attendance.find({ company: ctx.companyId, day }).lean(),
    ]);
    const m = new Map(marks.map((a) => [String(a.employee), a]));
    ok(res, { day, rows: emps.map((e) => ({ employee: { _id: e._id, name: e.name, designation: e.designation, code: e.code }, attendance: m.get(String(e._id)) ?? null })) });
});
router.get('/attendance/month', requirePermission('attendance.view', 'attendance.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const month = str(req.query.month) ?? zonedNow(ctx.settings.general.timezone).month;
    if (!MONTH.test(month))
        throw AppError.badRequest('Invalid month');
    const [emps, marks] = await Promise.all([
        Employee.find({ company: ctx.companyId, status: 'active' }).sort({ name: 1 }).lean(),
        Attendance.find({ company: ctx.companyId, day: { $regex: `^${month}` } }).lean(),
    ]);
    ok(res, { month, employees: emps.map((e) => ({ _id: e._id, name: e.name, designation: e.designation })), marks: marks.map((a) => ({ employee: a.employee, day: a.day, status: a.status, checkIn: a.checkIn, checkOut: a.checkOut })) });
});
const markSchema = z.object({
    day: z.string().regex(DAY),
    entries: z
        .array(z.object({
        employee: objectId,
        status: z.enum(['present', 'absent', 'half_day', 'leave', 'holiday']).nullable(),
        checkIn: optStr,
        checkOut: optStr,
        note: optStr,
    }))
        .min(1)
        .max(1000),
});
router.post('/attendance', requirePermission('attendance.manage'), validate(markSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const { day, entries } = req.body;
    const valid = new Set((await Employee.find({ company: ctx.companyId, _id: { $in: entries.map((e) => e.employee) } }).select('_id').lean()).map((e) => String(e._id)));
    const ops = entries
        .filter((e) => valid.has(e.employee))
        .map((e) => e.status
        ? { updateOne: { filter: { company: ctx.companyId, employee: new Types.ObjectId(e.employee), day }, update: { $set: { status: e.status, checkIn: e.checkIn, checkOut: e.checkOut, note: e.note, markedBy: ctx.userId } }, upsert: true } }
        : { deleteOne: { filter: { company: ctx.companyId, employee: new Types.ObjectId(e.employee), day } } });
    if (ops.length)
        await Attendance.bulkWrite(ops);
    await audit(ctx, 'mark_attendance', 'Attendance', undefined, `Attendance saved for ${day} (${ops.length} employee${ops.length === 1 ? '' : 's'})`);
    ok(res, { saved: ops.length });
});
/** Self service check-in / check-out for the signed-in employee */
router.post('/attendance/self', validate(z.object({ action: z.enum(['check_in', 'check_out']) })), async (req, res) => {
    const ctx = ctxOf(req);
    const emp = await myEmployee(ctx);
    if (!emp)
        throw AppError.badRequest('Your login is not linked to an employee profile');
    const { day, time } = zonedNow(ctx.settings.general.timezone);
    const existing = await Attendance.findOne({ company: ctx.companyId, employee: emp._id, day }).lean();
    if (req.body.action === 'check_in') {
        if (existing?.checkIn)
            throw AppError.badRequest(`You already checked in today at ${existing.checkIn}`);
        if (existing && existing.status !== 'present' && existing.status !== 'half_day')
            throw AppError.badRequest(`Today is marked as ${existing.status.replace('_', ' ')} for you. Ask your manager to change it.`);
    }
    else {
        if (!existing?.checkIn)
            throw AppError.badRequest('Check in first');
        if (existing.checkOut)
            throw AppError.badRequest(`You already checked out today at ${existing.checkOut}`);
    }
    const update = req.body.action === 'check_in' ? { $set: { status: existing?.status ?? 'present', checkIn: time, markedBy: ctx.userId } } : { $set: { checkOut: time, markedBy: ctx.userId } };
    const a = await Attendance.findOneAndUpdate({ company: ctx.companyId, employee: emp._id, day }, update, { upsert: true, returnDocument: 'after' }).lean();
    await audit(ctx, req.body.action, 'Attendance', a?._id, `${emp.name} ${req.body.action === 'check_in' ? 'checked in' : 'checked out'} at ${time}`);
    ok(res, a);
});
/* ---------------- Salary advance & leave requests ---------------- */
const requestSchema = z
    .object({
    kind: z.enum(['salary_advance', 'leave']),
    employee: optionalId,
    amount: z.coerce.number().min(0).optional(),
    fromDate: z.string().regex(DAY).optional(),
    toDate: z.string().regex(DAY).optional(),
    reason: optStr,
})
    .refine((v) => v.kind !== 'salary_advance' || (v.amount ?? 0) > 0, { message: 'Enter the advance amount', path: ['amount'] })
    .refine((v) => v.kind !== 'leave' || (v.fromDate && v.toDate && v.fromDate <= v.toDate), { message: 'Choose a valid leave period', path: ['toDate'] });
registerApprovalHandler('hr_request', {
    approve: async (ctx, a) => {
        const r = await HrRequest.findOne({ _id: a.entityId, company: ctx.companyId });
        if (!r)
            throw AppError.notFound('Request');
        r.status = 'approved';
        r.reviewedBy = ctx.userId;
        r.reviewedAt = new Date();
        r.reviewNote = a.reviewNote ?? undefined;
        await r.save();
        if (r.kind === 'leave' && r.fromDate && r.toDate) {
            const ops = [];
            for (let d = new Date(`${r.fromDate}T00:00:00Z`); d <= new Date(`${r.toDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
                const day = d.toISOString().slice(0, 10);
                ops.push({ updateOne: { filter: { company: ctx.companyId, employee: r.employee, day }, update: { $set: { status: 'leave', note: r.reason ?? 'Approved leave', markedBy: ctx.userId } }, upsert: true } });
            }
            if (ops.length)
                await Attendance.bulkWrite(ops);
        }
    },
    reject: async (ctx, a) => {
        await HrRequest.updateOne({ _id: a.entityId, company: ctx.companyId }, { $set: { status: 'rejected', reviewedBy: ctx.userId, reviewedAt: new Date(), reviewNote: a.reviewNote ?? undefined } });
    },
});
router.get('/requests', async (req, res) => {
    const ctx = ctxOf(req);
    const filter = { company: ctx.companyId };
    if (!can(ctx, 'hr_requests.manage')) {
        const me = await myEmployee(ctx);
        if (!me)
            return ok(res, []);
        filter.employee = me._id;
    }
    else if (str(req.query.employee))
        filter.employee = oid(req.query.employee);
    if (str(req.query.status))
        filter.status = req.query.status;
    if (str(req.query.kind))
        filter.kind = req.query.kind;
    ok(res, await HrRequest.find(filter).populate('employee', 'name designation').populate('requestedBy reviewedBy', 'name').sort({ createdAt: -1 }).limit(500).lean());
});
router.post('/requests', validate(requestSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const body = req.body;
    let employeeId = body.employee;
    if (!employeeId || !can(ctx, 'hr_requests.manage')) {
        const me = await myEmployee(ctx);
        if (!me)
            throw AppError.badRequest('Your login is not linked to an employee profile. Ask an admin to link it in HR ▸ Employees.');
        employeeId = String(me._id);
    }
    const emp = await Employee.findOne({ _id: employeeId, company: ctx.companyId }).lean();
    if (!emp)
        throw AppError.notFound('Employee');
    const r = await HrRequest.create({ ...body, employee: emp._id, company: ctx.companyId, requestedBy: ctx.userId });
    const label = hrRequestLabel(body, emp.name, ctx.settings.general.currencySymbol);
    await requestApproval(ctx, { kind: 'hr_request', entity: 'HrRequest', entityId: r._id, label, payload: body, reason: body.reason, link: '/hr/requests' });
    created(res, r.toObject());
});
router.post('/requests/:id/decision', requirePermission('hr_requests.manage'), validate(z.object({ decision: z.enum(['approve', 'reject']), note: optStr })), async (req, res) => {
    const ctx = ctxOf(req);
    const r = await HrRequest.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
    if (!r)
        throw AppError.notFound('Request');
    const approval = await ApprovalRequest.findOne({ company: ctx.companyId, kind: 'hr_request', entityId: r._id, status: 'pending' }).lean();
    if (!approval)
        throw AppError.badRequest('This request is no longer pending');
    await decideApproval({ ...ctx, perms: new Set([...ctx.perms, 'approvals.manage']) }, String(approval._id), req.body.decision, req.body.note);
    ok(res, await HrRequest.findById(r._id).lean());
});
async function salaryCategory(ctx) {
    const found = await ExpenseCategory.findOne({ company: ctx.companyId, name: 'Salary' }).select('_id').lean();
    if (found)
        return found;
    return ExpenseCategory.create({ company: ctx.companyId, name: 'Salary', kind: 'indirect' });
}
/** Pay out an approved salary advance: books a Salary expense from the chosen account */
router.post('/requests/:id/pay', requirePermission('payroll.manage'), validate(z.object({ paymentAccount: optionalId, date: optDate })), async (req, res) => {
    const ctx = ctxOf(req);
    const r = await HrRequest.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('employee', 'name');
    if (!r)
        throw AppError.notFound('Request');
    if (r.kind !== 'salary_advance' || r.status !== 'approved')
        throw AppError.badRequest('Only approved salary advances can be paid');
    const cat = await salaryCategory(ctx);
    const execCtx = { ...ctx, isSuperAdmin: true };
    await createTxn(execCtx, txnBodySchema.parse({
        type: 'EXPENSE',
        date: req.body.date ?? new Date(),
        expenseCategory: String(cat._id),
        partyName: r.employee.name,
        items: [{ name: `Salary advance - ${r.employee.name}`, qty: 1, price: r.amount ?? 0 }],
        settled: r.amount ?? 0,
        paymentAccount: req.body.paymentAccount,
        description: r.reason ?? 'Salary advance',
        roundOff: false,
    }));
    r.status = 'paid';
    await r.save();
    await audit(ctx, 'pay', 'HrRequest', r._id, `Salary advance of ${ctx.settings.general.currencySymbol}${(r.amount ?? 0).toLocaleString('en-IN')} paid to ${r.employee.name}`);
    ok(res, r.toObject());
});
/* ---------------- Payroll ---------------- */
function daysInMonth(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m, 0).getDate();
}
router.get('/payroll', requirePermission('payroll.view', 'payroll.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const month = str(req.query.month) ?? new Date().toISOString().slice(0, 7);
    if (!MONTH.test(month))
        throw AppError.badRequest('Invalid month');
    const rows = await Payroll.find({ company: ctx.companyId, month }).populate('employee', 'name designation code salaryType salary').populate('paymentAccount', 'name').sort({ createdAt: 1 }).lean();
    const totals = rows.reduce((t, r) => ({ net: t.net + r.net, paid: t.paid + (r.status === 'paid' ? r.net : 0) }), { net: 0, paid: 0 });
    ok(res, rows, { month, totals: { net: round2(totals.net), paid: round2(totals.paid), pending: round2(totals.net - totals.paid) } });
});
router.post('/payroll/generate', requirePermission('payroll.manage'), validate(z.object({ month: z.string().regex(MONTH) })), async (req, res) => {
    const ctx = ctxOf(req);
    const month = req.body.month;
    const hr = ctx.settings.hr;
    const workingDays = Number(hr.workingDaysPerMonth) || 26;
    const emps = await Employee.find({ company: ctx.companyId, status: 'active' }).lean();
    const marks = await Attendance.aggregate([
        { $match: { company: ctx.companyId, day: { $regex: `^${month}` } } },
        { $group: { _id: { e: '$employee', s: '$status' }, n: { $sum: 1 } } },
    ]);
    const advances = await HrRequest.aggregate([
        { $match: { company: ctx.companyId, kind: 'salary_advance', status: 'paid', $or: [{ deductedIn: null }, { deductedIn: month }] } },
        { $group: { _id: '$employee', amount: { $sum: '$amount' } } },
    ]);
    const count = (e, s) => marks.find((m) => String(m._id.e) === String(e) && m._id.s === s)?.n ?? 0;
    let generated = 0;
    for (const e of emps) {
        const existing = await Payroll.findOne({ company: ctx.companyId, employee: e._id, month }).lean();
        if (existing?.status === 'paid')
            continue;
        const present = count(e._id, 'present');
        const half = count(e._id, 'half_day');
        const leave = count(e._id, 'leave');
        const holiday = count(e._id, 'holiday');
        const absent = count(e._id, 'absent');
        const paidLeave = Math.min(leave, Number(hr.paidLeavePerMonth) || 0);
        const payableDays = present + half * (Number(hr.halfDayFactor) || 0.5) + paidLeave + holiday;
        const earned = e.salaryType === 'daily' ? e.salary * payableDays : (e.salary * Math.min(payableDays, workingDays)) / workingDays;
        const advance = advances.find((a) => String(a._id) === String(e._id))?.amount ?? 0;
        const bonus = existing?.bonus ?? 0;
        const allowances = existing?.allowances ?? e.allowances ?? 0;
        const deductions = existing?.deductions ?? e.deductions ?? 0;
        await Payroll.updateOne({ company: ctx.companyId, employee: e._id, month }, {
            $set: {
                workingDays: e.salaryType === 'daily' ? daysInMonth(month) : workingDays,
                presentDays: present, halfDays: half, leaveDays: leave, absentDays: absent, payableDays: round2(payableDays),
                basic: e.salary, earned: round2(earned), allowances, bonus, deductions, advanceDeduction: round2(advance),
                net: round2(Math.max(0, earned + allowances + bonus - deductions - advance)), status: 'draft',
            },
        }, { upsert: true });
        generated++;
    }
    await audit(ctx, 'create', 'Payroll', undefined, `Payroll generated for ${month} (${generated} employee${generated === 1 ? '' : 's'})`);
    ok(res, { generated });
});
/** One salary slip. Visible to payroll staff and to the employee it belongs to. */
router.get('/payroll/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const p = await Payroll.findOne({ _id: oid(req.params.id), company: ctx.companyId })
        .populate('employee', 'name code designation department joinDate phone email bankName accountNumber ifsc salaryType salary')
        .populate('paymentAccount', 'name kind')
        .lean();
    if (!p)
        throw AppError.notFound('Salary slip');
    if (!can(ctx, 'payroll.view') && !can(ctx, 'payroll.manage')) {
        const me = await myEmployee(ctx);
        if (!me || String(me._id) !== String(p.employee?._id) || p.status !== 'paid')
            throw AppError.forbidden('You can only open your own salary slips');
    }
    ok(res, p);
});
const payrollEditSchema = z.object({ allowances: money, bonus: money, deductions: money, advanceDeduction: money, earned: z.coerce.number().min(0).optional(), note: optStr });
router.put('/payroll/:id', requirePermission('payroll.manage'), validate(payrollEditSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const p = await Payroll.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!p)
        throw AppError.notFound('Payroll');
    if (p.status === 'paid')
        throw AppError.badRequest('This salary is already paid. Revert the payment to edit it.');
    p.set(req.body);
    if (req.body.earned === undefined)
        p.set('earned', p.earned);
    p.net = round2(Math.max(0, p.earned + p.allowances + p.bonus - p.deductions - p.advanceDeduction));
    await p.save();
    ok(res, p.toObject());
});
router.post('/payroll/:id/pay', requirePermission('payroll.manage'), validate(z.object({ paymentAccount: optionalId, date: optDate })), async (req, res) => {
    const ctx = ctxOf(req);
    const p = await Payroll.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('employee', 'name');
    if (!p)
        throw AppError.notFound('Payroll');
    if (p.status === 'paid')
        throw AppError.badRequest('Already paid');
    if (p.net <= 0)
        throw AppError.badRequest('Net pay is zero');
    const cat = await salaryCategory(ctx);
    const exp = await createTxn({ ...ctx, isSuperAdmin: true }, txnBodySchema.parse({
        type: 'EXPENSE',
        date: req.body.date ?? new Date(),
        expenseCategory: String(cat._id),
        partyName: p.employee.name,
        items: [{ name: `Salary ${p.month} - ${p.employee.name}`, qty: 1, price: p.net }],
        settled: p.net,
        paymentAccount: req.body.paymentAccount,
        description: `Salary for ${p.month}`,
        roundOff: false,
    }));
    p.status = 'paid';
    p.paidOn = req.body.date ?? new Date();
    p.expense = exp._id;
    p.paymentAccount = exp.paymentAccount ?? undefined;
    await p.save();
    if (p.advanceDeduction > 0) {
        await HrRequest.updateMany({ company: ctx.companyId, employee: p.employee._id, kind: 'salary_advance', status: 'paid', deductedIn: null }, { $set: { deductedIn: p.month } });
    }
    await audit(ctx, 'pay', 'Payroll', p._id, `Salary ${p.month} paid to ${p.employee.name}: ${p.net}`);
    ok(res, p.toObject());
});
router.post('/payroll/:id/revert', requirePermission('payroll.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const p = await Payroll.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!p)
        throw AppError.notFound('Payroll');
    if (p.status !== 'paid')
        throw AppError.badRequest('This salary is not paid');
    if (p.expense && (await Transaction.exists({ _id: p.expense, company: ctx.companyId })))
        await deleteTxn({ ...ctx, isSuperAdmin: true }, p.expense);
    await HrRequest.updateMany({ company: ctx.companyId, employee: p.employee, kind: 'salary_advance', deductedIn: p.month }, { $set: { deductedIn: null } });
    p.status = 'draft';
    p.set('expense', undefined);
    p.set('paidOn', undefined);
    await p.save();
    await audit(ctx, 'update', 'Payroll', p._id, `Salary payment for ${p.month} reverted`);
    ok(res, p.toObject());
});
router.delete('/payroll/:id', requirePermission('payroll.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const p = await Payroll.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!p)
        throw AppError.notFound('Payroll');
    if (p.status === 'paid')
        throw AppError.badRequest('Revert the payment first');
    await p.deleteOne();
    ok(res, { deleted: true });
});
export default router;
//# sourceMappingURL=routes.js.map