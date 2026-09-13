import type { AcceptInvitationInput, CreateInvitationInput, InvitationPreviewDto, Role } from '@tb/shared';
import { env } from '../../config/env.js';
import { writeAudit } from '../../lib/audit.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, Conflict, Forbidden, NotFound } from '../../lib/errors.js';
import { sendMail } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import type { Actor } from '../../middleware/authenticate.js';
import { hashPassword } from '../auth/auth.service.js';
import { issueRefresh, type RefreshContext } from '../auth/token.service.js';
import { buildSession } from '../auth/auth.service.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Who may hand out which role (03 §6). An inviter can never grant access to a
 * party they do not belong to, and never a role above their own.
 */
const GRANTABLE: Record<Role, Role[]> = {
  PLATFORM_ADMIN: ['PLATFORM_ADMIN'],
  ORG_ADMIN: ['ORG_ADMIN', 'ORG_OFFICER'],
  ORG_OFFICER: [],
  VENDOR: ['VENDOR'],
};

function assertMayInvite(actor: Actor, role: Role) {
  if (!GRANTABLE[actor.role].includes(role)) {
    throw Forbidden(`A ${actor.role} cannot invite a ${role}`);
  }
}

/**
 * Create an invitation. The raw token exists only in the email link; the row
 * stores its SHA-256. A second pending invitation for the same email and party
 * revokes the first rather than leaving duplicate rows.
 */
export async function createInvitation(
  actor: Actor,
  input: CreateInvitationInput,
  ctx: RefreshContext,
) {
  assertMayInvite(actor, input.role);

  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existingUser) {
    throw Conflict('invitation.user_exists', 'That email already has an account — ask them to sign in');
  }

  const token = randomToken(32);
  const organizationId = actor.role === 'VENDOR' ? null : actor.organizationId;
  const vendorId = actor.role === 'VENDOR' ? actor.vendorId : null;

  const invitation = await prisma.$transaction(async (tx) => {
    // One live invitation per email per party.
    await tx.invitation.updateMany({
      where: { email: input.email, organizationId, vendorId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const invitation = await tx.invitation.create({
      data: {
        email: input.email,
        fullName: input.fullName ?? null,
        role: input.role,
        organizationId,
        vendorId,
        tokenHash: sha256(token),
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });

    await writeAudit(tx, {
      action: 'user.invited',
      entityType: 'Invitation',
      entityId: invitation.id,
      summary: `${actor.email} invited ${input.email} as ${input.role}`,
      severity: 'NOTABLE',
      organizationId,
      vendorId,
      actor: {
        userId: actor.userId,
        email: actor.email,
        role: actor.role,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
      after: { email: input.email, role: input.role },
    });

    return invitation;
  });

  sendMail({
    to: input.email,
    subject: 'You have been invited to TenderBridge',
    text: `Accept your invitation: ${env.APP_URL}/accept-invite/${token}\nThis link expires in 7 days.`,
  });

  return invitation;
}

/**
 * Loads a live invitation by raw token, or throws the right error for its state.
 * `Invitation` carries only the party ids — plan 02 gave it no relations — so
 * the party name is looked up separately when it is actually needed.
 */
async function loadLive(token: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
  });

  if (!invitation) throw NotFound('Invitation');
  if (invitation.acceptedAt) {
    throw Conflict('invitation.already_accepted', 'This invitation has already been used');
  }
  if (invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, 'invitation.expired', 'This invitation has expired');
  }
  return invitation;
}

async function partyName(
  organizationId: string | null,
  vendorId: string | null,
): Promise<string | null> {
  if (organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    return org?.name ?? null;
  }
  if (vendorId) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { companyName: true },
    });
    return vendor?.companyName ?? null;
  }
  return null;
}

/** Public preview so the accept screen can say "Join Meridian as a Procurement Officer". */
export async function previewInvitation(token: string): Promise<InvitationPreviewDto> {
  const invitation = await loadLive(token);
  return {
    email: invitation.email,
    role: invitation.role,
    partyName: await partyName(invitation.organizationId, invitation.vendorId),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

/**
 * Accept: create the ACTIVE user, close the invitation, sign them in.
 * An email that gained an account since the invitation was sent is a 409 — we
 * never silently attach an existing user to a new party.
 */
export async function acceptInvitation(
  token: string,
  input: AcceptInvitationInput,
  ctx: RefreshContext,
) {
  const invitation = await loadLive(token);

  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });
  if (existingUser) {
    throw Conflict('invitation.user_exists', 'That email already has an account — sign in instead');
  }

  const passwordHash = await hashPassword(input.password);

  const { user, refreshToken } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: invitation.email,
        passwordHash,
        fullName: input.fullName,
        phone: input.phone ?? null,
        role: invitation.role,
        status: 'ACTIVE',
        organizationId: invitation.organizationId,
        vendorId: invitation.vendorId,
        lastLoginAt: new Date(),
      },
      include: { organization: true, vendor: true },
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    await writeAudit(tx, {
      action: 'user.invitation_accepted',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email} accepted an invitation as ${user.role}`,
      severity: 'NOTABLE',
      organizationId: invitation.organizationId,
      vendorId: invitation.vendorId,
      actor: {
        userId: user.id,
        email: user.email,
        role: user.role,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
      after: { role: user.role },
    });

    const refreshToken = await issueRefresh(tx, user.id, ctx);
    return { user, refreshToken };
  });

  return buildSession(user, refreshToken);
}

export async function revokeInvitation(actor: Actor, id: string, ctx: RefreshContext) {
  const invitation = await prisma.invitation.findUnique({ where: { id } });
  if (!invitation) throw NotFound('Invitation');

  const sameParty =
    actor.isPlatformAdmin ||
    (invitation.organizationId && invitation.organizationId === actor.organizationId) ||
    (invitation.vendorId && invitation.vendorId === actor.vendorId);
  if (!sameParty) throw NotFound('Invitation');

  if (invitation.acceptedAt) {
    throw Conflict('invitation.already_accepted', 'This invitation has already been used');
  }

  await prisma.$transaction(async (tx) => {
    await tx.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(tx, {
      action: 'user.invitation_revoked',
      entityType: 'Invitation',
      entityId: id,
      summary: `${actor.email} revoked the invitation for ${invitation.email}`,
      severity: 'NOTABLE',
      organizationId: invitation.organizationId,
      vendorId: invitation.vendorId,
      actor: {
        userId: actor.userId,
        email: actor.email,
        role: actor.role,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
  });
}

/** Pending invitations for the caller's own party. */
export async function listInvitations(actor: Actor) {
  return prisma.invitation.findMany({
    where: {
      acceptedAt: null,
      revokedAt: null,
      ...(actor.role === 'VENDOR'
        ? { vendorId: actor.vendorId }
        : actor.isPlatformAdmin
          ? {}
          : { organizationId: actor.organizationId }),
    },
    select: { id: true, email: true, fullName: true, role: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}
