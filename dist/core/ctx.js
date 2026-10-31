import { AppError } from './errors.js';
/** Company context of the current request (set by companyContext middleware). */
export function ctxOf(req) {
    if (!req.ctx)
        throw AppError.badRequest('Company context missing (X-Company-Id header)');
    return req.ctx;
}
export function can(ctx, perm) {
    return ctx.isSuperAdmin || ctx.perms.has(perm);
}
//# sourceMappingURL=ctx.js.map