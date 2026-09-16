import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load the right env file — no dotenv dependency.
 *
 * NODE_ENV=test loads `server/.env.test`, which points at the Neon `test`
 * branch. Everything else loads `server/.env`. Real environments (Render, CI)
 * inject variables directly and have no file at all.
 *
 * **The selected file wins over anything already in process.env**, and that is
 * deliberate. `@prisma/client` runs its own dotenv loader when it is imported,
 * so a module that imports `prisma` before this file would otherwise seed
 * `DATABASE_URL` from plain `.env` — and a test run would quietly point at the
 * `dev` branch, which the truncation guard would then refuse. Import order must
 * not decide which database the suite talks to.
 */
const envFileName = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
const envFile = fileURLToPath(new URL(envFileName, import.meta.url));

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = (rawValue ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
    process.env[key as string] = value;
  }
}

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
