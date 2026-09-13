import bcrypt from 'bcryptjs';
import type { Prisma, User } from '@prisma/client';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterOrganizationInput,
  RegisterVendorInput,
  ResetPasswordInput,
} from '@tb/shared';
import { env, isTest } from '../../config/env.js';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, Conflict, NotFound, Unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { bustActorCache } from '../../middleware/authenticate.js';
import {
  accessTokenTtlSeconds,
  issueRefresh,
  revokeAllForUser,
  signAccess,
  type RefreshContext,
} from './token.service.js';
import { toSessionDto, type UserWithParties } from './auth.serializers.js';

/**
 * bcryptjs cost 12. Pure JS — no build toolchain on Windows. argon2 is the
 * documented upgrade path.
 *
 * Tests drop to cost 4: the suite hashes a password in nearly every case and
 * the work factor is not what any of them are testing. Production, development
 * and the seed script all use 12.
 */
const BCRYPT_COST = isTest ? 4 : 12;

/** Five consecutive failures lock the account for fifteen minutes. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const INVALID_CREDENTIALS = () =>
  new AppError(401, 'auth.invalid_credentials', 'Email or password is incorrect');

/**
 * A bcrypt hash of a throwaway value. Compared against when the email does not
 * exist, so a missing account costs the same time as a wrong password and the
 * endpoint cannot be used to enumerate registered emails.
 */
const DUMMY_HASH = bcrypt.hashSync('tenderbridge-timing-equaliser', BCRYPT_COST);

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

const withParties = { organization: true, vendor: true } as const;

const auditActor = (user: User, ctx: RefreshContext): AuditActor => ({
  userId: user.id,
  email: user.email,
  role: user.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

async function assertEmailAvailable(email: string) {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw Conflict('auth.email_taken', 'An account with this email already exists');
}

/**
 * Party + first user + audit row, in one transaction. The party starts in
 * PENDING_APPROVAL: the user can sign in immediately and sees a "under review"
 * screen, while plan 05's requireActiveOrg gate blocks business actions until a
 * platform admin approves. Better UX than blocking login, and it makes the
 * approval step demo-able.
 */
export async function registerOrganization(input: RegisterOrganizationInput, ctx: RefreshContext) {
  await assertEmailAvailable(input.admin.email);

  const passwordHash = await hashPassword(input.admin.password);

  const { user, refreshToken } = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.organization.name,
        legalName: input.organization.legalName ?? null,
        email: input.organization.email,
        phone: input.organization.phone ?? null,
        gstin: input.organization.gstin ?? null,
        pan: input.organization.pan ?? null,
        addressLine1: input.organization.addressLine1,
        addressLine2: input.organization.addressLine2 ?? null,
        city: input.organization.city,
        state: input.organization.state,
        stateCode: input.organization.stateCode,
        pincode: input.organization.pincode,
        country: input.organization.country,
      },
    });

    const created = await tx.user.create({
      data: {
        email: input.admin.email,
        passwordHash,
        fullName: input.admin.fullName,
        phone: input.admin.phone ?? null,
        role: 'ORG_ADMIN',
        status: 'ACTIVE',
        organizationId: organization.id,
        lastLoginAt: new Date(),
      },
      include: withParties,
    });

    await writeAudit(tx, {
      action: 'user.registered',
      entityType: 'Organization',
      entityId: organization.id,
      summary: `Organization "${organization.name}" registered by ${created.email}`,
      severity: 'NOTABLE',
      organizationId: organization.id,
      actor: auditActor(created, ctx),
      after: { organizationId: organization.id, role: created.role },
    });

    const refreshToken = await issueRefresh(tx, created.id, ctx);
    return { user: created, refreshToken };
  });

  return buildSession(user, refreshToken);
}

