#!/usr/bin/env node
/**
 * The three self-review checks from plan 18 §6, as a script.
 *
 * They replace the custom ESLint rules that 00 §3 cut: three scans cost nothing
 * and catch the three mistakes that actually matter here. Written in Node
 * rather than as shell greps so it runs the same from cmd, PowerShell and bash.
 *
 * The plan writes them as `grep -i "amount\|price\|total"` over the whole line,
 * which flags `Number(item.taxRatePercent)` on a line that happens to mention
 * cgstAmount — fifteen false positives on this codebase, which is how a check
 * gets ignored. These match the ARGUMENT instead, and the status rule only
 * applies to models that actually have a state machine.
 *
 * Exits non-zero and prints `file:line` for every hit, so CI fails the build.
 * An audited exception carries a trailing `// not money` comment.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: the repo path contains spaces, which a URL
// keeps percent-encoded.
const ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** Money fields, as they are actually named in the schema and the DTOs. */
const MONEY = String.raw`(amount|price|total|subtotal|outstanding|paid|balance|freight|tds|retention|gross|net)`;

/**
 * Audited exceptions, kept here rather than as comments in the services so the
 * whole debt is one list. Each needs a reason that says why the convention
 * cannot apply — not why it was inconvenient.
 */
const EXCEPTIONS = [
  {
    file: join('modules', 'payment', 'payment.service.ts'),
    match: /invoice\.update/,
    reason:
      'the payment ledger writes invoice.status directly. Settling goes forward legally, but a ' +
      'returned payment has to roll PAID back and INVOICE_TRANSITIONS makes PAID terminal — ' +
      'transitionInvoice would throw. Real debt: revisit if the invoice machine gains a reverse edge.',
  },
  {
    file: join('modules', 'tender', 'deadline.service.ts'),
    match: /quotation\.updateMany/,
    reason:
      'bulk abandon of never-submitted drafts when a deadline passes. Per-row transitions would be ' +
      'N queries and N audit rows for bids nobody placed.',
  },
  {
    file: join('modules', 'vendor', 'vendor.service.ts'),
    match: /vendor\.update/,
    reason:
      'the vendor machine returns its target status from assertTransition() rather than owning a ' +
      'transition helper, so this write IS the machine applying it (06 §1).',
  },
];

const isException = (file, code) =>
  EXCEPTIONS.some((e) => file.endsWith(e.file) && e.match.test(code));

const RULES = [
  {
    name: 'status written outside a state machine',
    why: "Every status change goes through its module's transition function (00 §6).",
    // Only for models that have one — organizations deliberately do not.
    appliesTo: (file) => hasStateMachine(file) && !basename(file).includes('stateMachine'),
    /*
     * Scanned over the whole file rather than line by line, because a Prisma
     * call wraps across lines — but only `update`/`updateMany`, since a
     * `create` setting an initial status is not a transition. `[^;]` keeps the
     * match inside one statement and `[^}]` inside the one `data` object, so a
     * neighbouring `where: { status }` filter is not mistaken for a write.
     */
    scan: (source) =>
      source.matchAll(/\.update(?:Many)?\(\s*\{[^;]*?data:\s*\{[^}]*?\bstatus\b\s*:/g),
  },
  {
    name: 'money through a float',
    why: 'Money is decimal.js. Use money()/round2() from lib/money (00 §6).',
    appliesTo: () => true,
    test: (code) =>
      /\bparseFloat\s*\(/.test(code) ||
      new RegExp(String.raw`\bNumber\s*\(\s*[A-Za-z0-9_.\[\]'"]*${MONEY}`, 'i').test(code),
  },
  {
    name: 'process.env outside config/env',
    why: 'config/env.ts is the only file that reads the environment.',
    appliesTo: (file) => !file.endsWith(join('config', 'env.ts')),
    test: (code) => /process\.env/.test(code),
  },
];

/** True when this file sits in a module that owns a `*.stateMachine.ts`. */
function hasStateMachine(file) {
  try {
    return readdirSync(dirname(file)).some((entry) => entry.endsWith('.stateMachine.ts'));
  } catch {
    return false;
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) yield full;
  }
}

let hits = 0;

const report = (file, lineNo, line, rule) => {
  hits += 1;
  console.log(`${relative(process.cwd(), file)}:${lineNo}  ${rule.name}`);
  console.log(`    ${line.trim()}`);
  console.log(`    ${rule.why}`);
};

for (const file of walk(ROOT)) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const lineOf = (index) => source.slice(0, index).split('\n').length;

  for (const rule of RULES) {
    if (!rule.appliesTo(file)) continue;

    if (rule.scan) {
      for (const match of rule.scan(source)) {
        const lineNo = lineOf(match.index ?? 0);
        const line = lines[lineNo - 1] ?? '';
        if (isException(file, `${line}
${match[0]}`)) continue;
        report(file, lineNo, line, rule);
      }
      continue;
    }

    lines.forEach((line, index) => {
      if (/\/\/\s*not money\b/.test(line)) return;

      const code = line.split('//')[0] ?? '';
      if (!rule.test(code)) return;
      if (isException(file, code)) return;

      report(file, index + 1, line, rule);
    });
  }
}

if (hits > 0) {
  console.log(`\n${hits} convention violation${hits === 1 ? '' : 's'}.`);
  process.exit(1);
}
