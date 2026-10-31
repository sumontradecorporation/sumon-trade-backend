import pino from 'pino';
import { env } from './env.js';
export const logger = pino({
    level: env.NODE_ENV === 'test' ? 'silent' : env.isProd ? 'info' : 'debug',
    transport: env.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
    redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.passwordHash'],
});
//# sourceMappingURL=logger.js.map