export async function registerVendor(input: RegisterVendorInput, ctx: RefreshContext) {
  await assertEmailAvailable(input.admin.email);

  const passwordHash = await hashPassword(input.admin.password);

  const { user, refreshToken } = await prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.create({
      data: {
        companyName: input.vendor.companyName,
        legalName: input.vendor.legalName ?? null,
        email: input.vendor.email,
        phone: input.vendor.phone,
        gstin: input.vendor.gstin ?? null,
        pan: input.vendor.pan ?? null,
        addressLine1: input.vendor.addressLine1,
        addressLine2: input.vendor.addressLine2 ?? null,
        city: input.vendor.city,
        state: input.vendor.state,
        stateCode: input.vendor.stateCode,
        pincode: input.vendor.pincode,
        country: input.vendor.country,
        ...(input.categoryIds.length
          ? { categories: { connect: input.categoryIds.map((id) => ({ id })) } }
          : {}),
      },
    });

    const created = await tx.user.create({
      data: {
        email: input.admin.email,
        passwordHash,
        fullName: input.admin.fullName,
        phone: input.admin.phone ?? null,
        role: 'VENDOR',
        status: 'ACTIVE',
        vendorId: vendor.id,
        lastLoginAt: new Date(),
      },
      include: withParties,
    });

    await writeAudit(tx, {
      action: 'user.registered',
      entityType: 'Vendor',
      entityId: vendor.id,
      summary: `Vendor "${vendor.companyName}" registered by ${created.email}`,
      severity: 'NOTABLE',
      vendorId: vendor.id,
      actor: auditActor(created, ctx),
      after: { vendorId: vendor.id, role: created.role },
    });

    const refreshToken = await issueRefresh(tx, created.id, ctx);
    return { user: created, refreshToken };
  });

  return buildSession(user, refreshToken);
}

/* -------------------------------------------------------------------------- */
/* Login                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Wrong email, wrong password and a locked account all answer with the same
 * 401 body. The one exception is deliberate: a locked account gets
 * 423 auth.account_locked **only once the password was correct**, because
 * telling an attacker "this account is locked" for any password they try is an
 * account-existence oracle (03 §4).
 */
