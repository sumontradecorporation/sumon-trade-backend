import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, ok, oid, searchRegex } from '../../core/http.js';
import { email, objectId, optionalId, phone } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { RefreshToken, Role, User } from '../../models/index.js';
import { audit } from '../../services/audit.js';
import { assertLinkable, linkEmployeeUser, unlinkUser } from '../../services/employee-link.js';
const router = Router();
router.use(requirePermission('users.manage'));
const userSchema = z
    .object({
    name: z.string().trim().min(2, 'Name is required').max(100),
    email,
    phone,
    password: z.string().min(8, 'Password must be at least 8 characters').max(128).optional().or(z.literal('')),
    role: objectId,
    status: z.enum(['active', 'inactive']).default('active'),
    employee: optionalId,
})
    .refine((v) => v.email || v.phone, { message: 'Email or phone is required for login', path: ['email'] });
async function assertRole(companyId, roleId) {
    const role = await Role.findOne({ _id: roleId, company: companyId }).lean();
    if (!role)
        throw AppError.badRequest('Role not found in this company');
    return role;
}
router.get('/', async (req, res) => {
    const ctx = ctxOf(req);
    const filter = { company: ctx.companyId };
    const rx = searchRegex(req.query.search);
    if (rx)
        filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    const users = await User.find(filter).populate('role', 'name').populate('employee', 'name designation').sort({ createdAt: -1 }).lean();
    ok(res, users);
});
router.post('/', validate(userSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const body = req.body;
    if (!body.password)
        throw AppError.badRequest('Password is required');
    await assertRole(ctx.companyId, body.role);
    await assertLinkable(ctx.companyId, { employee: body.employee });
    const user = await User.create({
        name: body.name,
        email: body.email,
        phone: body.phone,
        role: body.role,
        status: body.status,
        company: ctx.companyId,
        employee: body.employee,
        passwordHash: await bcrypt.hash(body.password, 12),
    });
    if (body.employee)
        await linkEmployeeUser(ctx.companyId, body.employee, user._id);
    await audit(ctx, 'create', 'User', user._id, `User ${user.name} created`);
    const { passwordHash: _ph, ...rest } = user.toObject();
    created(res, rest);
});
router.put('/:id', validate(userSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const body = req.body;
    const user = await User.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!user)
        throw AppError.notFound('User');
    const role = await assertRole(ctx.companyId, body.role);
    await assertLinkable(ctx.companyId, { employee: body.employee });
    if (String(user._id) === String(ctx.userId) && (body.status === 'inactive' || String(user.role) !== body.role)) {
        throw AppError.badRequest('You cannot change your own role or deactivate yourself');
    }
    await guardLastAdmin(ctx.companyId, user, role.isSystem ? 'keep' : 'change', body.status);
    const before = user.toObject();
    user.set({ name: body.name, email: body.email, phone: body.phone, role: body.role, status: body.status, employee: body.employee });
    if (body.password) {
        user.passwordHash = await bcrypt.hash(body.password, 12);
        await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    await user.save();
    if (body.employee)
        await linkEmployeeUser(ctx.companyId, body.employee, user._id);
    else
        await unlinkUser(ctx.companyId, user._id);
    if (body.status === 'inactive')
        await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(ctx, 'update', 'User', user._id, `User ${user.name} updated`, before, user.toObject());
    const { passwordHash: _ph, ...rest } = user.toObject();
    ok(res, rest);
});
/** A company must always keep at least one active admin. */
async function guardLastAdmin(companyId, user, roleChange, status) {
    const adminRole = await Role.findOne({ company: companyId, isSystem: true }).lean();
    if (!adminRole || String(user.role) !== String(adminRole._id))
        return;
    if (roleChange === 'keep' && status !== 'inactive')
        return;
    const others = await User.countDocuments({ company: companyId, role: adminRole._id, status: 'active', _id: { $ne: user._id } });
    if (others === 0)
        throw AppError.badRequest('This is the only active admin of the company. Create another admin first.');
}
router.post('/:id/reset-password', validate(z.object({ password: z.string().min(8, 'Password must be at least 8 characters') })), async (req, res) => {
    const ctx = ctxOf(req);
    const user = await User.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!user)
        throw AppError.notFound('User');
    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    user.passwordChangedAt = new Date();
    await user.save();
    await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(ctx, 'reset_password', 'User', user._id, `Password reset for ${user.name}`);
    ok(res, { reset: true });
});
router.delete('/:id', async (req, res) => {
    const ctx = ctxOf(req);
    const user = await User.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!user)
        throw AppError.notFound('User');
    if (String(user._id) === String(ctx.userId))
        throw AppError.badRequest('You cannot delete your own account');
    await guardLastAdmin(ctx.companyId, user, 'delete');
    await RefreshToken.deleteMany({ user: user._id });
    await unlinkUser(ctx.companyId, user._id);
    await user.deleteOne();
    await audit(ctx, 'delete', 'User', user._id, `User ${user.name} deleted`, user.toObject());
    ok(res, { deleted: true });
});
export default router;
//# sourceMappingURL=routes.js.map