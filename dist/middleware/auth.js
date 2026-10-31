import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { ALL_PERMISSIONS } from '../core/permissions.js';
import { User } from '../models/index.js';
export const ACCESS_COOKIE = 'vy_at';
export const REFRESH_COOKIE = 'vy_rt';
/** Loads the full auth user (with role & permissions) for a user id. */
export async function loadAuthUser(userId) {
    const user = await User.findById(userId)
        .populate('role', 'name permissions approvalRequired isSystem')
        .lean();
    if (!user || user.status !== 'active')
        return null;
    return {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isSuperAdmin: !!user.isSuperAdmin,
        company: user.company ?? null,
        role: user.role ?? null,
        // The system Admin role holds every permission, including ones added after the company was created.
        permissions: user.isSuperAdmin || user.role?.isSystem ? ALL_PERMISSIONS : (user.role?.permissions ?? []),
        approvalRequired: user.isSuperAdmin || user.role?.isSystem ? [] : (user.role?.approvalRequired ?? []),
    };
}
export async function authenticate(req, _res, next) {
    const header = req.headers.authorization;
    const token = req.cookies?.[ACCESS_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token)
        throw AppError.unauthorized();
    let payload;
    try {
        payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    }
    catch {
        throw new AppError(401, 'Session expired', 'TOKEN_EXPIRED');
    }
    const user = await loadAuthUser(payload.sub);
    if (!user)
        throw AppError.unauthorized('Account is inactive or no longer exists');
    req.user = user;
    next();
}
export function requireSuperAdmin(req, _res, next) {
    if (!req.user?.isSuperAdmin)
        throw AppError.forbidden('Only the super admin can do this');
    next();
}
//# sourceMappingURL=auth.js.map