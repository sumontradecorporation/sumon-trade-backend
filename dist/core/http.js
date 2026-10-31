import { Types } from 'mongoose';
import { AppError } from './errors.js';
export function ok(res, data, meta, status = 200) {
    return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}
export function created(res, data) {
    return ok(res, data, undefined, 201);
}
export function pageQuery(req, defLimit = 50, maxLimit = 500) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defLimit));
    return { page, limit, skip: (page - 1) * limit };
}
export function pageMeta(total, q) {
    return { total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) };
}
export function oid(id, what = 'id') {
    if (typeof id !== 'string' || !Types.ObjectId.isValid(id))
        throw AppError.badRequest(`Invalid ${what}`);
    return new Types.ObjectId(id);
}
export function optOid(id) {
    return typeof id === 'string' && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : undefined;
}
export function str(v) {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
export function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function searchRegex(v) {
    const s = str(v);
    return s ? new RegExp(escapeRegex(s), 'i') : undefined;
}
export function dateRange(from, to) {
    const range = {};
    const f = str(from);
    const t = str(to);
    if (f)
        range.$gte = startOfDay(new Date(f));
    if (t)
        range.$lte = endOfDay(new Date(t));
    return Object.keys(range).length ? range : undefined;
}
export function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}
export function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
}
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
//# sourceMappingURL=http.js.map