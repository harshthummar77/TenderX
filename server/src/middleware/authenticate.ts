import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '@tb/shared';
import { Unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { verifyAccess } from '../modules/auth/token.service.js';

export interface Actor {
  userId: string;
  email: string;
  role: Role;
  organizationId: string | null;
  vendorId: string | null;
  isPlatformAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

interface CachedUser {
  id: string;
  email: string;
  role: Role;
  status: string;
  organizationId: string | null;
  vendorId: string | null;
}

/**
 * 60-second actor cache.
 *
 * The JWT alone is not trusted: suspending a user or changing their role has to
 * take effect quickly, which means re-reading the user. Caching for a minute
 * keeps that to roughly one query per user per minute — and on Neon every query
 * wakes the compute (00 §7B), so this is a cost decision as much as a
 * performance one. Bust it explicitly whenever the row changes.
 */
const ACTOR_TTL_MS = 60_000;
const cache = new Map<string, { user: CachedUser | null; expiresAt: number }>();

export function bustActorCache(userId: string): void {
  cache.delete(userId);
}

export function clearActorCache(): void {
  cache.clear();
}

async function getActorCached(userId: string): Promise<CachedUser | null> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.user;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, status: true, organizationId: true, vendorId: true },
  });

  cache.set(userId, { user, expiresAt: Date.now() + ACTOR_TTL_MS });
  return user;
}

const toActor = (user: CachedUser): Actor => ({
  userId: user.id,
  email: user.email,
  role: user.role,
  organizationId: user.organizationId,
  vendorId: user.vendorId,
  isPlatformAdmin: user.role === 'PLATFORM_ADMIN',
});

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
};

export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = bearer(req);
  if (!token) throw Unauthorized();

  const payload = verifyAccess(token);
  const user = await getActorCached(payload.sub);
  if (!user || user.status !== 'ACTIVE') throw Unauthorized('Account is not active');

  req.actor = toActor(user);
  next();
};

/**
 * Populates `req.actor` when a valid token is present and continues silently
 * otherwise — for endpoints that show more to a signed-in caller (public tender
 * listings, plan 07).
 */
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const token = bearer(req);
  if (!token) return next();

  try {
    const payload = verifyAccess(token);
    const user = await getActorCached(payload.sub);
    if (user && user.status === 'ACTIVE') req.actor = toActor(user);
  } catch {
    // An invalid token is treated as no token here, by design.
  }
  next();
};

/** Every authenticated route has `req.actor`; this is the typed accessor. */
export function requireActor(req: Request): Actor {
  if (!req.actor) throw Unauthorized();
  return req.actor;
}
