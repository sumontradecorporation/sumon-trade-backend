import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import fs from 'node:fs';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { logger } from './config/logger.js';
import { authenticate } from './middleware/auth.js';
import { companyContext } from './middleware/company.js';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './modules/auth/routes.js';
import companyRoutes from './modules/companies/routes.js';
import userRoutes from './modules/users/routes.js';
import roleRoutes from './modules/roles/routes.js';
import fileRoutes from './modules/files/routes.js';
import metaRoutes from './modules/meta/routes.js';
import partyRoutes from './modules/parties/routes.js';
import itemRoutes from './modules/items/routes.js';
import transactionRoutes from './modules/transactions/routes.js';
import financeRoutes from './modules/finance/routes.js';
import dashboardRoutes from './modules/dashboard/routes.js';
import reportRoutes from './modules/reports/routes.js';
import settingsRoutes from './modules/settings/routes.js';
import hrRoutes from './modules/hr/routes.js';
import systemRoutes from './modules/system/routes.js';
import emailRoutes from './modules/email/routes.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
const DB_STATES = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
};
export function createApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
    app.use(cors({ origin: env.corsOrigins, credentials: true }));
    app.use(compression());
    app.use(cookieParser());
    app.use(express.json({ limit: '5mb' }));
    app.use(express.urlencoded({ extended: true, limit: '5mb' }));
    app.use(pinoHttp({
        logger,
        genReqId: (req, res) => {
            const id = req.headers['x-request-id'] || crypto.randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
        },
        autoLogging: { ignore: (req) => req.url === '/api/health' },
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }));
    app.get('/', (_req, res) => {
        const dbState = mongoose.connection.readyState;
        res.json({
            success: true,
            data: {
                name: pkg.name,
                version: pkg.version,
                api: 'ok',
                environment: env.NODE_ENV,
                database: {
                    status: DB_STATES[dbState] ?? 'unknown',
                    name: mongoose.connection.name ?? null,
                },
                jobs: env.ENABLE_JOBS ? 'enabled' : 'disabled',
                uptimeSeconds: Math.round(process.uptime()),
                time: new Date().toISOString(),
                routes: [
                    '/api/health',
                    '/api/v1/auth',
                    '/api/v1/meta',
                    '/api/v1/companies',
                    '/api/v1/files',
                    '/api/v1/users',
                    '/api/v1/roles',
                    '/api/v1/parties',
                    '/api/v1/items',
                    '/api/v1/transactions',
                    '/api/v1/finance',
                    '/api/v1/dashboard',
                    '/api/v1/reports',
                    '/api/v1/settings',
                    '/api/v1/hr',
                    '/api/v1/system',
                    '/api/v1/email',
                ],
            },
        });
    });
    app.get('/api/health', (_req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));
    const v1 = express.Router();
    v1.use('/auth', authRoutes);
    v1.use('/meta', metaRoutes);
    v1.use('/companies', authenticate, companyRoutes);
    v1.use('/files', authenticate, fileRoutes);
    // Everything below is tenant scoped: authenticated user + X-Company-Id
    const scoped = express.Router();
    scoped.use(authenticate, companyContext);
    scoped.use('/users', userRoutes);
    scoped.use('/roles', roleRoutes);
    scoped.use('/parties', partyRoutes);
    scoped.use('/items', itemRoutes);
    scoped.use('/transactions', transactionRoutes);
    scoped.use('/finance', financeRoutes);
    scoped.use('/dashboard', dashboardRoutes);
    scoped.use('/reports', reportRoutes);
    scoped.use('/settings', settingsRoutes);
    scoped.use('/hr', hrRoutes);
    scoped.use('/system', systemRoutes);
    scoped.use('/email', emailRoutes);
    v1.use(scoped);
    app.use('/api/v1', v1);
    app.use(notFound);
    app.use(errorHandler);
    return app;
}
// Serverless entry (Vercel): lazily connects and reuses the DB connection across warm invocations.
let serverlessApp = null;
let connecting = null;
export default async function handler(req, res) {
    if (mongoose.connection.readyState !== 1) {
        connecting ??= connectDB().finally(() => (connecting = null));
        await connecting;
    }
    if (!serverlessApp) {
        fs.mkdirSync(env.storageDir, { recursive: true });
        serverlessApp = createApp();
    }
    return serverlessApp(req, res);
}
//# sourceMappingURL=app.js.map