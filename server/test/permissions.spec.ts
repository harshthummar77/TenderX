import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS as P,
  ROLE_PERMISSIONS,
  ROLES,
  SEPARATION_OF_DUTIES_PERMISSIONS,
  hasPermission,
  type Permission,
  type Role,
} from '@tb/shared';
import { app } from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { requirePermission, requireRole } from '../src/middleware/requirePermission.js';
import { requestContext } from '../src/middleware/requestContext.js';
import { disconnect, truncateAll } from './helpers/db.js';
import { makeOrganization, makeUser, makeVendor, type TestActor } from './helpers/actors.js';

/**
 * Layer 1 of access control: may this ROLE do this ACTION at all?
 * Tenant scoping (layer 2) is proved in isolation.spec.ts.
 */

let platformAdmin: TestActor;
let orgAdmin: TestActor;
let officer: TestActor;
let vendorUser: TestActor;

const byRole = (): Record<Role, TestActor> => ({
  PLATFORM_ADMIN: platformAdmin,
  ORG_ADMIN: orgAdmin,
  ORG_OFFICER: officer,
  VENDOR: vendorUser,
});

/**
 * A throwaway app with one route per permission, so every cell of the matrix can
 * be probed over HTTP without waiting for plans 05–15 to add the real routes.
 */
function harness() {
  const a = express();
  a.use(express.json());
  a.use(requestContext);

  for (const permission of ALL_PERMISSIONS) {
    a.get(`/p/${encodeURIComponent(permission)}`, authenticate, requirePermission(permission), (_req, res) => {
      res.json({ success: true, data: { permission } });
    });
  }

  a.get('/admin-only', authenticate, requireRole('ORG_ADMIN'), (_req, res) => {
    res.json({ success: true, data: null });
  });

  a.use(errorHandler);
  return a;
}

beforeAll(async () => {
  await truncateAll();
  const organization = await makeOrganization('Permission Fixtures Ltd');
  const vendor = await makeVendor('Permission Fixtures Supplier');

  platformAdmin = await makeUser('PLATFORM_ADMIN');
  orgAdmin = await makeUser('ORG_ADMIN', { organizationId: organization.id });
  officer = await makeUser('ORG_OFFICER', { organizationId: organization.id });
  vendorUser = await makeUser('VENDOR', { vendorId: vendor.id });
});

afterAll(async () => {
  await disconnect();
});

describe('the matrix itself', () => {
  it('grants only permissions that exist in the catalogue', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  it('grants no permission twice to the same role', () => {
    for (const role of ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size).toBe(granted.length);
    }
  });

  it('leaves no permission unreachable by every role', () => {
    const reachable = new Set(ROLES.flatMap((role) => [...ROLE_PERMISSIONS[role]]));
    const orphans = ALL_PERMISSIONS.filter((permission) => !reachable.has(permission));
    expect(orphans).toEqual([]);
  });

  it('matches the table in docs/access-control.md', () => {
    const doc = readFileSync(new URL('../../docs/access-control.md', import.meta.url), 'utf8');

    for (const permission of ALL_PERMISSIONS) {
      const row = doc.split('\n').find((line) => line.startsWith(`| \`${permission}\``));
      expect(row, `docs row missing for ${permission}`).toBeTruthy();

      const cells = row!.split('|').slice(2, 6).map((cell) => cell.trim());
      const documented = ROLES.filter((_role, index) => cells[index] === '**Y**');
      const actual = ROLES.filter((role) => hasPermission(role, permission));
      expect(documented, `docs disagree about ${permission}`).toEqual(actual);
    }
  });
});

