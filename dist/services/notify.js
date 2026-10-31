import { Notification, Role, User } from '../models/index.js';
import { logger } from '../config/logger.js';
export async function notifyUsers(companyId, userIds, n) {
    const unique = [...new Set(userIds.map(String))];
    if (!unique.length)
        return;
    try {
        await Notification.insertMany(unique.map((u) => ({ company: companyId, user: u, ...n })));
    }
    catch (err) {
        logger.error({ err }, 'notification insert failed');
    }
}
/**
 * Users holding any of the given permissions, plus all super admins. Every user works in every company with their own
 * role, so roles of any company count — an approver whose home is another company still hears about this one.
 */
export async function usersWithPermission(perms) {
    const roles = await Role.find({ $or: [{ permissions: { $in: perms } }, { isSystem: true }] }).select('_id').lean();
    const users = await User.find({
        status: 'active',
        $or: [{ isSuperAdmin: true }, { role: { $in: roles.map((r) => r._id) } }],
    })
        .select('_id')
        .lean();
    return users.map((u) => u._id);
}
export async function notifyPermission(companyId, perms, n, exceptUser) {
    const ids = (await usersWithPermission(perms)).filter((id) => !exceptUser || String(id) !== String(exceptUser));
    await notifyUsers(companyId, ids, n);
}
//# sourceMappingURL=notify.js.map