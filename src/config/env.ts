import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

// Business dates are stored as UTC midnight and MongoDB groups dates in UTC, so the server's own day and
// month boundaries are computed in UTC too, whatever the host's time zone is.
process.env.TZ = 'UTC';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: bool,
  COOKIE_DOMAIN: z.string().optional(),
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().default(10),
  /** Key for secrets stored in the database (mailbox passwords). Falls back to JWT_REFRESH_SECRET. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .refine((v) => !v || v.length >= 32, 'DATA_ENCRYPTION_KEY must be at least 32 characters'),
  SUPERADMIN_NAME: z.string().default('Super Admin'),
  SUPERADMIN_EMAIL: z.string().email().default('admin@example.com'),
  SUPERADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
  ENABLE_JOBS: z.string().optional().transform((v) => v !== 'false'),
  APP_URL: z.string().default('http://localhost:3000'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n', z.prettifyError(parsed.error));
  process.exit(1);
}
if (parsed.data.NODE_ENV === 'production' && [parsed.data.JWT_ACCESS_SECRET, parsed.data.JWT_REFRESH_SECRET].some((s) => s.startsWith('change-me'))) {
  console.error('Invalid environment configuration:\n JWT_ACCESS_SECRET and JWT_REFRESH_SECRET still hold the example values. Set them to long random strings.');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  storageDir: process.env.VERCEL ? '/tmp/storage' : path.resolve(process.cwd(), parsed.data.STORAGE_DIR),
};
