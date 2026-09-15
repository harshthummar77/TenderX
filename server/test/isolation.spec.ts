import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { prisma } from '../src/lib/prisma.js';
import {
  assertOwned,
  findScoped,
  ownsRow,
  scopeToOrg,
  scopeToParty,
  scopeToVendor,
} from '../src/lib/scope.js';
import { randomToken, sha256 } from '../src/lib/crypto.js';
import { actorOf, makeUser, seedOrgWithData, type SeededOrg } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Layer 2 of access control: may this ACTOR see THIS ROW?
 *
 * Two fully populated organizations, each with its own vendor, tender, PO, GRN,
 * invoice, payment and document. Every cross-tenant read must answer **404**,
 * never 403 — a 403 confirms the row exists.
 *
 * The HTTP routes for these resources arrive in plans 05–15. Until then this
 * suite proves the helpers those routes will be built on, and the §6 table of
 * `GET/PATCH/list` cases is extended module by module as each lands. The final
 * test in this file is the one that keeps the suite honest: it shows an
 * unscoped query *does* cross the boundary, so these assertions are not
 * vacuously true.
 */

let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  await truncateAll();
  A = await seedOrgWithData('Org A');
  B = await seedOrgWithData('Org B');
});

afterAll(async () => {
  await disconnect();
});

