import cron from 'node-cron';
import { logger } from '../config/logger.js';
import { runDailySummary, runInboxSync, runLowStockAlerts, runPaymentReminders } from '../services/automations.js';
const tasks = [];
function schedule(name, expr, fn) {
    tasks.push(cron.schedule(expr, async () => {
        try {
            await fn();
            logger.debug(`job ${name} done`);
        }
        catch (err) {
            logger.error({ err }, `job ${name} failed`);
        }
    }));
}
export function startJobs() {
    // Hourly: each company acts at 8 AM (low stock), 9 AM (reminders) and 9 PM (summary) of its own time zone.
    schedule('payment-reminders', '0 * * * *', runPaymentReminders);
    schedule('daily-summary', '0 * * * *', runDailySummary);
    schedule('low-stock', '0 * * * *', runLowStockAlerts);
    schedule('imap-sync', '*/15 * * * *', runInboxSync);
    logger.info(`${tasks.length} scheduled jobs started`);
}
export function stopJobs() {
    for (const t of tasks)
        void t.stop();
}
//# sourceMappingURL=index.js.map