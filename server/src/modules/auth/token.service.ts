import { randomUUID } from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import type { CookieOptions, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@tb/shared';
import { env, isProd } from '../../config/env.js';
import { writeAudit } from '../../lib/audit.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, Unauthorized } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Access token: 15 minutes, held in React memory only.
 * Refresh token: 30 days, opaque, httpOnly cookie, and only its SHA-256 hash is
 * stored — a database dump yields no usable sessions.
 */

export const REFRESH_COOKIE = 'tb_rt';
/** Scoped so the cookie is never attached to ordinary API calls (03 §2). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface AccessPayload {
  sub: string;
  email: string;
  role: Role;
  organizationId: string | null;
  vendorId: string | null;
  jti: string;
}

export interface RefreshContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const signAccess = (user: Pick<User, 'id' | 'email' | 'role' | 'organizationId' | 'vendorId'>) =>
  jwt.sign(
    {
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      vendorId: user.vendorId,
      jti: randomUUID(),
    },
    env.JWT_ACCESS_SECRET,
    { subject: user.id, expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'] },
  );

export function verifyAccess(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  } catch {
    throw Unauthorized('Token expired or invalid');
  }
}

/** Seconds until the access token expires — what the client counts down. */
export function accessTokenTtlSeconds(token: string): number {
  const decoded = jwt.decode(token) as { exp?: number; iat?: number } | null;
  if (!decoded?.exp || !decoded.iat) return 900;
  return decoded.exp - decoded.iat;
}

const refreshExpiry = () =>
  new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

/**
 * Issue a refresh token. Rotation keeps the `familyId`: every token descended
 * from one login shares it, so detecting reuse can kill the whole lineage.
 */
export async function issueRefresh(
  tx: Prisma.TransactionClient,
  userId: string,
  ctx: RefreshContext,
  familyId: string = randomUUID(),
): Promise<string> {
  const raw = randomToken(32);
  await tx.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(raw),
      familyId,
      expiresAt: refreshExpiry(),
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
  return raw;
}

export async function revokeFamily(tx: Prisma.TransactionClient, familyId: string): Promise<number> {
  const { count } = await tx.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function revokeAllForUser(
  tx: Prisma.TransactionClient,
  userId: string,
  exceptTokenHash?: string,
): Promise<number> {
  const { count } = await tx.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptTokenHash ? { tokenHash: { not: exceptTokenHash } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return count;
}

export interface RotationResult {
  user: User;
  refreshToken: string;
}

/**
 * Rotate a refresh token, with reuse detection.
 *
 *   not found            -> 401
 *   found, already used  -> REUSE: revoke the whole family, SECURITY audit, 401
 *   found, live          -> revoke it, issue a successor in the same family
 *
 * A stolen token is therefore usable at most once, and the moment either party
 * presents the spent one, both sessions die. That is the correct behaviour.
 */
export async function rotateRefresh(rawToken: string, ctx: RefreshContext): Promise<RotationResult> {
  const tokenHash = sha256(rawToken);

  const presented = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!presented) throw Unauthorized('Session expired, sign in again');

  /**
   * Reuse. The revocation and its audit row are committed in their own
   * transaction *before* the 401 is thrown — throwing out of the transaction
   * that performed them would roll the family revocation straight back, and the
   * stolen session would survive the detection that was supposed to kill it.
   */
  if (presented.revokedAt) {
    await prisma.$transaction(async (tx) => {
      const revoked = await revokeFamily(tx, presented.familyId);
      await writeAudit(tx, {
        action: 'auth.refresh_reuse_detected',
        entityType: 'User',
        entityId: presented.userId,
        summary: `Refresh token reuse detected; ${revoked} session(s) in the family revoked`,
        severity: 'SECURITY',
        organizationId: presented.user.organizationId,
        vendorId: presented.user.vendorId,
        actor: {
          userId: presented.userId,
          email: presented.user.email,
          role: presented.user.role,
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
    });

    throw Unauthorized('Session expired, sign in again');
  }

  return prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: two concurrent refreshes of the same token
    // must not both succeed.
    const existing = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existing || existing.revokedAt) throw Unauthorized('Session expired, sign in again');

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw Unauthorized('Session expired, sign in again');
    }

    if (existing.user.status !== 'ACTIVE') {
      throw new AppError(401, 'auth.unauthorized', 'Account is not active');
    }

    const successor = await issueRefresh(tx, existing.userId, ctx, existing.familyId);

    await tx.refreshToken.update({
      where: { id: existing.id },
      data: {
        revokedAt: new Date(),
        replacedById: (await tx.refreshToken.findUnique({
          where: { tokenHash: sha256(successor) },
          select: { id: true },
        }))!.id,
      },
    });

    return { user: existing.user, refreshToken: successor };
  });
}

/** Revoke exactly one token — the current session, on logout. */
export async function revokeToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/*
 * `SameSite=None` in production, and only there.
 *
 * The client is on Vercel and the API is on Render — different sites — so a Lax
 * cookie is stored but never sent on the cross-site `POST /auth/refresh`, and
 * every session would die silently when the 15-minute access token expired.
 * `None` requires `Secure`, which holds in production because Render terminates
 * TLS. Locally the Vite proxy makes the cookie first-party, so Lax is both
 * correct and the stricter choice.
 */
const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  path: REFRESH_COOKIE_PATH,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
});

export const setRefreshCookie = (res: Response, token: string) =>
  res.cookie(REFRESH_COOKIE, token, cookieOptions());

export const clearRefreshCookie = (res: Response) =>
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
