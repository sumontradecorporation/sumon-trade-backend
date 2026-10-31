import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
const ALLOWED = new Set([
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml',
    'application/pdf',
    'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
]);
const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
        const now = new Date();
        const tenant = req.ctx?.companyId ? String(req.ctx.companyId) : req.user?.company ? String(req.user.company) : 'platform';
        const rel = path.join(tenant, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
        const dir = path.join(env.storageDir, rel);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
        cb(null, `${crypto.randomUUID()}${ext}`);
    },
});
export const upload = multer({
    storage,
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED.has(file.mimetype))
            cb(null, true);
        else
            cb(new AppError(400, `File type ${file.mimetype} is not allowed`, 'UPLOAD_TYPE'));
    },
});
/** In-memory upload for files that are parsed and discarded (Excel imports). */
export const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 } });
//# sourceMappingURL=upload.js.map