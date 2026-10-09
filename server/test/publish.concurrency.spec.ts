import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fiscalYear } from '@tb/shared';
import { app } from '../src/app.js';
import { bidFixture, tenderPayload, type BidFixture } from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Parallel publishing (plan 18 §4, concurrency test 1 of 3).
 *
 * The other two concurrency suites cover receipts and payments. This one covers
 * document numbering, and it runs **over real HTTP with `Promise.allSettled`**
 * rather than by calling `nextNumber` directly: `numbering.spec.ts` already
 * proves the counter is atomic in isolation, so the only thing left to prove is
 * that the publish transaction holds that guarantee end to end — the reservation
 * and the status change committing together, twenty times at once.
 *
 * Gapless matters as much as unique. A sequence that skips 7 because one
 * transaction rolled back is a number an auditor will ask about.
 */

const PARALLEL = 20;

const seqOf = (reference: string): number => Number(reference.split('/').pop());

/**
 * A draft per iteration, each with the same three invited vendors.
 *
 * Built in parallel: this is setup, not the thing under test, and 40 sequential
 * round trips to Neon is most of the runtime.
 */
async function seedDrafts(fixture: BidFixture, count: number): Promise<string[]> {
  const vendorIds = fixture.vendors.map((v) => v.vendor.id);

  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const draft = await request(app)
        .post('/api/v1/tenders')
        .set(...fixture.officer.authHeader)
        .send(tenderPayload({ title: `Parallel publish batch item ${i + 1}` }));
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);

      await request(app)
        .post(`/api/v1/tenders/${draft.body.data.id}/invitations`)
        .set(...fixture.officer.authHeader)
        .send({ vendorIds })
        .expect(201);

      return draft.body.data.id as string;
    }),
  );
}

describe('parallel publishing', () => {
  beforeEach(truncateAll);
  afterAll(disconnect);

  it(`${PARALLEL} parallel publishes produce ${PARALLEL} unique gapless numbers`, async () => {
    const fixture = await bidFixture();
    const ids = await seedDrafts(fixture, PARALLEL);

    const results = await Promise.allSettled(
      ids.map((id) =>
        request(app)
          .post(`/api/v1/tenders/${id}/publish`)
          .set(...fixture.officer.authHeader),
      ),
    );

    const failures = results
      .map((r) =>
        r.status === 'fulfilled'
          ? r.value.status === 200
            ? null
            : `${r.value.status} ${JSON.stringify(r.value.body?.error ?? r.value.body)}`
          : `rejected ${String(r.reason)}`,
      )
      .filter(Boolean);

    expect(failures, failures.join(' | ')).toHaveLength(0);

    const published = await request(app)
      .get('/api/v1/tenders?limit=100&status=PUBLISHED')
      .set(...fixture.officer.authHeader)
      .expect(200);

    const numbers: string[] = published.body.data.map(
      (t: { referenceNumber: string }) => t.referenceNumber,
    );

    expect(numbers).toHaveLength(PARALLEL);
    expect(new Set(numbers).size).toBe(PARALLEL);

    // 1..20 with nothing skipped and nothing repeated.
    expect(numbers.map(seqOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: PARALLEL }, (_, i) => i + 1),
    );

    // Every number carries this organization's prefix and the current fiscal year.
    const year = fiscalYear();
    for (const reference of numbers) {
      expect(reference).toMatch(new RegExp(`^TND/${year}/\\d{6}$`));
    }
    // 20 publishes plus their setup, each several round trips to Neon, do not fit
    // the 30s default — and a test that aborts mid-transaction leaves locks that
    // deadlock the next file's TRUNCATE.
  }, 90_000);

  it('burns no number when a parallel publish is rejected', async () => {
    const fixture = await bidFixture();
    const [first, second] = await seedDrafts(fixture, 2);

    // The same draft twice, in parallel: one publishes, the other finds it is no
    // longer a DRAFT. The loser must not consume a reference number.
    const results = await Promise.allSettled([
      request(app)
        .post(`/api/v1/tenders/${first}/publish`)
        .set(...fixture.officer.authHeader),
      request(app)
        .post(`/api/v1/tenders/${first}/publish`)
        .set(...fixture.officer.authHeader),
    ]);

    const codes = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
    expect(codes.filter((s) => s === 200)).toHaveLength(1);

    const next = await request(app)
      .post(`/api/v1/tenders/${second}/publish`)
      .set(...fixture.officer.authHeader)
      .expect(200);

    expect(seqOf(next.body.data.referenceNumber)).toBe(2);
  });
});
