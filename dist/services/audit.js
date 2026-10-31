import { AuditLog } from '../models/index.js';
import { logger } from '../config/logger.js';
/** Strips heavy / sensitive fields before storing snapshots. */
function snapshot(doc) {
    if (!doc || typeof doc !== 'object')
        return undefined;
    const plain = JSON.parse(JSON.stringify(doc));
    delete plain.passwordHash;
    delete plain.settings;
    return plain;
}
export async function audit(ctx, action, entity, entityId, label, before, after) {
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
    }
    catch (err) {
        // Audit failures must never break the business operation.
        logger.error({ err }, 'audit log write failed');
    }
}
//# sourceMappingURL=audit.js.map