describe('scope filters', () => {
  it('scopeToOrg pins an org user to their own organization', () => {
    expect(scopeToOrg(actorOf(A.admin.user))).toEqual({ organizationId: A.organization.id });
    expect(scopeToOrg(actorOf(A.officer.user))).toEqual({ organizationId: A.organization.id });
  });

  it('scopeToVendor pins a vendor user to their own company', () => {
    expect(scopeToVendor(actorOf(A.vendorUser.user))).toEqual({ vendorId: A.vendor.id });
  });

  it('scopeToParty resolves to whichever side the actor belongs to', () => {
    expect(scopeToParty(actorOf(A.admin.user))).toEqual({ organizationId: A.organization.id });
    expect(scopeToParty(actorOf(A.vendorUser.user))).toEqual({ vendorId: A.vendor.id });
  });

  it('a vendor user is refused an org-scoped query outright', () => {
    expect(() => scopeToOrg(actorOf(A.vendorUser.user))).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('an org user is refused a vendor-scoped query outright', () => {
    expect(() => scopeToVendor(actorOf(A.admin.user))).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('a platform admin reads across tenants — every filter is empty', async () => {
    const platformAdmin = await makeUser('PLATFORM_ADMIN');
    const actor = actorOf(platformAdmin.user);

    expect(scopeToOrg(actor)).toEqual({});
    expect(scopeToVendor(actor)).toEqual({});
    expect(scopeToParty(actor)).toEqual({});

    await expect(findScoped(prisma.tender, B.tender.id, actor, {}, scopeToOrg)).resolves.toMatchObject({
      id: B.tender.id,
    });
  });
});

describe('org A cannot reach org B rows', () => {
  const cases = () =>
    [
      ['tender', prisma.tender, B.tender.id, scopeToOrg],
      ['purchase order', prisma.purchaseOrder, B.purchaseOrder.id, scopeToParty],
      ['grn', prisma.grn, B.grn.id, scopeToOrg],
      ['invoice', prisma.invoice, B.invoice.id, scopeToParty],
      ['payment', prisma.payment, B.payment.id, scopeToParty],
      ['document', prisma.document, B.document.id, scopeToParty],
    ] as const;

  it('findScoped answers 404 for every resource type', async () => {
    const actor = actorOf(A.admin.user);

    for (const [label, model, id, scope] of cases()) {
      await expect(
        findScoped(model as never, id, actor, {}, scope),
        label,
      ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    }
  });

  it('never answers 403 for a row that exists in another tenant', async () => {
    const actor = actorOf(A.admin.user);

    // 403 would confirm the row exists. 404 tells the caller nothing.
    const error = await findScoped(prisma.tender, B.tender.id, actor, {}, scopeToOrg).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(404);
    expect((error as AppError).status).not.toBe(403);
  });

  it('finds its own rows through exactly the same call', async () => {
    const actor = actorOf(A.admin.user);

    await expect(findScoped(prisma.tender, A.tender.id, actor, {}, scopeToOrg)).resolves.toMatchObject({
      id: A.tender.id,
    });
    await expect(findScoped(prisma.invoice, A.invoice.id, actor, {}, scopeToParty)).resolves.toMatchObject({
      id: A.invoice.id,
    });
  });

  it('list queries exclude the other tenant', async () => {
    const actor = actorOf(A.admin.user);

    const tenders = await prisma.tender.findMany({ where: { ...scopeToOrg(actor) } });
    const ids = tenders.map((t) => t.id);

    expect(ids).toContain(A.tender.id);
    expect(ids).not.toContain(B.tender.id);
  });
});

describe('vendor to vendor', () => {
  it("a vendor cannot reach another vendor's purchase order, invoice or payment", async () => {
    const actor = actorOf(A.vendorUser.user);

    for (const [label, model, id] of [
      ['purchase order', prisma.purchaseOrder, B.purchaseOrder.id],
      ['invoice', prisma.invoice, B.invoice.id],
      ['payment', prisma.payment, B.payment.id],
      ['document', prisma.document, B.document.id],
    ] as const) {
      await expect(findScoped(model as never, id, actor, {}, scopeToParty), label).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it('a vendor does reach the documents on its own side of a shared PO', async () => {
    const actor = actorOf(A.vendorUser.user);

    await expect(findScoped(prisma.purchaseOrder, A.purchaseOrder.id, actor)).resolves.toMatchObject({
      id: A.purchaseOrder.id,
    });
    await expect(findScoped(prisma.invoice, A.invoice.id, actor)).resolves.toMatchObject({
      id: A.invoice.id,
    });
  });

  it("a vendor cannot reach another vendor's KYC document", async () => {
    const actor = actorOf(A.vendorUser.user);
    await expect(findScoped(prisma.document, B.document.id, actor)).rejects.toMatchObject({ status: 404 });
  });
});

describe('ownsRow / assertOwned', () => {
  it('recognises rows on either side of a shared document', () => {
    expect(ownsRow(actorOf(A.admin.user), A.invoice)).toBe(true);
    expect(ownsRow(actorOf(A.vendorUser.user), A.invoice)).toBe(true);
    expect(ownsRow(actorOf(A.admin.user), B.invoice)).toBe(false);
    expect(ownsRow(actorOf(A.vendorUser.user), B.invoice)).toBe(false);
  });

  it('throws 404 — not 403 — for a foreign row', () => {
    expect(() => assertOwned(actorOf(A.admin.user), B.payment)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('throws 404 for a missing row, so absent and forbidden look identical', () => {
    expect(() => assertOwned(actorOf(A.admin.user), null)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });
});

/**
 * Child rows are scoped through their parent. Fetching one by id alone is the
 * mistake this asserts against: the child carries no tenant column at all.
 */
describe('child rows have no tenant column of their own', () => {
  it('an invoice item is only reachable through its invoice', async () => {
    const poItem = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: B.purchaseOrder.id,
        srNo: 1,
        description: 'Fixture line',
        unit: 'NOS',
        quantity: '5.000',
        unitPrice: '1000.00',
        taxableValue: '5000.00',
        taxRatePercent: '18.00',
        lineTotal: '5900.00',
      },
    });
    const item = await prisma.invoiceItem.create({
      data: {
        invoiceId: B.invoice.id,
        purchaseOrderItemId: poItem.id,
        description: 'Fixture line',
        unit: 'NOS',
        quantity: '5.000',
        unitPrice: '1000.00',
        taxableValue: '5000.00',
        taxRatePercent: '18.00',
        lineTotal: '5900.00',
      },
    });

    // The row has no organizationId/vendorId to filter on...
    expect(item).not.toHaveProperty('organizationId');

    // ...so the parent is what carries the scope.
    const actor = actorOf(A.admin.user);
    await expect(findScoped(prisma.invoice, B.invoice.id, actor)).rejects.toMatchObject({ status: 404 });

    const reachable = await prisma.invoiceItem.findFirst({
      where: { id: item.id, invoice: { ...scopeToParty(actor) } },
    });
    expect(reachable).toBeNull();
  });
});

describe('over HTTP', () => {
  it("an org admin cannot revoke another org's invitation — 404, not 403", async () => {
    const token = randomToken(32);
    const invitation = await prisma.invitation.create({
      data: {
        email: 'target@orgb.test',
        role: 'ORG_OFFICER',
        organizationId: B.organization.id,
        tokenHash: sha256(token),
        invitedById: B.admin.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await request(app)
      .delete(`/api/v1/invitations/${invitation.id}`)
      .set(...A.admin.authHeader);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');

    // ...and org B can revoke it, through the identical call.
    const owner = await request(app)
      .delete(`/api/v1/invitations/${invitation.id}`)
      .set(...B.admin.authHeader);
    expect(owner.status).toBe(204);
  });

  it("an org's invitation list excludes the other org", async () => {
    await prisma.invitation.create({
      data: {
        email: 'listed@orgb.test',
        role: 'ORG_OFFICER',
        organizationId: B.organization.id,
        tokenHash: sha256(randomToken(32)),
        invitedById: B.admin.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await request(app).get('/api/v1/invitations').set(...A.admin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.map((row: { email: string }) => row.email)).not.toContain('listed@orgb.test');
  });

  it('a vendor sees only its own party on /auth/me', async () => {
    const res = await request(app).get('/api/v1/auth/me').set(...A.vendorUser.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.vendor.id).toBe(A.vendor.id);
    expect(res.body.data.organization).toBeNull();
  });
});

/**
 * The guard on the guards. If this test ever fails, the suite above has stopped
 * proving anything: it would mean the unscoped query also returns nothing, and
 * every 404 assertion would pass for the wrong reason.
 */
describe('the suite is not vacuous', () => {
  it('an unscoped findFirst DOES cross the tenant boundary', async () => {
    const leaked = await prisma.tender.findFirst({ where: { id: B.tender.id } });
    expect(leaked?.id).toBe(B.tender.id);

    const scoped = await prisma.tender.findFirst({
      where: { id: B.tender.id, ...scopeToOrg(actorOf(A.admin.user)) },
    });
    expect(scoped).toBeNull();
  });
});
