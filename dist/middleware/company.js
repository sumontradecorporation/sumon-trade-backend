import { Types } from 'mongoose';
import { AppError } from '../core/errors.js';
import { resolveSettings } from '../core/settings.js';
import { Company } from '../models/index.js';
/**
 * Resolves the active company from the X-Company-Id header. Every user may switch into any active company and acts there
 * with the permissions of their own role; only the super admin may enter an archived one.
 */
export async function companyContext(req, _res, next) {
    const user = req.user;
    if (!user)
        throw AppError.unauthorized();
    const raw = (req.header('x-company-id') ?? (typeof req.query.companyId === 'string' ? req.query.companyId : '')).trim();
    const id = raw || (user.company ? String(user.company) : '');
    if (!id || !Types.ObjectId.isValid(id))
        throw AppError.badRequest('Select a company first');
    const company = await Company.findById(id).select('name settings isActive').lean();
    if (!company)
        throw AppError.notFound('Company');
    if (!company.isActive && !user.isSuperAdmin)
        throw AppError.forbidden('This company is archived');
    req.ctx = {
        companyId: company._id,
        companyName: company.name,
        userId: user._id,
        userName: user.name,
        isSuperAdmin: user.isSuperAdmin,
        settings: resolveSettings(company.settings),
        perms: new Set(user.permissions),
        approvalRequired: new Set(user.approvalRequired),
        ip: req.ip,
        ua: req.header('user-agent'),
    };
    next();
}
/** Any-of permission guard. */
export function requirePermission(...perms) {
    return (req, _res, next) => {
        const ctx = req.ctx;
        if (!ctx)
            throw AppError.badRequest('Company context missing');
        if (ctx.isSuperAdmin || perms.some((p) => ctx.perms.has(p)))
            return next();
        throw AppError.forbidden();
    };
}
//# sourceMappingURL=company.js.map