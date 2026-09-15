import type { RequestHandler } from 'express';
import { BusinessRule, Forbidden } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

/**
 * The organization lifecycle gate.
 *
 *   PENDING_APPROVAL -> can log in, edit profile, upload KYC. No business actions.
 *   ACTIVE           -> everything.
 *   SUSPENDED        -> read-only view of existing data.
 *
 * Mount it on every business route from plan 07 onward. Do **not** mount it on
 * profile, documents or /me: an org must be able to complete its KYC while
 * pending, or approval can never happen.
 *
 * Named `activeOrgGuard` so the route-coverage test can see it in the stack.
 */

interface CachedOrg {
  id: string;
  status: string;
}

/** Same 60-second window as the actor cache, for the same Neon reason (00 §7B). */
const ORG_TTL_MS = 60_000;
const cache = new Map<string, { org: CachedOrg | null; expiresAt: number }>();

export function bustOrgCache(organizationId: string): void {
  cache.delete(organizationId);
}

export function clearOrgCache(): void {
  cache.clear();
}

async function getOrgCached(organizationId: string): Promise<CachedOrg | null> {
  const hit = cache.get(organizationId);
  if (hit && hit.expiresAt > Date.now()) return hit.org;

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, status: true },
  });

  cache.set(organizationId, { org, expiresAt: Date.now() + ORG_TTL_MS });
  return org;
}

export const requireActiveOrg: RequestHandler = async function activeOrgGuard(req, _res, next) {
  const actor = req.actor;
  if (!actor) throw Forbidden();
  if (actor.isPlatformAdmin) return next();
  if (!actor.organizationId) throw Forbidden('Organization context required');

  const org = await getOrgCached(actor.organizationId);
  if (!org) throw Forbidden('Organization context required');

  if (org.status !== 'ACTIVE') {
    throw BusinessRule(
      'organization.not_active',
      org.status === 'PENDING_APPROVAL'
        ? 'Your organization is awaiting platform approval'
        : 'Your organization is suspended',
    );
  }

  next();
};
