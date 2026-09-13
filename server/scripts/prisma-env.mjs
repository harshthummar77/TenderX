/**
 * Run a Prisma CLI command against a specific env file.
 *
 *   node scripts/prisma-env.mjs .env.test migrate deploy
 *   node scripts/prisma-env.mjs .env.test migrate status
 *
 * The Prisma CLI only ever reads `.env` from the working directory, so without
 * this wrapper there is no way to migrate the Neon `test` branch without
 * editing `.env` by hand — which is exactly how a test run ends up pointed at
 * `dev`. Values already present in the environment still win.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [envFileArg, ...prismaArgs] = process.argv.slice(2);

if (!envFileArg || prismaArgs.length === 0) {
  console.error('usage: node scripts/prisma-env.mjs <env-file> <prisma args...>');
  process.exit(1);
}

const envFile = fileURLToPath(new URL(`../${envFileArg}`, import.meta.url));
if (!existsSync(envFile)) {
  console.error(`env file not found: ${envFile}`);
  process.exit(1);
}
process.loadEnvFile(envFile);

const host = (url) => url?.match(/@([^/]+)\//)?.[1] ?? 'unknown';
console.log(`[prisma-env] ${envFileArg} -> ${host(process.env.DIRECT_URL)}`);

const result = spawnSync('npx', ['prisma', ...prismaArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
