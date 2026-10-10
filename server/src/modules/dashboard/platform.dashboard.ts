import type { ActionTile, PlatformDashboard } from '@tb/shared';
import { prisma } from '../../lib/prisma.js';
import { MAX_EMAIL_ATTEMPTS } from '../notification/notification.service.js';
import { platformStats } from '../platform/platform.service.js';
import { systemHealth } from '../platform/system.controller.js';

/**
 * The platform dashboard (plan 15 §2).
 *
 * The `/platform/stats` payload from plan 05 §6, plus the system health a
 * platform operator actually needs: mail that never went out, a failing chain,
 * and how long the database is taking to answer.
 *
 * **A platform admin is read-only across tenants** (04 §7), so the tiles here
 * point at the two things they may genuinely act on — approving organizations
 * and vendors — and nothing else.
 */

export async function buildPlatformDashboard(): Promise<PlatformDashboard> {
  // One probe, shared with GET /platform/system (19 §6), so the screen and the
  // monitor can never report different numbers.
  const [stats, orgsPending, vendorsPending, health] = await Promise.all([
    platformStats(),
    prisma.organization.count({ where: { status: 'PENDING_APPROVAL' } }),
    prisma.vendor.count({ where: { status: 'PENDING_APPROVAL' } }),
    systemHealth(),
  ]);

  const { failedEmails24h } = health;

  const tiles: ActionTile[] = [];

  if (orgsPending > 0) {
    tiles.push({
      key: 'orgs_pending',
      label: 'Organizations awaiting approval',
      count: orgsPending,
      link: '/platform/organizations?status=PENDING_APPROVAL',
      severity: 'high',
    });
  }

  if (vendorsPending > 0) {
    tiles.push({
      key: 'vendors_pending',
      label: 'Vendors awaiting approval',
      count: vendorsPending,
      link: '/vendors?status=PENDING_APPROVAL',
    });
  }

  // A broken chain is the one thing on this page that should stop the day.
  if (!health.auditChainValid) {
    tiles.push({
      key: 'audit_chain_broken',
      label: 'Audit chain verification failed',
      count: 1,
      link: '/platform/activity/verify',
      severity: 'high',
    });
  }

  if (failedEmails24h > 0) {
    tiles.push({
      key: 'failed_emails',
      label: `Emails failing (retried up to ${MAX_EMAIL_ATTEMPTS} times)`,
      count: failedEmails24h,
      link: '/platform/activity?action=notification',
    });
  }

  return {
    role: 'PLATFORM_ADMIN',
    actionRequired: tiles,
    stats,
    health,
  };
}
