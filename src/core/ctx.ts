import type { Request } from 'express';
import { AppError } from './errors.js';

export type Ctx = Express.CompanyCtx;

/** Company context of the current request (set by companyContext middleware). */
export function ctxOf(req: Request): Ctx {
  if (!req.ctx) throw AppError.badRequest('Company context missing (X-Company-Id header)');
  return req.ctx;
}

export function can(ctx: Ctx, perm: string) {
  return ctx.isSuperAdmin || ctx.perms.has(perm);
}
