import { Router } from 'express';
import { z } from 'zod';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, ok, oid } from '../../core/http.js';
import { ALL_PERMISSIONS, APPROVABLE_PERMISSIONS } from '../../core/permissions.js';
import { optStr } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { validate } from '../../middleware/validate.js';
import { Role, User } from '../../models/index.js';
import { audit } from '../../services/audit.js';
const router = Router();
const roleSchema = z
    .object({
    name: z.string().trim().min(2).max(60),
    description: optStr,
    permissions: z.array(z.string()).transform((list) => [...new Set(list.filter((p) => ALL_PERMISSIONS.includes(p)))]),
    approvalRequired: z.array(z.string()).default([]),
})
    // Only granted, approvable permissions can be marked "with approval"
    .transform((r) => ({ ...r, approvalRequired: [...new Set(r.approvalRequired.filter((p) => APPROVABLE_PERMISSIONS.includes(p) && r.permissions.includes(p)))] }));
router.get('/', requirePermission('roles.manage', 'users.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const roles = await Role.find({ company: ctx.companyId }).sort({ isSystem: -1, name: 1 }).lean();
    const counts = await User.aggregate([{ $match: { company: ctx.companyId } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
    const m = new Map(counts.map((c) => [String(c._id), c.n]));
    ok(res, roles.map((r) => ({ ...r, permissions: r.isSystem ? ALL_PERMISSIONS : r.permissions, approvalRequired: r.isSystem ? [] : (r.approvalRequired ?? []), users: m.get(String(r._id)) ?? 0 })));
});
router.post('/', requirePermission('roles.manage'), validate(roleSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const role = await Role.create({ ...req.body, company: ctx.companyId });
    await audit(ctx, 'create', 'Role', role._id, `Role ${role.name} created`);
    created(res, role.toObject());
});
router.put('/:id', requirePermission('roles.manage'), validate(roleSchema), async (req, res) => {
    const ctx = ctxOf(req);
    const role = await Role.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!role)
        throw AppError.notFound('Role');
    if (role.isSystem)
        throw AppError.badRequest('The Admin role always has every permission and cannot be edited');
    const before = role.toObject();
    role.set(req.body);
    await role.save();
    await audit(ctx, 'update', 'Role', role._id, `Role ${role.name} updated`, before, role.toObject());
    ok(res, role.toObject());
});
router.delete('/:id', requirePermission('roles.manage'), async (req, res) => {
    const ctx = ctxOf(req);
    const role = await Role.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!role)
        throw AppError.notFound('Role');
    if (role.isSystem)
        throw AppError.badRequest('System roles cannot be deleted');
    const users = await User.countDocuments({ role: role._id });
    if (users)
        throw AppError.badRequest(`${users} user(s) still have this role. Move them to another role first.`);
    await role.deleteOne();
    await audit(ctx, 'delete', 'Role', role._id, `Role ${role.name} deleted`, role.toObject());
    ok(res, { deleted: true });
});
export default router;
//# sourceMappingURL=routes.js.map