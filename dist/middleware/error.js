import mongoose from 'mongoose';
import { ZodError } from 'zod';
import multer from 'multer';
import { AppError } from '../core/errors.js';
import { logger } from '../config/logger.js';
export function notFound(req, _res, next) {
    next(new AppError(404, `Route ${req.method} ${req.originalUrl} not found`, 'ROUTE_NOT_FOUND'));
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err, req, res, _next) {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let details;
    if (err instanceof AppError) {
        ({ statusCode: status, code, message } = err);
        details = err.details;
    }
    else if (err instanceof ZodError) {
        status = 422;
        code = 'VALIDATION_ERROR';
        details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        const first = err.issues[0];
        message = first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input';
    }
    else if (err instanceof mongoose.Error.ValidationError) {
        status = 422;
        code = 'VALIDATION_ERROR';
        message = Object.values(err.errors)[0]?.message ?? 'Invalid data';
    }
    else if (err instanceof mongoose.Error.CastError) {
        status = 400;
        code = 'BAD_ID';
        message = `Invalid ${err.path}`;
    }
    else if (err instanceof multer.MulterError) {
        status = 400;
        code = 'UPLOAD_ERROR';
        message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message;
    }
    else if (typeof err === 'object' && err && err.code === 11000) {
        status = 409;
        code = 'DUPLICATE';
        const key = Object.keys(err.keyValue ?? {}).filter((k) => k !== 'company')[0];
        const friendly = {
            email: 'This email address is already used by another login',
            phone: 'This phone number is already used by another login',
            number: 'This number is already used by another document',
            code: 'This code is already in use',
        };
        message = key ? (friendly[key] ?? `A record with this ${key} already exists`) : 'Duplicate record';
    }
    else if (typeof err === 'object' && err && 'type' in err && err.type === 'entity.parse.failed') {
        status = 400;
        code = 'BAD_JSON';
        message = 'Malformed JSON body';
    }
    if (status >= 500)
        logger.error({ err, url: req.originalUrl }, 'Unhandled error');
    res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
}
//# sourceMappingURL=error.js.map