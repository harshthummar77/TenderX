import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { bidFixture, placeBid, publishTender } from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * The test-only control surface (plan 18 §5), and the deadline rule it exists
 * to exercise: a published tender closes once its window has passed, without
 * anybody sleeping on a timer.
 */
describe('test-only clock and jobs', () => {
  beforeEach(truncateAll);
  afterAll(disconnect);

  it('advances past the deadline and the sweep closes the tender', async () => {
    const fixture = await bidFixture();
    const tender = await publishTender(fixture);
    await placeBid(fixture, tender.id, 0, { prices: ['58500.00', '8200.00'] });

    // The fixture's deadline is hours ahead; pull it into the past.
    const shifted = await request(app)
      .post('/api/v1/_test/advance-time')
      .send({ hours: 72, tenderId: tender.id })
      .expect(200);
    expect(shifted.body.data.shifted).toBe(1);

    const swept = await request(app).post('/api/v1/_test/run-job/deadline-sweep').expect(200);
    expect(swept.body.data.job).toBe('deadline-sweep');

    const closed = await prisma.tender.findUniqueOrThrow({ where: { id: tender.id } });
    expect(closed.status).toBe('BIDDING_CLOSED');
  });

  it('abandons never-submitted drafts when the window closes', async () => {
    const fixture = await bidFixture();
    const tender = await publishTender(fixture);

    // Vendor 1 opens a draft and never submits it.
    await request(app)
      .post(`/api/v1/vendor/tenders/${tender.id}/quotation`)
      .set(...fixture.vendors[1]!.contact.authHeader)
      .expect(201);

    await request(app)
      .post('/api/v1/_test/advance-time')
      .send({ hours: 72, tenderId: tender.id })
      .expect(200);
    await request(app).post('/api/v1/_test/run-job/deadline-sweep').expect(200);

    const quotations = await prisma.quotation.findMany({ where: { tenderId: tender.id } });
    expect(quotations).toHaveLength(1);
    expect(quotations[0]!.status).toBe('WITHDRAWN');
  });

  it('rejects an unknown job name', async () => {
    await request(app).post('/api/v1/_test/run-job/not-a-job').expect(404);
  });

  it('refuses a non-positive time shift', async () => {
    await request(app).post('/api/v1/_test/advance-time').send({ hours: 0 }).expect(404);
  });
});
