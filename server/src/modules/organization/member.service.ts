import type { InviteMemberInput, UpdateMemberInput } from '@tb/shared';
import { writeAudit } from '../../lib/audit.js';
import { BusinessRule, Conflict, NotFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { bustActorCache, type Actor } from '../../middleware/authenticate.js';
import { revokeAllForUser, type RefreshContext } from '../auth/token.service.js';
import { createInvitation } from '../invitation/invitation.service.js';

/**
 * Membership rules (05 §3). Nobody is ever deleted — `SUSPENDED` replaces it,
 * so the audit trail keeps pointing at a real row.
 */

const auditActorOf = (actor: Actor, ctx: RefreshContext) => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

export async function listMembers(actor: Actor) {
  if (!actor.organizationId) throw NotFound('Organization');
  return prisma.user.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Rule 3: an email already on this org's roster is a duplicate, not a new invite. */
export async function inviteMember(actor: Actor, input: InviteMemberInput, ctx: RefreshContext) {
  if (!actor.organizationId) throw NotFound('Organization');

  const alreadyAMember = await prisma.user.findFirst({
    where: { email: input.email, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (alreadyAMember) {
    throw Conflict('invitation.duplicate', 'That email is already a member of this organization');
  }

  return createInvitation(actor, { email: input.email, fullName: input.fullName, role: input.role }, ctx);
}

async function loadMember(actor: Actor, userId: string) {
  if (!actor.organizationId) throw NotFound('Organization');

  // Scoped by organization: a member of another org is a 404, not a 403.
  const member = await prisma.user.findFirst({
    where: { id: userId, organizationId: actor.organizationId },
  });
  if (!member) throw NotFound('Member');
  return member;
}

/** Rule 1: the org must always keep at least one ACTIVE ORG_ADMIN. */
async function assertNotLastAdmin(organizationId: string, memberId: string) {
  const otherActiveAdmins = await prisma.user.count({
    where: {
      organizationId,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
      id: { not: memberId },
    },
  });

  if (otherActiveAdmins === 0) {
    throw BusinessRule(
      'organization.last_admin',
      'An organization must always have at least one active administrator',
    );
  }
}

/**
 * Role and status changes.
 *
 * Rule 2: you cannot change your own role or suspend yourself — that is the
 * cheapest privilege-escalation route in any admin panel.
 *
 * Rule 5: a demotion takes effect on the member's **next request**, not in up to
 * 60 seconds. The actor cache is busted and their refresh tokens revoked, so the
 * old role cannot outlive the decision.
 */
export async function updateMember(
  actor: Actor,
  userId: string,
  input: UpdateMemberInput,
  ctx: RefreshContext,
) {
  const member = await loadMember(actor, userId);

  if (member.id === actor.userId) {
    throw BusinessRule(
      'organization.self_modification',
      'You cannot change your own role or status',
    );
  }

  const losesAdmin =
    member.role === 'ORG_ADMIN' &&
    member.status === 'ACTIVE' &&
    ((input.role && input.role !== 'ORG_ADMIN') || input.status === 'SUSPENDED');

  if (losesAdmin) await assertNotLastAdmin(member.organizationId!, member.id);

  const demoted = Boolean(input.role && input.role !== member.role);
  const suspended = input.status === 'SUSPENDED' && member.status !== 'SUSPENDED';

  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: member.id },
      data: {
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    });

    // Old permissions must not outlive the decision.
    if (demoted || suspended) await revokeAllForUser(tx, member.id);

    await writeAudit(tx, {
      action: suspended ? 'organization.member_suspended' : 'organization.member_updated',
      entityType: 'User',
      entityId: member.id,
      summary: `${actor.email} updated ${member.email}${input.role ? ` to ${input.role}` : ''}${
        input.status ? ` (${input.status})` : ''
      }`,
      severity: demoted || suspended ? 'SECURITY' : 'NOTABLE',
      organizationId: member.organizationId,
      actor: auditActorOf(actor, ctx),
      before: { role: member.role, status: member.status },
      after: { role: updated.role, status: updated.status },
    });

    return updated;
  });

  bustActorCache(member.id);
  return updated;
}

/** Removal is suspension. Nothing is hard-deleted (02 §1). */
export async function suspendMember(actor: Actor, userId: string, ctx: RefreshContext) {
  return updateMember(actor, userId, { status: 'SUSPENDED' }, ctx);
}
