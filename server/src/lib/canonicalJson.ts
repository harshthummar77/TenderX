/**
 * Deterministic JSON — the input to a seal hash (08 §1).
 *
 * `JSON.stringify` preserves insertion order, which means the same bid hashes
 * one way when it is built from a Zod-parsed request body and another way when
 * it is rebuilt from Prisma rows. `verify-seal` would then report tampering on
 * an untouched bid, which is worse than not verifying at all.
 *
 * The rules, and there are only three:
 *   1. object keys sorted, recursively;
 *   2. `undefined` members dropped (a key that is absent and a key that is
 *      `undefined` must hash identically);
 *   3. arrays keep their order — the caller sorts them if order is not
 *      meaningful, because only the caller knows the sort key.
 *
 * Deliberately narrow: pass it strings, never Decimals or Dates. `sealing.ts`
 * converts money with `toApi` and quantities with `qtyToApi` first, so the hash
 * depends on the value rather than on decimal.js's trailing-zero behaviour.
 *
 * `lib/audit.ts` carries its own copy for the hash chain. Two short functions
 * beat one shared one here: the audit chain's canonical form is frozen by rows
 * already written, and it must not move when this one does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);

  return `{${entries.join(',')}}`;
}
