import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { acceptLine, acceptedOrder, expectQuantities, receive } from './helpers/fulfilment.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * The concurrency proof for goods receipt (plan 11 §4).
 *
 * Two officers receipting the same delivery at the same moment is not a
 * hypothetical — it is a storeroom with two terminals. Without the `FOR UPDATE`
 * lock on the order lines, both transactions read `receivedQuantity = 0`, both
 * pass the cumulative check, and the line ends up with 16 received against 12
 * ordered. Quantity would have been created out of nothing, and plan 12 would
 * happily invoice it.
 *
 * Kept in its own file because these tests are slow and deliberately racy.
 */
vi.setConfig({ testTimeout: 180_000 });

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

describe('parallel goods receipt', () => {
  /** Plan 11 §9 — two 8s against a 12-unit line: one wins, one is refused. */
  it('serialises two receipts on one line and never double-counts', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    const [first, second] = await Promise.all([
      receive(order, [acceptLine(line.id, '8.000')]),
      receive(order, [acceptLine(line.id, '8.000')]),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 422]);

    const loser = first.status === 422 ? first : second;
    expect(loser.body.error.code).toBe('grn.exceeds_ordered');

    // 8, never 16.
    await expectQuantities(line.id, { received: '8.000', accepted: '8.000' });

    const grns = await prisma.grn.count({ where: { purchaseOrderId: order.poId } });
    expect(grns).toBe(1);
  });

  it('lets two receipts through when both fit inside the ordered quantity', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    const [first, second] = await Promise.all([
      receive(order, [acceptLine(line.id, '7.000')]),
      receive(order, [acceptLine(line.id, '5.000')]),
    ]);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    // 7 + 5 = 12 exactly, so both are legitimate and both land.
    await expectQuantities(line.id, { received: '12.000', accepted: '12.000' });
  });

  /**
   * The lock is per line, so receipts touching different lines must not block
   * each other into a failure — only overlapping ones contend.
   */
  it('does not make independent lines contend', async () => {
    const order = await acceptedOrder();

    const [first, second] = await Promise.all([
      receive(order, [acceptLine(order.items[0]!.id, '12.000')]),
      receive(order, [acceptLine(order.items[1]!.id, '24.000')]),
    ]);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    await expectQuantities(order.items[0]!.id, { received: '12.000', accepted: '12.000' });
    await expectQuantities(order.items[1]!.id, { received: '24.000', accepted: '24.000' });

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.poId } });
    expect(po.fulfilmentStatus).toBe('FULFILLED');
  });

  /** Three at once, to show the lock holds beyond a pair. */
  it('admits exactly as many receipts as the line can hold', async () => {
    const order = await acceptedOrder();
    const line = order.items[0]!;

    const results = await Promise.all([
      receive(order, [acceptLine(line.id, '5.000')]),
      receive(order, [acceptLine(line.id, '5.000')]),
      receive(order, [acceptLine(line.id, '5.000')]),
    ]);

    const created = results.filter((res) => res.status === 201);
    const refused = results.filter((res) => res.status === 422);

    // 5 + 5 = 10 fits in 12; the third 5 would make 15.
    expect(created).toHaveLength(2);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body.error.code).toBe('grn.exceeds_ordered');

    await expectQuantities(line.id, { received: '10.000', accepted: '10.000' });
  });
});