describe('separation of duties', () => {
  it.each(SEPARATION_OF_DUTIES_PERMISSIONS)('ORG_OFFICER does not hold %s', (permission) => {
    expect(hasPermission('ORG_OFFICER', permission)).toBe(false);
  });

  it.each(SEPARATION_OF_DUTIES_PERMISSIONS)('ORG_ADMIN does hold %s', (permission) => {
    // The counterpart: the work is not blocked, it is moved to the authoriser.
    const adminHolds = hasPermission('ORG_ADMIN', permission);
    expect(adminHolds).toBe(true);
  });

  /** The three that matter most: approve an award, approve an invoice, pay it. */
  it.each([P.APPROVAL_DECIDE, P.INVOICE_APPROVE, P.PAYMENT_RECORD])(
    'an officer token is refused %s over HTTP',
    async (permission) => {
      const res = await request(harness())
        .get(`/p/${encodeURIComponent(permission)}`)
        .set(...officer.authHeader);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('auth.forbidden');
    },
  );

  it('an officer cannot take a purchase from tender to payment alone', () => {
    const wholeChain: Permission[] = [
      P.TENDER_CREATE,
      P.TENDER_PUBLISH,
      P.EVALUATION_RECOMMEND,
      P.APPROVAL_DECIDE,
      P.PO_ISSUE,
      P.GRN_CREATE,
      P.INVOICE_APPROVE,
      P.PAYMENT_RECORD,
    ];
    const officerHolds = wholeChain.filter((permission) => hasPermission('ORG_OFFICER', permission));
    expect(officerHolds).not.toEqual(wholeChain);
    expect(officerHolds).toEqual([
      P.TENDER_CREATE,
      P.TENDER_PUBLISH,
      P.EVALUATION_RECOMMEND,
      P.GRN_CREATE,
    ]);
  });
});

describe('the platform is not a tenant', () => {
  const tenantWrites: Permission[] = [
    P.TENDER_CREATE,
    P.TENDER_UPDATE,
    P.TENDER_PUBLISH,
    P.VENDOR_CREATE,
    P.PO_ISSUE,
    P.GRN_CREATE,
    P.DELIVERY_CREATE,
    P.INVOICE_SUBMIT,
    P.INVOICE_APPROVE,
    P.PAYMENT_RECORD,
    P.APPROVAL_DECIDE,
  ];

  it.each(tenantWrites)('PLATFORM_ADMIN does not hold %s', (permission) => {
    expect(hasPermission('PLATFORM_ADMIN', permission)).toBe(false);
  });

  it('PLATFORM_ADMIN is refused POST-shaped permissions over HTTP', async () => {
    const res = await request(harness())
      .get(`/p/${encodeURIComponent(P.TENDER_CREATE)}`)
      .set(...platformAdmin.authHeader);
    expect(res.status).toBe(403);
  });

  it('PLATFORM_ADMIN can still read tenders and approve parties', async () => {
    for (const permission of [P.TENDER_VIEW, P.ORG_APPROVE, P.VENDOR_APPROVE, P.AUDIT_VIEW]) {
      const res = await request(harness())
        .get(`/p/${encodeURIComponent(permission)}`)
        .set(...platformAdmin.authHeader);
      expect(res.status, permission).toBe(200);
    }
  });
});

describe('requirePermission over the whole matrix', () => {
  const cases = ROLES.flatMap((role) =>
    ALL_PERMISSIONS.map((permission) => ({ role, permission, expected: hasPermission(role, permission) })),
  );

  it('answers 200 exactly where the matrix grants and 403 everywhere else', async () => {
    const a = harness();
    const actors = byRole();
    const mismatches: string[] = [];

    for (const { role, permission, expected } of cases) {
      const res = await request(a)
        .get(`/p/${encodeURIComponent(permission)}`)
        .set(...actors[role].authHeader);

      const ok = res.status === (expected ? 200 : 403);
      if (!ok) mismatches.push(`${role} ${permission}: expected ${expected ? 200 : 403}, got ${res.status}`);
    }

    expect(mismatches).toEqual([]);
  });

  it('answers 401 without a token, before any permission is considered', async () => {
    const res = await request(harness()).get(`/p/${encodeURIComponent(P.TENDER_VIEW)}`);
    expect(res.status).toBe(401);
  });
});

describe('a vendor token on buyer-side actions', () => {
  const buyerSide: Permission[] = [
    P.TENDER_CREATE,
    P.TENDER_UPDATE,
    P.TENDER_PUBLISH,
    P.TENDER_CANCEL,
    P.QUOTATION_VIEW_ALL,
    P.EVALUATION_RUN,
    P.EVALUATION_RECOMMEND,
    P.APPROVAL_DECIDE,
    P.PO_ISSUE,
    P.GRN_CREATE,
    P.INVOICE_APPROVE,
    P.PAYMENT_RECORD,
    P.ORG_UPDATE,
    P.ORG_MEMBER_MANAGE,
  ];

  it.each(buyerSide)('403 on %s', async (permission) => {
    const res = await request(harness())
      .get(`/p/${encodeURIComponent(permission)}`)
      .set(...vendorUser.authHeader);
    expect(res.status).toBe(403);
  });
});

