import type { Types } from 'mongoose';
import { AuditLog } from '../models/index.js';
import { logger } from '../config/logger.js';
import type { Ctx } from '../core/ctx.js';

export type AuditAction =
  | 'create' | 'update' | 'delete' | 'cancel' | 'convert' | 'login' | 'logout' | 'approve' | 'reject'
  | 'request_approval' | 'withdraw' | 'adjust_stock' | 'import' | 'export' | 'upload' | 'restore' | 'archive' | 'pay' | 'email' | 'reset_password'
  | 'mark_attendance' | 'check_in' | 'check_out';

/** Strips heavy / sensitive fields before storing snapshots. */
function snapshot(doc: unknown) {
  if (!doc || typeof doc !== 'object') return undefined;
  const plain = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  delete plain.passwordHash;
  delete plain.settings;
  return plain;
}

export async function audit(
  ctx: Partial<Pick<Ctx, 'companyId' | 'userId' | 'userName' | 'ip' | 'ua'>> | null,
  action: AuditAction,
  entity: string,
  entityId: Types.ObjectId | string | undefined | null,
  label: string,
  before?: unknown,
  after?: unknown,
) {
  try {
    await AuditLog.create({
      company: ctx?.companyId,
      user: ctx?.userId,
      userName: ctx?.userName,
      action,
      entity,
      entityId: entityId ?? undefined,
      label,
      before: snapshot(before),
      after: snapshot(after),
      ip: ctx?.ip,
      userAgent: ctx?.ua,
    });
  } catch (err) {
    // Audit failures must never break the business operation.
    logger.error({ err }, 'audit log write failed');
  }
}
