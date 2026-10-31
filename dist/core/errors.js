export class AppError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, message, code = 'ERROR', details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = 'AppError';
    }
    static badRequest(message, details) {
        return new AppError(400, message, 'BAD_REQUEST', details);
    }
    static unauthorized(message = 'Authentication required') {
        return new AppError(401, message, 'UNAUTHORIZED');
    }
    static forbidden(message = 'You do not have permission to perform this action') {
        return new AppError(403, message, 'FORBIDDEN');
    }
    static notFound(what = 'Resource') {
        return new AppError(404, `${what} not found`, 'NOT_FOUND');
    }
    static conflict(message) {
        return new AppError(409, message, 'CONFLICT');
    }
}
//# sourceMappingURL=errors.js.map