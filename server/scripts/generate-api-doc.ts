/**
 * Generate docs/api.md by walking the Express router (plan 20 §3).
 *
 * One source of truth: the router stack. Hand-maintained endpoint tables drift
 * on the first merge; this script re-reads the live router every time it runs.
 *
 *   npm run docs:api        (from the server workspace or the repo root)
 *
 * Reads nothing but the compiled app's router stack, so there are no side
 * effects — but the app's module-level code runs during import, including the
 * env parse, so a missing env will crash this script the same way it crashes
 * the real server.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const PREFIX = '/api/v1';

interface RouteRow { method: string; path: string; handlers: string[] }

const stack: any[] = (app as any)._router?.stack ?? (app as any).router?.stack ?? [];

/** Flatten nested routers back into a single list of leaf routes. */
function collect(stack: any[], prefix: string): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      const handlers = (layer.route.stack as any[]).map((s) => s.name as string).filter(Boolean);
      for (const method of Object.keys(layer.route.methods)) {
        rows.push({ method: method.toUpperCase(), path, handlers });
      }
    } else if (layer.handle?.stack) {
      rows.push(...collect(layer.handle.stack, prefix));
    }
  }
  return rows;
}

const rows = collect(stack, PREFIX).filter((r) => !r.path.includes('/_test/'));
rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

/** The permission a route requires, derived from the middleware's `.name`. */
function guardOf(handlers: string[]): string {
  const names = handlers.filter((n) => n.startsWith('permission') || n === 'authenticate' || n === 'roleGuard');
  if (names.length === 0) return 'public';
  if (names.length === 1 && names[0] === 'authenticate') return 'authenticated';
  return names.join(' · ');
}

/** Group routes by their module (first path segment after the prefix). */
function moduleOf(path: string): string {
  const rest = path.slice(PREFIX.length).replace(/^\//, '');
  const first = rest.split('/')[0] ?? 'root';
  if (first === 'vendor') return 'vendor (own data)';
  return first || 'root';
}

const byModule = new Map<string, RouteRow[]>();
for (const row of rows) {
  const mod = moduleOf(row.path);
  const bucket = byModule.get(mod) ?? [];
  bucket.push(row);
  byModule.set(mod, bucket);
}

const now = new Date().toISOString().slice(0, 10);
const lines: string[] = [];
lines.push('# API reference');
lines.push('');
lines.push(`Generated on **${now}** by \`server/scripts/generate-api-doc.ts\`. Do not hand-edit — rerun the script.`);
lines.push('');
lines.push(`Every path is prefixed with \`${PREFIX}\`. The *Guard* column names the middleware on each route, in order.`);
lines.push('');
lines.push(`**${rows.length} routes** across ${byModule.size} modules.`);
lines.push('');

for (const mod of [...byModule.keys()].sort()) {
  lines.push(`## ${mod}`);
  lines.push('');
  lines.push('| Method | Path | Guard |');
  lines.push('|---|---|---|');
  for (const row of byModule.get(mod)!) {
    lines.push(`| \`${row.method}\` | \`${row.path}\` | ${guardOf(row.handlers)} |`);
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('`authenticated` means `authenticate` with no further permission check: these are own-account endpoints where ownership is enforced in the service rather than by a permission (see [security.md](security.md#identity-vs-tenant-routes)).');

const out = join(repoRoot, 'docs', 'api.md');
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`wrote ${out} (${rows.length} routes)`);
process.exit(0);
