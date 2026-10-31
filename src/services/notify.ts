import type { Types } from 'mongoose';
import { Notification, Role, User } from '../models/index.js';
import { logger } from '../config/logger.js';

interface NotifyInput {
  title: string;
  message?: string;
  link?: string;
  type?: 'info' | 'success' | 'warning' | 'approval' | 'error';
}

export async function notifyUsers(companyId: Types.ObjectId | undefined, userIds: (Types.ObjectId | string)[], n: NotifyInput) {
  const unique = [...new Set(userIds.map(String))];
  if (!unique.length) return;
  try {
    await Notification.insertMany(unique.map((u) => ({ company: companyId, user: u, ...n })));
  } catch (err) {
    logger.error({ err }, 'notification insert failed');
  }
}

/**
 * Users holding any of the given permissions, plus all super admins. Every user works in every company with their own
 * role, so roles of any company count — an approver whose home is another company still hears about this one.
 */
export async function usersWithPermission(perms: string[]) {
  const roles = await Role.find({ $or: [{ permissions: { $in: perms } }, { isSystem: true }] }).select('_id').lean();
  const users = await User.find({
    status: 'active',
    $or: [{ isSuperAdmin: true }, { role: { $in: roles.map((r) => r._id) } }],
  })
    .select('_id')
    .lean();
  return users.map((u) => u._id);
}

export async function notifyPermission(companyId: Types.ObjectId, perms: string[], n: NotifyInput, exceptUser?: Types.ObjectId) {
  const ids = (await usersWithPermission(perms)).filter((id) => !exceptUser || String(id) !== String(exceptUser));
  await notifyUsers(companyId, ids, n);
}
