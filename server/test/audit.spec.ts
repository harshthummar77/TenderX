import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/lib/canonicalJson.js';
import { redact, REDACTED, verifyAuditChain, writeAudit } from '../src/lib/audit.js';
import { prisma } from '../src/lib/prisma.js';
import { verifyChain } from '../src/modules/activity/activity.service.js';
import { makeOrganization, makeUser } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * The hash-chained audit log (plan 14 Part C).
 *
 * Every row carries the hash of the one before it, so altering row 400
 * invalidates 401 and everything after. Tampering is detectable with no external
 * system, no signature authority and one query.
 *
 * Chain writes are serialised by an advisory lock, so building a long chain is
 * hundreds of sequential round trips to Neon. The file gets its own budget.
 */
vi.setConfig({ testTimeout: 180_000 });

const actor = { userId: null, email: 'test@example.test', role: null };

const write = (action: string, overrides: Record<string, unknown> = {}) =>
  prisma.$transaction((tx) =>
    writeAudit(tx, {
      action,
      entityType: 'Test',
      entityId: null,
      summary: `${action} happened`,
      actor,
      ...overrides,
    }),
  );

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* canonicalJson                                                              */
/* -------------------------------------------------------------------------- */

describe('canonicalJson', () => {
  /**
   * Without this, two logically identical objects hash differently depending on
   * key insertion order, and a Node version change silently breaks every
   * historical hash.
   */
  it('does not depend on key order, at any depth', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalJson({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('treats an absent key and an undefined one alike', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

describe('redact', () => {
  /**
   * **A leak in the audit table is worse than one in the logs.** Two CREATE RULE
   * statements stop the application deleting from it, so a secret written here
   * cannot be taken back out.
   */
  it('replaces every sensitive key, at every depth', () => {
    const redacted = redact({
      email: 'keep@example.test',
      passwordHash: 'bcrypt-hash',
      nested: {
        tokenHash: 'abc',
        bankAccountNumber: '123456784821',
        deep: [{ resetTokenHash: 'xyz' }],
      },
    });

    expect(redacted.email).toBe('keep@example.test');
    expect(redacted.passwordHash).toBe(REDACTED);
    expect(redacted.nested.tokenHash).toBe(REDACTED);
    expect(redacted.nested.bankAccountNumber).toBe(REDACTED);
    expect(redacted.nested.deep[0]!.resetTokenHash).toBe(REDACTED);
  });

  /** The key survives, so the diff still shows the field changed. */
  it('keeps the key so an auditor can see that it changed', () => {
    const redacted = redact({ bankAccountNumber: '999' });
    expect(Object.keys(redacted)).toContain('bankAccountNumber');
  });

  it('leaves primitives and arrays of primitives alone', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact([1, 2, 3])).toEqual([1, 2, 3]);
    expect(redact(null)).toBeNull();
  });

  /** Plan 14 acceptance — nothing secret reaches the table, even if passed in. */
  it('strips secrets on the way into the table', async () => {
    const org = await makeOrganization('Redaction Test Ltd');
    await write('vendor.bank_changed', {
      organizationId: org.id,
      before: { bankAccountNumber: '111111111111' },
      after: { bankAccountNumber: '222222222222', passwordHash: 'should-not-persist' },
    });

    const row = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'vendor.bank_changed' },
    });

    const stored = JSON.stringify([row.before, row.after]);
    expect(stored).not.toContain('111111111111');
    expect(stored).not.toContain('222222222222');
    expect(stored).not.toContain('should-not-persist');
    expect(stored).toContain(REDACTED);
  });
});

/* -------------------------------------------------------------------------- */
/* The chain                                                                  */
/* -------------------------------------------------------------------------- */

describe('the hash chain', () => {
  it('links each row to the one before it', async () => {
    const first = await write('one');
    const second = await write('two');
    const third = await write('three');

    expect(first.previousHash).toBeNull();
    expect(second.previousHash).toBe(first.hash);
    expect(third.previousHash).toBe(second.hash);
  });

  /**
   * Plan 14 acceptance — a long chain verifies clean.
   *
   * Written in one transaction rather than two hundred: the advisory lock makes
   * each write a round trip, and the point of the test is the chain, not the
   * transaction overhead.
   */
  it('verifies a chain of 200 rows', async () => {
    await prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < 200; i++) {
          await writeAudit(tx, {
            action: `bulk.${i}`,
            entityType: 'Test',
            summary: `bulk ${i}`,
            actor,
          });
        }
      },
      { timeout: 150_000, maxWait: 20_000 },
    );

    const result = await verifyChain();

    expect(result.valid).toBe(true);
    expect(result.rowsChecked).toBe(200);
    expect(result.firstInvalidSequence).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * Plan 14 acceptance — tampering is detectable, and `firstInvalidSequence`
   * points straight at it.
   *
   * Done by INSERTing a row whose stored hash does not match its own contents.
   * INSERT is the one write the append-only rules allow, so this needs no
   * ALTER TABLE: disabling the rule would take an AccessExclusiveLock that
   * deadlocks against the next test's TRUNCATE, and a failure mid-test would
   * leave the audit table mutable for everything after it.
   *
   * Editing a live row through Neon's SQL editor is the same detection from the
   * other direction, and stays a manual stage demo.
   */
  it('names the first row whose hash does not reproduce', async () => {
    for (let i = 0; i < 5; i++) await write(`chain.${i}`);

    const last = await prisma.activityLog.findFirstOrThrow({
      orderBy: { sequence: 'desc' },
    });

    await prisma.$executeRaw`
      INSERT INTO activity_logs
        (id, "organizationId", "vendorId", "actorId", "actorEmail", "actorRole",
         action, "entityType", "entityId", summary, severity, hash, "previousHash", "createdAt")
      VALUES
        (gen_random_uuid(), NULL, NULL, NULL, 'forged@example.test', NULL,
         'forged.row', 'Test', NULL, 'inserted behind the application', 'INFO',
         'deadbeef', ${last.hash}, now())`;

    const forged = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'forged.row' },
    });

    const result = await verifyChain();

    expect(result.valid).toBe(false);
    expect(result.firstInvalidSequence).toBe(forged.sequence.toString());
  });

  /**
   * Plan 14 acceptance — the application's own connection cannot rewrite
   * history. This is the demo: the rule is enforced by Postgres, not by code
   * anybody could forget to call.
   */
  it('silently affects zero rows when the application tries to UPDATE', async () => {
    const row = await write('immutable');

    const affected = await prisma.$executeRaw`
      UPDATE activity_logs SET summary = 'rewritten' WHERE id = ${row.id}::uuid`;
    expect(affected).toBe(0);

    const unchanged = await prisma.activityLog.findFirstOrThrow({ where: { id: row.id } });
    expect(unchanged.summary).toBe('immutable happened');

    // And DELETE is blocked the same way.
    const deleted = await prisma.$executeRaw`
      DELETE FROM activity_logs WHERE id = ${row.id}::uuid`;
    expect(deleted).toBe(0);
    expect(await prisma.activityLog.count({ where: { id: row.id } })).toBe(1);
  });

  it('is empty-chain safe', async () => {
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.rowsChecked).toBe(0);
  });

  it('writes the audit row inside the caller transaction, so a rollback drops it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await writeAudit(tx, {
          action: 'rolled.back',
          entityType: 'Test',
          summary: 'this must not survive',
          actor,
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await prisma.activityLog.count({ where: { action: 'rolled.back' } })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

describe('activity visibility', () => {
  it('keeps one organization out of another organization rows', async () => {
    const orgA = await makeOrganization('Org A Ltd');
    const orgB = await makeOrganization('Org B Ltd');
    const adminA = await makeUser('ORG_ADMIN', { organizationId: orgA.id });

    await write('a.thing', { organizationId: orgA.id });
    await write('b.thing', { organizationId: orgB.id });

    const { listActivity } = await import('../src/modules/activity/activity.service.js');
    const { rows } = await listActivity(
      {
        userId: adminA.user.id,
        email: adminA.user.email,
        role: 'ORG_ADMIN',
        organizationId: orgA.id,
        vendorId: null,
        isPlatformAdmin: false,
      },
      { page: 1, limit: 50 },
    );

    const actions = rows.map((row) => row.action);
    expect(actions).toContain('a.thing');
    expect(actions).not.toContain('b.thing');
  });

  /** SECURITY rows name people; they are platform-admin only. */
  it('hides SECURITY rows from an organization admin', async () => {
    const org = await makeOrganization('Security Visibility Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    await write('auth.login_failed', { organizationId: org.id, severity: 'SECURITY' });
    await write('tender.published', { organizationId: org.id, severity: 'NOTABLE' });

    const { listActivity } = await import('../src/modules/activity/activity.service.js');
    const { rows } = await listActivity(
      {
        userId: admin.user.id,
        email: admin.user.email,
        role: 'ORG_ADMIN',
        organizationId: org.id,
        vendorId: null,
        isPlatformAdmin: false,
      },
      { page: 1, limit: 50 },
    );

    const actions = rows.map((row) => row.action);
    expect(actions).toContain('tender.published');
    expect(actions).not.toContain('auth.login_failed');
  });

  it('shows a platform admin everything, including SECURITY', async () => {
    const org = await makeOrganization('Platform Visibility Ltd');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await write('auth.login_failed', { organizationId: org.id, severity: 'SECURITY' });

    const { listActivity } = await import('../src/modules/activity/activity.service.js');
    const { rows } = await listActivity(
      {
        userId: platformAdmin.user.id,
        email: platformAdmin.user.email,
        role: 'PLATFORM_ADMIN',
        organizationId: null,
        vendorId: null,
        isPlatformAdmin: true,
      },
      { page: 1, limit: 50 },
    );

    expect(rows.map((row) => row.action)).toContain('auth.login_failed');
  });
});

describe('verifyAuditChain', () => {
  it('can be limited to a prefix of the chain', async () => {
    for (let i = 0; i < 5; i++) await write(`limited.${i}`);

    const result = await verifyAuditChain(prisma, 3);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
  });
});
