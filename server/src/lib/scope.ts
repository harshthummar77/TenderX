import type { Actor } from '../middleware/authenticate.js';
import { Forbidden, NotFound } from './errors.js';

/**
 * Layer 2 of two (04 §1): may this ACTOR see THIS ROW?
 *
 * **Cross-tenant reads answer 404, never 403.** A 403 confirms the row exists,
 * which is itself a leak: org A learns that tender id X belongs to somebody.
 *
 * The rule, stated once so it is never argued about again: a service function
 * that reads or writes a tenant-owned row uses `findScoped`, or spreads a
 * `scopeTo*()` into its `where`. There is no third option. Scanning a diff for a
 * bare `findUnique({ where: { id } })` on a tenant table takes ten seconds and
 * is the highest-value review habit in this codebase.
 *
 * Rows reached through a parent (QuotationItem, GrnItem, InvoiceItem) are scoped
 * by loading the parent first. Never fetch a child by id alone.
 */

export interface OrgScope {
  organizationId?: string;
}
export interface VendorScope {
  vendorId?: string;
}
export type PartyScope = OrgScope & VendorScope;

/** Rows owned by the actor's organization. Platform admin reads across tenants. */
export function scopeToOrg(actor: Actor): OrgScope {
  if (actor.isPlatformAdmin) return {};
  if (!actor.organizationId) throw Forbidden('Not an organization user');
  return { organizationId: actor.organizationId };
}

/** Rows owned by the actor's vendor company. */
export function scopeToVendor(actor: Actor): VendorScope {
  if (actor.isPlatformAdmin) return {};
  if (!actor.vendorId) throw Forbidden('Not a vendor user');
  return { vendorId: actor.vendorId };
}

/**
 * Buyer-or-seller view of a shared document (PO, invoice, payment): the row
 * carries both ids, and each party sees it through their own.
 */
export function scopeToParty(actor: Actor): PartyScope {
  if (actor.isPlatformAdmin) return {};
  if (actor.organizationId) return { organizationId: actor.organizationId };
  if (actor.vendorId) return { vendorId: actor.vendorId };
  throw Forbidden();
}

interface FindFirstModel<T> {
  findFirst(args: { where: Record<string, unknown> }): Promise<T | null>;
}

/**
 * Fetch-or-404, scoped. Use this instead of findUnique in every service.
 *
 * `extra` narrows further (status filters, parent ids); `scope` picks which of
 * the three helpers applies to this table.
 */
export async function findScoped<T>(
  model: FindFirstModel<T>,
  id: string,
  actor: Actor,
  extra: Record<string, unknown> = {},
  scope: (actor: Actor) => PartyScope = scopeToParty,
): Promise<T> {
  const row = await model.findFirst({ where: { id, ...scope(actor), ...extra } });
  if (!row) throw NotFound();
  return row;
}

/** True when the actor's own party owns the row. For rows already loaded. */
export function ownsRow(
  actor: Actor,
  row: { organizationId?: string | null; vendorId?: string | null },
): boolean {
  if (actor.isPlatformAdmin) return true;
  if (actor.organizationId && row.organizationId === actor.organizationId) return true;
  if (actor.vendorId && row.vendorId === actor.vendorId) return true;
  return false;
}

/** Guard for a row loaded by other means — throws the same 404 as findScoped. */
export function assertOwned(
  actor: Actor,
  row: { organizationId?: string | null; vendorId?: string | null } | null,
): void {
  if (!row || !ownsRow(actor, row)) throw NotFound();
}
