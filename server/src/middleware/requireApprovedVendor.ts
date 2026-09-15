import type { RequestHandler } from 'express';
import { BusinessRule, Forbidden } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  canAcceptOrDeliver,
  canDoNewBusiness,
  canHonourExistingObligations,
} from '../modules/vendor/vendor.stateMachine.js';

/**
 * Vendor-side gates. Which one a route takes is the whole point of 06 §1:
 *
 *   requireApprovedVendor      new business  — quotation submit, invitation response
 *   requireVendorCanFulfil     existing PO   — accept, dispatch a delivery
 *   requireVendorNotRejected   money owed    — submit an invoice, be paid
 *
 * Suspension stops new business; it does not repudiate existing obligations.
 */

interface CachedVendor {
  id: string;
  status: string;
  statusReason: string | null;
}

const VENDOR_TTL_MS = 60_000;
const cache = new Map<string, { vendor: CachedVendor | null; expiresAt: number }>();

export function bustVendorCache(vendorId: string): void {
  cache.delete(vendorId);
}

export function clearVendorCache(): void {
  cache.clear();
}

async function getVendorCached(vendorId: string): Promise<CachedVendor | null> {
  const hit = cache.get(vendorId);
  if (hit && hit.expiresAt > Date.now()) return hit.vendor;

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, status: true, statusReason: true },
  });

  cache.set(vendorId, { vendor, expiresAt: Date.now() + VENDOR_TTL_MS });
  return vendor;
}

const refusal = (status: string, reason: string | null, what: string) =>
  BusinessRule(
    'vendor.not_permitted',
    `${what} is not available while your account is ${status}${reason ? `: ${reason}` : ''}`,
  );

const gate =
  (allowed: (status: never) => boolean, what: string): RequestHandler =>
  async function vendorStatusGuard(req, _res, next) {
    const actor = req.actor;
    if (!actor) throw Forbidden();
    if (actor.isPlatformAdmin) return next();
    if (!actor.vendorId) throw Forbidden('Vendor context required');

    const vendor = await getVendorCached(actor.vendorId);
    if (!vendor) throw Forbidden('Vendor context required');

    if (!allowed(vendor.status as never)) {
      throw refusal(vendor.status, vendor.statusReason, what);
    }
    next();
  };

/** APPROVED only. */
export const requireApprovedVendor = gate(canDoNewBusiness, 'This action');

/** APPROVED or SUSPENDED — honouring a PO that already exists. */
export const requireVendorCanFulfil = gate(canAcceptOrDeliver, 'Order fulfilment');

/** Anything but REJECTED — invoicing and payment for work already done. */
export const requireVendorNotRejected = gate(canHonourExistingObligations, 'Invoicing');