export async function login(input: LoginInput, ctx: RefreshContext) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: withParties,
  });

  if (!user) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    throw INVALID_CREDENTIALS();
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
  const locked = Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());

  if (!passwordMatches) {
    await registerFailedLogin(user, ctx);
    throw INVALID_CREDENTIALS();
  }

  if (locked) {
    throw new AppError(
      423,
      'auth.account_locked',
      'Too many failed attempts. Try again in a few minutes.',
    );
  }

  if (user.status !== 'ACTIVE') {
    throw new AppError(401, 'auth.unauthorized', 'Account is not active');
  }

  const { fresh, refreshToken } = await prisma.$transaction(async (tx) => {
    const fresh = await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      include: withParties,
    });

    await writeAudit(tx, {
      action: 'auth.login_success',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email} signed in`,
      organizationId: user.organizationId,
      vendorId: user.vendorId,
      actor: auditActor(user, ctx),
    });

    const refreshToken = await issueRefresh(tx, user.id, ctx);
    return { fresh, refreshToken };
  });

  bustActorCache(user.id);
  return buildSession(fresh, refreshToken);
}

async function registerFailedLogin(user: User, ctx: RefreshContext) {
  const failedLoginCount = user.failedLoginCount + 1;
  const shouldLock = failedLoginCount >= MAX_FAILED_LOGINS;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        ...(shouldLock ? { lockedUntil: new Date(Date.now() + LOCKOUT_MS) } : {}),
      },
    });

    await writeAudit(tx, {
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: user.id,
      summary: `Failed sign-in for ${user.email} (attempt ${failedLoginCount})`,
      severity: 'SECURITY',
      organizationId: user.organizationId,
      vendorId: user.vendorId,
      actor: auditActor(user, ctx),
    });

    if (shouldLock) {
      await writeAudit(tx, {
        action: 'auth.account_locked',
        entityType: 'User',
        entityId: user.id,
        summary: `${user.email} locked after ${failedLoginCount} failed attempts`,
        severity: 'SECURITY',
        organizationId: user.organizationId,
        vendorId: user.vendorId,
        actor: auditActor(user, ctx),
      });
    }
  });
}

export function buildSession(user: UserWithParties, refreshToken: string) {
  const accessToken = signAccess(user);
  return {
    session: toSessionDto(user, accessToken, accessTokenTtlSeconds(accessToken)),
    refreshToken,
  };
}

/** Used by the refresh endpoint, which already holds the rotated token. */
export async function sessionForUser(userId: string, refreshToken: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: withParties });
  if (!user) throw Unauthorized();
  return buildSession(user, refreshToken);
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: withParties });
  if (!user) throw NotFound('User');
  return user;
}

export async function updateMe(
  userId: string,
  data: { fullName?: string; phone?: string | null },
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
    },
    include: withParties,
  });
  bustActorCache(userId);
  return user;
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

/** Changing the password kills every other session but keeps the current one. */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  currentRefreshToken: string | undefined,
  ctx: RefreshContext,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw NotFound('User');

  const matches = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!matches) throw new AppError(422, 'auth.wrong_password', 'Current password is incorrect');

  const passwordHash = await hashPassword(input.newPassword);

  const revoked = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    const revoked = await revokeAllForUser(
      tx,
      userId,
      currentRefreshToken ? sha256(currentRefreshToken) : undefined,
    );

    await writeAudit(tx, {
      action: 'auth.password_changed',
      entityType: 'User',
      entityId: userId,
      summary: `${user.email} changed their password; ${revoked} other session(s) revoked`,
      severity: 'SECURITY',
      organizationId: user.organizationId,
      vendorId: user.vendorId,
      actor: auditActor(user, ctx),
    });

    return revoked;
  });

  sendMail({
    to: user.email,
    subject: 'Your TenderBridge password was changed',
    text: 'If this was not you, reset your password immediately.',
  });

  return { revokedSessions: revoked };
}

/**
 * Always the same 200, whether or not the email exists. The token is single-use,
 * hashed at rest, and expires in an hour.
 */
export async function forgotPassword(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    logger.info({ email }, 'Password reset requested for unknown email');
    return;
  }

  const token = randomToken(32);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: sha256(token),
      resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  sendMail({
    to: user.email,
    subject: 'Reset your TenderBridge password',
    text: `Reset your password: ${env.APP_URL}/reset-password/${token}\nThis link expires in one hour.`,
  });
}

export async function resetPassword(input: ResetPasswordInput, ctx: RefreshContext) {
  const tokenHash = sha256(input.token);
  const user = await prisma.user.findFirst({
    where: { resetTokenHash: tokenHash, resetTokenExpiresAt: { gt: new Date() } },
  });

  if (!user) {
    throw new AppError(410, 'auth.reset_token_invalid', 'This reset link is invalid or has expired');
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // Every existing session is assumed compromised.
    const revoked = await revokeAllForUser(tx, user.id);

    await writeAudit(tx, {
      action: 'auth.password_reset',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.email} reset their password; ${revoked} session(s) revoked`,
      severity: 'SECURITY',
      organizationId: user.organizationId,
      vendorId: user.vendorId,
      actor: auditActor(user, ctx),
    });
  });

  bustActorCache(user.id);
}

/* -------------------------------------------------------------------------- */
/* Logout                                                                     */
/* -------------------------------------------------------------------------- */

export async function logoutAll(userId: string, ctx: RefreshContext) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw NotFound('User');

  const revoked = await prisma.$transaction(async (tx) => {
    const revoked = await revokeAllForUser(tx, userId);
    await writeAudit(tx, {
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: userId,
      summary: `${user.email} signed out of ${revoked} session(s)`,
      severity: 'NOTABLE',
      organizationId: user.organizationId,
      vendorId: user.vendorId,
      actor: auditActor(user, ctx),
    });
    return revoked;
  });

  bustActorCache(userId);
  return { revokedSessions: revoked };
}

export type { Prisma };
