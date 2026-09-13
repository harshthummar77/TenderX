import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load the right env file with Node's built-in loader — no dotenv dependency.
 * Real environments (Render, CI) inject variables directly and have no file.
 *
 * NODE_ENV=test loads server/.env.test, which points at the Neon `test` branch.
 * The suite truncates tables between files, so this one line is what stops
 * `npm test` from ever reaching `dev` or `main`.
 */
const envFileName = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
const envFile = fileURLToPath(new URL(envFileName, import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * The ONLY file in the codebase that reads process.env.
 * Parsed once, at import time — invalid config kills the process at boot in
 * every environment, instead of at 2 a.m. in production.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

  APP_URL: z.string().url(), // client origin, used for CORS + email links
  API_URL: z.string().url(),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('TenderBridge <no-reply@tenderbridge.local>'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console -- the logger itself depends on env
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  process.exit(1);
}
