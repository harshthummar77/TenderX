import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fiscalYear } from '@tb/shared';
import { nextNumber } from '../src/lib/numbering.js';
import { prisma } from '../src/lib/prisma.js';
import { makeOrganization } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Gapless numbering (07 §2). The concurrency case is the one that matters:
 * `count() + 1` passes every sequential test and fails the moment two officers
 * click Publish at the same instant.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe('fiscalYear', () => {
  it('runs April to March', () => {
    expect(fiscalYear(new Date('2025-04-01T00:00:00+05:30'))).toBe('2025-26');
    expect(fiscalYear(new Date('2025-12-31T12:00:00+05:30'))).toBe('2025-26');
    expect(fiscalYear(new Date('2026-03-31T23:59:59+05:30'))).toBe('2025-26');
    expect(fiscalYear(new Date('2026-04-01T00:00:00+05:30'))).toBe('2026-27');
  });

  it('turns over at midnight IST, not midnight UTC', () => {
    // 31 March 19:00 UTC is already 1 April 00:30 in India.
    expect(fiscalYear(new Date('2026-03-31T19:00:00Z'))).toBe('2026-27');
    expect(fiscalYear(new Date('2026-03-31T18:00:00Z'))).toBe('2025-26');
  });

  it('pads the second year to two digits', () => {
    expect(fiscalYear(new Date('2009-05-01T00:00:00+05:30'))).toBe('2009-10');
    expect(fiscalYear(new Date('2099-05-01T00:00:00+05:30'))).toBe('2099-00');
  });
});

describe('nextNumber', () => {
  it('self-seeds at 1 and then counts up', async () => {
    const org = await makeOrganization('Numbering Ltd');
    const fy = fiscalYear();

    const first = await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'));
    const second = await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'));
    const third = await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'));

    expect(first).toBe(`TND/${fy}/000001`);
    expect(second).toBe(`TND/${fy}/000002`);
    expect(third).toBe(`TND/${fy}/000003`);

    const row = await prisma.numberSequence.findFirstOrThrow({
      where: { organizationId: org.id, docType: 'TENDER' },
    });
    expect(row.nextValue).toBe(4);
  });

  it('keeps a separate run per organization', async () => {
    const a = await makeOrganization('Org A Numbering');
    const b = await makeOrganization('Org B Numbering');
    const fy = fiscalYear();

    await prisma.$transaction((tx) => nextNumber(tx, a.id, 'TENDER'));
    await prisma.$transaction((tx) => nextNumber(tx, a.id, 'TENDER'));
    const bFirst = await prisma.$transaction((tx) => nextNumber(tx, b.id, 'TENDER'));

    // An organization created later starts again at 000001.
    expect(bFirst).toBe(`TND/${fy}/000001`);
  });

  it('keeps a separate run per document type', async () => {
    const org = await makeOrganization('Multi Doc Ltd');
    const fy = fiscalYear();

    await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'));
    const po = await prisma.$transaction((tx) => nextNumber(tx, org.id, 'PURCHASE_ORDER'));
    const invoice = await prisma.$transaction((tx) => nextNumber(tx, org.id, 'INVOICE'));

    expect(po).toBe(`PO/${fy}/000001`);
    expect(invoice).toBe(`INV/${fy}/000001`);
  });

  it('keeps a separate run per fiscal year', async () => {
    const org = await makeOrganization('Fiscal Ltd');

    const lastYear = await prisma.$transaction((tx) =>
      nextNumber(tx, org.id, 'TENDER', { at: new Date('2024-06-01T00:00:00+05:30') }),
    );
    const thisYear = await prisma.$transaction((tx) =>
      nextNumber(tx, org.id, 'TENDER', { at: new Date('2025-06-01T00:00:00+05:30') }),
    );

    expect(lastYear).toBe('TND/2024-25/000001');
    expect(thisYear).toBe('TND/2025-26/000001');
  });

  it('honours the prefix the organization configured', async () => {
    const org = await makeOrganization('Prefixed Ltd');
    const number = await prisma.$transaction((tx) =>
      nextNumber(tx, org.id, 'TENDER', { prefix: 'RFQ' }),
    );
    expect(number.startsWith('RFQ/')).toBe(true);
  });

  it('uses the seeded row rather than re-seeding it', async () => {
    const org = await makeOrganization('Seeded Ltd');
    const fy = fiscalYear();

    // Plan 05 seeds these at approval so the first tender never hits a cold path.
    await prisma.numberSequence.create({
      data: { organizationId: org.id, docType: 'TENDER', fiscalYear: fy, prefix: 'TND' },
    });

    expect(await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'))).toBe(
      `TND/${fy}/000001`,
    );
  });

  /**
   * The reason the implementation is a single `INSERT … ON CONFLICT DO UPDATE
   * … RETURNING` rather than a read-then-write.
   */
  it('gives 20 concurrent callers 20 distinct, gapless numbers', async () => {
    const org = await makeOrganization('Concurrent Ltd');
    const fy = fiscalYear();

    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'))),
    );

    expect(new Set(numbers).size).toBe(20);

    const values = numbers.map((n) => Number(n.split('/')[2])).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 20 }, (_v, i) => i + 1));
    expect(numbers.every((n) => n.startsWith(`TND/${fy}/`))).toBe(true);
  });

  it('burns no number when the caller rolls back', async () => {
    const org = await makeOrganization('Rollback Ltd');
    const fy = fiscalYear();

    await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'));

    await expect(
      prisma.$transaction(async (tx) => {
        await nextNumber(tx, org.id, 'TENDER');
        throw new Error('caller failed after reserving');
      }),
    ).rejects.toThrow('caller failed after reserving');

    // The rolled-back reservation is released, so the sequence stays gapless.
    expect(await prisma.$transaction((tx) => nextNumber(tx, org.id, 'TENDER'))).toBe(
      `TND/${fy}/000002`,
    );
  });
});
