import type { Response } from 'express';
import type { Types } from 'mongoose';
import type { Ctx } from '../core/ctx.js';
import { can } from '../core/ctx.js';
import { AppError } from '../core/errors.js';
import { ApprovalRequest, User } from '../models/index.js';
import { audit } from './audit.js';
import { notifyPermission, notifyUsers } from './notify.js';

export type ApprovalKind =
  | 'txn_update'
  | 'txn_delete'
  | 'txn_cancel'
  | 'stock_adjustment'
  | 'stock_adjustment_delete'
  | 'item_update'
  | 'item_delete'
  | 'party_update'
  | 'party_delete'
  | 'party_group_delete'
  | 'category_delete'
  | 'unit_delete'
  | 'unit_conversion_delete'
  | 'hr_request';

type ApprovalDoc = InstanceType<typeof ApprovalRequest>;
type Handler = { approve: (ctx: Ctx, a: ApprovalDoc) => Promise<unknown>; reject?: (ctx: Ctx, a: ApprovalDoc) => Promise<unknown> };
const handlers = new Map<string, Handler>();

/** Modules register what happens when a request of their kind is approved / rejected. */
export function registerApprovalHandler(kind: ApprovalKind, h: Handler) {
  handlers.set(kind, h);
}

/** True when the user's role grants any of these permissions only "with approval" (set per role in Roles & permissions). */
export function needsApproval(ctx: Ctx, ...perms: string[]) {
  if (ctx.isSuperAdmin) return false;
  return perms.some((p) => ctx.approvalRequired.has(p));
}

/** Queues the change and returns the 202 body; callers `return` it from the route. */
export async function queueForApproval(res: Response, ctx: Ctx, input: Parameters<typeof requestApproval>[1]) {
  const approval = await requestApproval(ctx, input);
  return res.status(202).json({ success: true, data: { pendingApproval: true, approval } });
}

export async function requestApproval(
  ctx: Ctx,
  input: { kind: ApprovalKind; entity: string; entityId?: Types.ObjectId; label: string; payload?: unknown; before?: unknown; reason?: string; link?: string },
) {
  if (input.entityId && input.kind !== 'hr_request') {
    const dup = await ApprovalRequest.exists({ company: ctx.companyId, entityId: input.entityId, kind: input.kind, status: 'pending' });
    if (dup) throw AppError.conflict('An approval request for this change is already pending');
  }
  const a = await ApprovalRequest.create({
    company: ctx.companyId,
    kind: input.kind,
    entity: input.entity,
    entityId: input.entityId,
    label: input.label,
    payload: input.payload,
    before: input.before ? JSON.parse(JSON.stringify(input.before)) : undefined,
    reason: input.reason,
    requestedBy: ctx.userId,
  });
  await audit(ctx, 'request_approval', input.entity, input.entityId, `Approval requested: ${input.label}`);
  await notifyPermission(
    ctx.companyId,
    ['approvals.manage'],
    { type: 'approval', title: 'Approval needed', message: `${ctx.userName} requested: ${input.label}`, link: input.link ?? '/approvals' },
    ctx.userId,
  );
  return a.toObject();
}

export async function decideApproval(ctx: Ctx, id: string, decision: 'approve' | 'reject', note?: string) {
  if (!can(ctx, 'approvals.manage')) throw AppError.forbidden();
  const a = await ApprovalRequest.findOne({ _id: id, company: ctx.companyId });
  if (!a) throw AppError.notFound('Approval request');
  if (a.status !== 'pending') throw AppError.badRequest(`This request was already ${a.status}`);
  const handler = handlers.get(a.kind);
  // Handlers can read who decided and the note (e.g. to copy it onto an HR request).
  a.reviewNote = note;
  a.reviewedBy = ctx.userId;

  if (decision === 'approve') {
    if (!handler) throw AppError.badRequest(`No handler for ${a.kind}`);
    // The reviewer's context executes the change with full rights for the affected module.
    const execCtx: Ctx = { ...ctx, isSuperAdmin: true };
    try {
      await handler.approve(execCtx, a);
    } catch (err) {
      a.error = err instanceof Error ? err.message : String(err);
      await a.save();
      throw err;
    }
    a.status = 'approved';
  } else {
    await handler?.reject?.(ctx, a);
    a.status = 'rejected';
  }
  a.reviewedBy = ctx.userId;
  a.reviewNote = note;
  a.reviewedAt = new Date();
  a.error = undefined;
  await a.save();
  await audit(ctx, decision === 'approve' ? 'approve' : 'reject', a.entity, a.entityId, `${decision === 'approve' ? 'Approved' : 'Declined'}: ${a.label}${note ? ` (${note})` : ''}`);
  const requester = await User.findById(a.requestedBy).select('_id').lean();
  if (requester) {
    await notifyUsers(ctx.companyId, [requester._id], {
      type: decision === 'approve' ? 'success' : 'warning',
      title: `Request ${decision === 'approve' ? 'approved' : 'declined'}`,
      message: `${a.label}${note ? ` — ${note}` : ''}`,
      // Leave and advance requests are followed from the staff member's own HR page.
      link: a.kind === 'hr_request' ? '/hr/me' : `/approvals?status=${a.status}`,
    });
  }
  return a.toObject();
}