describe('requireRole', () => {
  it('admits the listed role and refuses the others', async () => {
    const a = harness();
    expect((await request(a).get('/admin-only').set(...orgAdmin.authHeader)).status).toBe(200);
    expect((await request(a).get('/admin-only').set(...officer.authHeader)).status).toBe(403);
    expect((await request(a).get('/admin-only').set(...vendorUser.authHeader)).status).toBe(403);
  });
});

/**
 * Route coverage (04 §10): every registered route carries `authenticate` unless
 * it is on the public allow-list, and a permission guard unless it is an
 * identity route about the caller's own account. A route added with a bare
 * handler fails this test rather than shipping unguarded.
 */
describe('route coverage', () => {
  const PUBLIC = new Set([
    'GET /health',
    'GET /ready',
    'POST /auth/register/organization',
    'POST /auth/register/vendor',
    'POST /auth/login',
    'POST /auth/refresh',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    // The invitee has a token, not an account yet.
    'GET /invitations/:token',
    'POST /invitations/:token/accept',
  ]);

  /**
   * Authenticated, but about your own account rather than a tenant resource, so
   * there is no permission to require: the caller is the only subject.
   *
   * Ownership is enforced in the service for each of these — a document or a
   * notification belonging to someone else answers 403/404, which the isolation
   * suite and the plan 19 §5 review both check — and `/dashboard` switches on
   * the caller's own role rather than gating on a permission.
   */
  const IDENTITY = new Set([
    'POST /auth/logout',
    'POST /auth/logout-all',
    'GET /auth/me',
    'PATCH /auth/me',
    'POST /auth/change-password',
    'GET /documents',
    'GET /documents/:id',
    'GET /documents/:id/download',
    'GET /notifications',
    'GET /notifications/unread-count',
    'POST /notifications/read-all',
    'POST /notifications/:id/read',
    'GET /me/notification-preferences',
    'GET /activity/me',
    'GET /dashboard',
  ]);

  interface RouteInfo {
    key: string;
    handlers: string[];
  }

  function collectRoutes(): RouteInfo[] {
    const root = (app as unknown as { router?: { stack: any[] }; _router?: { stack: any[] } });
    const stack = root.router?.stack ?? root._router?.stack ?? [];
    const routes: RouteInfo[] = [];

    const walk = (layers: any[], prefix: string) => {
      for (const layer of layers) {
        if (layer.route) {
          const path = prefix + layer.route.path;
          const handlers = layer.route.stack.map((s: any) => s.name as string);
          for (const method of Object.keys(layer.route.methods)) {
            routes.push({ key: `${method.toUpperCase()} ${path}`, handlers });
          }
        } else if (layer.handle?.stack) {
          walk(layer.handle.stack, prefix);
        }
      }
    };

    walk(stack, '');
    // The /_test tree is mounted only under `if (isTest)` in routes.ts and
    // additionally refuses every request with a 404 unless `isTest` — see
    // test.routes.ts. It has no user to authenticate, so it is not a route this
    // assertion can say anything useful about.
    return routes.filter((route) => !route.key.includes(' /_test/'));
  }

  it('finds the mounted routes', () => {
    const routes = collectRoutes();
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.map((r) => r.key)).toContain('GET /health');
  });

  it('guards every non-public route with authenticate', () => {
    const unguarded = collectRoutes()
      .filter((route) => !PUBLIC.has(route.key))
      .filter((route) => !route.handlers.includes('authenticate'))
      .map((route) => route.key);

    expect(unguarded).toEqual([]);
  });

  it('guards every resource route with a permission check', () => {
    const missing = collectRoutes()
      .filter((route) => !PUBLIC.has(route.key) && !IDENTITY.has(route.key))
      .filter((route) => !route.handlers.some((name) => name === 'permissionGuard' || name === 'roleGuard'))
      .map((route) => route.key);

    expect(missing).toEqual([]);
  });

  it('keeps the allow-lists honest — every listed route actually exists', () => {
    const keys = new Set(collectRoutes().map((route) => route.key));
    for (const key of [...PUBLIC, ...IDENTITY]) {
      expect(keys.has(key), `allow-listed route no longer exists: ${key}`).toBe(true);
    }
  });
});
