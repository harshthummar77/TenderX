import type { RequestHandler } from 'express';
import {
  hasAnyPermission,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@tb/shared';
import { Forbidden, Unauthorized } from '../lib/errors.js';

/**
 * Layer 1 of two (04 §1): may this ROLE do this ACTION at all? Answers 403.
 * Layer 2 is data scoping in the service — see lib/scope.ts — which answers 404.
 *
 * These handlers are named functions on purpose: the route-coverage test walks
 * the Express stack and identifies guards by `handle.name`.
 */

/** Requires EVERY listed permission. */
export const requirePermission = (...needed: Permission[]): RequestHandler =>
  function permissionGuard(req, _res, next) {
    const actor = req.actor;
    if (!actor) throw Unauthorized();

    const granted = ROLE_PERMISSIONS[actor.role] ?? [];
    const missing = needed.filter((permission) => !granted.includes(permission));
    if (missing.length) throw Forbidden(`Missing permission: ${missing.join(', ')}`);

    next();
  };

/**
 * Requires ANY of the listed permissions — for one endpoint that several roles
 * reach by different routes. Invitations are the case: an org admin manages
 * members, a vendor manages its own company's logins, a platform admin manages
 * the platform. Which role may grant which role is then decided in the service.
 */
export const requireAnyPermission = (...accepted: Permission[]): RequestHandler =>
  function permissionGuard(req, _res, next) {
    const actor = req.actor;
    if (!actor) throw Unauthorized();
    if (!hasAnyPermission(actor.role, accepted)) {
      throw Forbidden(`Requires one of: ${accepted.join(', ')}`);
    }
    next();
  };

/** Role check for the rare endpoint that is about the role itself, not an action. */
export const requireRole = (...roles: Role[]): RequestHandler =>
  function roleGuard(req, _res, next) {
    if (!req.actor) throw Unauthorized();
    if (!roles.includes(req.actor.role)) throw Forbidden();
    next();
  };
