import type { Organization, Prisma } from '@prisma/client';
import {
  orgSettingsSchema,
  type OrgSettings,
  type UpdateOrgInput,
  type UpdateSettingsInput,
} from '@tb/shared';
import { writeAudit } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import { bustOrgCache } from '../../middleware/requireActiveOrg.js';

/**
 * Settings are parsed on every read, so services downstream always receive
 * typed values with defaults filled in — never a raw JSON blob (plan 02 §9).
 */
export function getSettings(org: Organization): OrgSettings {
  return orgSettingsSchema.parse(org.settings ?? {});
}

const auditActorOf = (actor: Actor) => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
});

/**
 * The organization row is the tenant boundary, so it is scoped by its own `id`
 * rather than by a `organizationId` column — `scopeToOrg` is for rows *owned by*
 * an organization, and spreading it here would filter on a column this table
 * does not have.
 *
 * `/organizations/me` is deliberately self-only: a platform admin reads other
 * tenants through `/platform/organizations/:id`, never through this route.
 */
export async function loadOwnOrg(actor: Actor): Promise<Organization> {
  if (!actor.organizationId) throw NotFound('Organization');

  const org = await prisma.organization.findUnique({ where: { id: actor.organizationId } });
  if (!org) throw NotFound('Organization');
  return org;
}

export const hasGstCertificate = async (organizationId: string): Promise<boolean> =>
  (await prisma.document.count({
    where: { organizationId, type: 'ORG_GST_CERTIFICATE' },
  })) > 0;

/** `stateCode` is frozen once a purchase order exists (rule 6). */
export const hasIssuedPurchaseOrder = async (organizationId: string): Promise<boolean> =>
  (await prisma.purchaseOrder.count({ where: { organizationId } })) > 0;

export async function getOwnOrg(actor: Actor) {
  const org = await loadOwnOrg(actor);
  return {
    org,
    hasGstCertificate: await hasGstCertificate(org.id),
    stateCodeEditable: !(await hasIssuedPurchaseOrder(org.id)),
  };
}

/**
 * Profile update.
 *
 * Rule 6: `stateCode` determines the tax regime — intra-state vs inter-state —
 * on every document the org has already issued. Once a purchase order exists it
 * cannot change, or historical GST splits stop matching the parties on them.
 */
export async function updateOwnOrg(actor: Actor, input: UpdateOrgInput) {
  const org = await loadOwnOrg(actor);

  if (input.stateCode && input.stateCode !== org.stateCode) {
    if (await hasIssuedPurchaseOrder(org.id)) {
      throw BusinessRule(
        'organization.state_locked',
        'State code cannot change once purchase orders have been issued — it fixes the tax regime on every existing document',
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.organization.update({
      where: { id: org.id },
      data: input as Prisma.OrganizationUpdateInput,
    });

    await writeAudit(tx, {
      action: 'organization.updated',
      entityType: 'Organization',
      entityId: org.id,
      summary: `${actor.email} updated the organization profile`,
      organizationId: org.id,
      actor: auditActorOf(actor),
      before: Object.fromEntries(
        Object.keys(input).map((key) => [key, (org as Record<string, unknown>)[key] ?? null]),
      ) as Prisma.InputJsonValue,
      after: input as Prisma.InputJsonValue,
    });

    return updated;
  });

  bustOrgCache(org.id);
  return {
    org: updated,
    hasGstCertificate: await hasGstCertificate(org.id),
    stateCodeEditable: !(await hasIssuedPurchaseOrder(org.id)),
  };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export async function getOwnSettings(actor: Actor): Promise<OrgSettings> {
  return getSettings(await loadOwnOrg(actor));
}

/**
 * PATCH is a deep merge, not a replace, so the UI can send a single field.
 *
 * Every change writes a NOTABLE audit row with before and after. "Could someone
 * loosen the three-way match tolerance to push an invoice through?" — yes, and
 * it is on the audit trail with their name on it.
 */
export async function updateOwnSettings(actor: Actor, input: UpdateSettingsInput) {
  const org = await loadOwnOrg(actor);
  const before = getSettings(org);

  const merged = orgSettingsSchema.parse({
    ...before,
    ...input,
    numberPrefixes: { ...before.numberPrefixes, ...(input.numberPrefixes ?? {}) },
  });

  const changed = Object.keys(input).filter(
    (key) =>
      JSON.stringify((merged as Record<string, unknown>)[key]) !==
      JSON.stringify((before as Record<string, unknown>)[key]),
  );

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: org.id },
      data: { settings: merged as unknown as Prisma.InputJsonValue },
    });

    await writeAudit(tx, {
      action: 'organization.settings_updated',
      entityType: 'Organization',
      entityId: org.id,
      summary: changed.length
        ? `${actor.email} changed settings: ${changed.join(', ')}`
        : `${actor.email} saved settings with no effective change`,
      severity: 'NOTABLE',
      organizationId: org.id,
      actor: auditActorOf(actor),
      before: before as unknown as Prisma.InputJsonValue,
      after: merged as unknown as Prisma.InputJsonValue,
    });
  });

  bustOrgCache(org.id);
  return merged;
}
