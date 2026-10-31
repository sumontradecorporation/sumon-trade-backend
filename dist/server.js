import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { runMigrations } from './services/migrations.js';
import fs from 'node:fs';
async function main() {
    fs.mkdirSync(env.storageDir, { recursive: true });
    await connectDB();
    await runMigrations();
    const app = createApp();
    const server = app.listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}`));
    if (env.ENABLE_JOBS)
        startJobs();
    const shutdown = async (signal) => {
        logger.info(`${signal} received, shutting down`);
        stopJobs();
        server.close(async () => {
            await disconnectDB();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
}
main().catch((err) => {
    logger.fatal({ err }, 'Failed to start');
    process.exit(1);
});
//# sourceMappingURL=server.js.map