import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { buildScorecard } from '../modules/vendor/scorecard.service.js';

/**
 * The feedback loop (plan 15 §4).
 *
 * Recomputes `Vendor.rating`, `Vendor.totalOrders` and
 * `Vendor.onTimeDeliveryRate` from the scorecard, and writes them back onto the
 * vendor row. Those cached columns are read by:
 *
 * - plan 07's suggested-vendors ranking, and
 * - plan 09's `vendorRating` evaluation criterion.
 *
 * **So a vendor who delivers late scores lower on their next bid, automatically.**
 * That is the point worth stating out loud: performance data feeds back into
 * future evaluations rather than sitting in a report nobody reads. It is one job
 * and two reads, and it is what makes the system feel alive.
 *
 * The columns are a cache, never the source of truth — `buildScorecard` computes
 * from the underlying rows on every read, so a stale cache degrades ranking
 * quality and never corrupts a decision.
 */

/** Once a day is enough: ratings move on the timescale of deliveries, not minutes. */
const ONE_DAY_MS = 86_400_000;

let lastRunAt = 0;

export interface RefreshResult {
  vendors: number;
  updated: number;
  skipped: boolean;
}

/**
 * Refresh every vendor that has any history.
 *
 * A vendor with nothing to score keeps `rating: null` rather than being written
 * to zero. Plan 09 reads null as a neutral 50 — scoring an unproven supplier
 * zero would permanently lock out everyone who has not worked with you yet.
 */
export async function refreshVendorStats(): Promise<RefreshResult> {
  const vendors = await prisma.vendor.findMany({
    where: { status: { in: ['APPROVED', 'SUSPENDED'] } },
    select: { id: true },
  });

  let updated = 0;

  for (const vendor of vendors) {
    try {
      const card = await buildScorecard(vendor.id);

      await prisma.vendor.update({
        where: { id: vendor.id },
        data: {
          rating: card.rating === null ? null : card.rating.toFixed(2),
          totalOrders: card.orders.total,
          onTimeDeliveryRate:
            card.delivery.onTimeRate === null ? null : card.delivery.onTimeRate.toFixed(2),
        },
      });
      updated += 1;
    } catch (err) {
      // One unscoreable vendor must not stop the sweep for everybody else.
      logger.error({ err, vendorId: vendor.id }, 'Failed to refresh vendor stats');
    }
  }

  if (updated > 0) logger.info({ vendors: vendors.length, updated }, 'Vendor stats refreshed');
  return { vendors: vendors.length, updated, skipped: false };
}

/**
 * The guarded tick.
 *
 * Runs on the existing 15-minute cron but does real work at most once a day: a
 * job that recomputed every scorecard every quarter-hour would keep the Neon
 * compute awake permanently for data that changes daily (00 §7B).
 */
export async function runVendorStatsSweep(force = false): Promise<RefreshResult> {
  if (!force && Date.now() - lastRunAt < ONE_DAY_MS) {
    return { vendors: 0, updated: 0, skipped: true };
  }

  lastRunAt = Date.now();

  try {
    return await refreshVendorStats();
  } catch (err) {
    logger.error({ err }, 'Vendor stats sweep failed');
    return { vendors: 0, updated: 0, skipped: false };
  }
}

/** Reset the once-a-day guard. Tests use it; nothing else should. */
export function resetVendorStatsGuard(): void {
  lastRunAt = 0;
}
