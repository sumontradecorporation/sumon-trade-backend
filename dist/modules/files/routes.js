import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { can } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, ok, oid } from '../../core/http.js';
import { companyContext } from '../../middleware/company.js';
import { upload } from '../../middleware/upload.js';
import { FileAsset } from '../../models/index.js';
const router = Router();
/** POST /files — multipart field "files" (or "file"). Stored on hosting storage. */
router.post('/', companyContext, upload.any(), async (req, res) => {
    const ctx = req.ctx;
    const files = req.files ?? [];
    if (!files.length)
        throw AppError.badRequest('No file uploaded');
    const docs = await FileAsset.insertMany(files.map((f) => ({
        company: ctx.companyId,
        originalName: f.originalname,
        mime: f.mimetype,
        size: f.size,
        path: path.relative(env.storageDir, f.path),
        context: typeof req.body?.context === 'string' ? req.body.context : undefined,
        uploadedBy: ctx.userId,
    })));
    created(res, docs.map((d) => d.toObject()));
});
/** GET /files/:id — streams a file after checking tenant access. Used directly by <img>/<a>. */
router.get('/:id', async (req, res) => {
    const file = await FileAsset.findById(oid(req.params.id)).lean();
    if (!file)
        throw AppError.notFound('File');
    // Every signed-in user can work in every company, so any company's files are readable once signed in
    const abs = path.resolve(env.storageDir, file.path);
    if (!abs.startsWith(env.storageDir) || !fs.existsSync(abs))
        throw AppError.notFound('File');
    res.setHeader('Content-Type', file.mime ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.originalName ?? 'file')}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.mime === 'image/svg+xml')
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    fs.createReadStream(abs).pipe(res);
});
router.delete('/:id', companyContext, async (req, res) => {
    const ctx = req.ctx;
    const file = await FileAsset.findOne({ _id: oid(req.params.id), company: ctx.companyId });
    if (!file)
        throw AppError.notFound('File');
    // Documents, items and the company profile point at files, so only the uploader or an admin may remove one.
    if (String(file.uploadedBy) !== String(ctx.userId) && !can(ctx, 'settings.manage'))
        throw AppError.forbidden();
    await file.deleteOne();
    fs.promises.unlink(path.resolve(env.storageDir, file.path)).catch(() => undefined);
    ok(res, { deleted: true });
});
export default router;
//# sourceMappingURL=routes.js.map