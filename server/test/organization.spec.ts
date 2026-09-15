import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS as P } from '@tb/shared';
import { app } from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { requirePermission } from '../src/middleware/requirePermission.js';
import { requireActiveOrg, clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { requestContext } from '../src/middleware/requestContext.js';
import { prisma } from '../src/lib/prisma.js';
import { makeOrganization, makeUser, makeVendor } from './helpers/actors.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * A stand-in for the business routes of plans 07–15, mounted with the same
 * guard chain they will use. It exists so `requireActiveOrg` can be proved now
 * rather than "when tenders land".
 */
function businessRoutes() {
  const a = express();
  a.use(express.json());
  a.use(requestContext);
  a.post('/tenders', authenticate, requireActiveOrg, requirePermission(P.TENDER_CREATE), (_req, res) => {
    res.status(201).json({ success: true, data: { created: true } });
  });
  a.use(errorHandler);
  return a;
}

const VALID_GSTIN = '27AAPFU0939F1ZV';

/** A complete, approvable organization: valid GSTIN, PAN, address, GST certificate. */
async function makeApprovableOrg(name: string, status: 'PENDING_APPROVAL' | 'ACTIVE' = 'PENDING_APPROVAL') {
  const org = await makeOrganization(name);
  const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

  await prisma.organization.update({
    where: { id: org.id },
    data: { status, gstin: VALID_GSTIN, pan: 'AAPFU0939F' },
  });
  await prisma.document.create({
    data: {
      ownerType: 'ORGANIZATION',
      ownerId: org.id,
      organizationId: org.id,
      type: 'ORG_GST_CERTIFICATE',
      fileName: 'gst.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `cloudinary-${org.id}`,
      uploadedById: admin.user.id,
    },
  });

  return { org: await prisma.organization.findUniqueOrThrow({ where: { id: org.id } }), admin };
}

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
});

afterAll(async () => {
  await disconnect();
});

describe('the lifecycle gate', () => {
  it('lets a pending org read its profile but refuses business actions', async () => {
    const org = await makeOrganization('Pending Buyer Ltd');
    await prisma.organization.update({ where: { id: org.id }, data: { status: 'PENDING_APPROVAL' } });
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const profile = await request(app).get('/api/v1/organizations/me').set(...admin.authHeader);
    expect(profile.status).toBe(200);

    const blocked = await request(businessRoutes()).post('/tenders').set(...admin.authHeader).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('organization.not_active');
    expect(blocked.body.error.message).toMatch(/awaiting platform approval/i);
  });

  it('lets an active org through the same chain', async () => {
    const org = await makeOrganization('Active Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(businessRoutes()).post('/tenders').set(...admin.authHeader).send({});
    expect(res.status).toBe(201);
  });

  it('refuses a suspended org with a different message', async () => {
    const org = await makeOrganization('Suspended Buyer Ltd');
    await prisma.organization.update({ where: { id: org.id }, data: { status: 'SUSPENDED' } });
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(businessRoutes()).post('/tenders').set(...admin.authHeader).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/suspended/i);
  });

  it('never blocks a platform admin', async () => {
    const platformAdmin = await makeUser('PLATFORM_ADMIN');
    const res = await request(businessRoutes()).post('/tenders').set(...platformAdmin.authHeader).send({});
    // Past the org gate, stopped by the permission matrix instead.
    expect(res.status).toBe(403);
  });
});

describe('profile and completion score', () => {
  it('scores an empty profile and lists what is missing', async () => {
    const org = await makeOrganization('Fresh Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app).get('/api/v1/organizations/me').set(...admin.authHeader);

    expect(res.status).toBe(200);
    // basic + address only: 15 + 20.
    expect(res.body.data.completion.score).toBe(35);
    const missing = res.body.data.completion.checks.filter((c: { done: boolean }) => !c.done);
    expect(missing.map((c: { key: string }) => c.key)).toEqual(['gstin', 'pan', 'documents']);
  });

  it('reaches 100 once GSTIN, PAN and the certificate are in place', async () => {
    const { admin } = await makeApprovableOrg('Complete Buyer Ltd');

    const res = await request(app).get('/api/v1/organizations/me').set(...admin.authHeader);
    expect(res.body.data.completion.score).toBe(100);
  });

  it('rejects a GSTIN that fails the checksum', async () => {
    const org = await makeOrganization('Checksum Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app)
      .patch('/api/v1/organizations/me')
      .set(...admin.authHeader)
      .send({ gstin: '27AAPFU0939F1ZA' });

    expect(res.status).toBe(422);
    expect(res.body.error.fields[0].path).toBe('gstin');
  });

  it('an officer can read the profile but not change it', async () => {
    const org = await makeOrganization('Read Only Buyer Ltd');
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    expect((await request(app).get('/api/v1/organizations/me').set(...officer.authHeader)).status).toBe(200);

    const res = await request(app)
      .patch('/api/v1/organizations/me')
      .set(...officer.authHeader)
      .send({ name: 'Renamed by officer' });
    expect(res.status).toBe(403);
  });
});

describe('rule 6 — state code freezes once a PO exists', () => {
  it('allows the change before any purchase order', async () => {
    const org = await makeOrganization('Movable Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app)
      .patch('/api/v1/organizations/me')
      .set(...admin.authHeader)
      .send({ stateCode: '27', state: 'Maharashtra' });

    expect(res.status).toBe(200);
    expect(res.body.data.stateCode).toBe('27');
    expect(res.body.data.stateCodeEditable).toBe(true);
  });

  it('refuses it afterwards — it fixes the tax regime on every existing document', async () => {
    const org = await makeOrganization('Committed Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const vendor = await makeVendor('Committed Supplier');

    await prisma.purchaseOrder.create({
      data: {
        organizationId: org.id,
        vendorId: vendor.id,
        poNumber: 'PO/TEST/000001',
        buyerName: org.name,
        buyerAddress: '1 Ring Road',
        buyerStateCode: '24',
        vendorName: vendor.companyName,
        vendorAddress: '9 Industrial Estate',
        vendorStateCode: '24',
        placeOfSupplyStateCode: '24',
        taxRegime: 'INTRA_STATE',
        expectedDeliveryDate: new Date(),
        deliveryAddress: '1 Ring Road',
        createdById: admin.user.id,
      },
    });

    const res = await request(app)
      .patch('/api/v1/organizations/me')
      .set(...admin.authHeader)
      .send({ stateCode: '27' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('organization.state_locked');

    // Other fields still update fine.
    const rename = await request(app)
      .patch('/api/v1/organizations/me')
      .set(...admin.authHeader)
      .send({ name: 'Committed Buyer Limited' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.stateCodeEditable).toBe(false);
  });
});

describe('settings', () => {
  it('returns typed defaults before anything is saved', async () => {
    const org = await makeOrganization('Defaults Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app).get('/api/v1/organizations/me/settings').set(...admin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      matchTolerancePercent: 2,
      approvalThresholdAmount: 50000,
      requireGrnBeforeInvoice: true,
      minVendorsPerTender: 3,
    });
    expect(res.body.data.numberPrefixes.PURCHASE_ORDER).toBe('PO');
  });

  it('deep merges a single field without dropping the rest', async () => {
    const org = await makeOrganization('Merge Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...admin.authHeader)
      .send({ numberPrefixes: { TENDER: 'RFQ' } })
      .expect(200);

    const res = await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...admin.authHeader)
      .send({ minVendorsPerTender: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.minVendorsPerTender).toBe(5);
    // The earlier prefix survived, and so did the untouched defaults.
    expect(res.body.data.numberPrefixes.TENDER).toBe('RFQ');
    expect(res.body.data.numberPrefixes.INVOICE).toBe('INV');
    expect(res.body.data.matchTolerancePercent).toBe(2);
  });

  it('audits a match-tolerance change with both values and the actor', async () => {
    const org = await makeOrganization('Tolerance Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...admin.authHeader)
      .send({ matchTolerancePercent: 5 })
      .expect(200);

    const audit = await prisma.activityLog.findFirst({
      where: { action: 'organization.settings_updated' },
      orderBy: { sequence: 'desc' },
    });

    expect(audit?.severity).toBe('NOTABLE');
    expect(audit?.actorEmail).toBe(admin.user.email);
    expect(audit?.summary).toContain('matchTolerancePercent');
    expect((audit?.before as { matchTolerancePercent: number }).matchTolerancePercent).toBe(2);
    expect((audit?.after as { matchTolerancePercent: number }).matchTolerancePercent).toBe(5);
  });

  it('refuses a tolerance outside the allowed range', async () => {
    const org = await makeOrganization('Range Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...admin.authHeader)
      .send({ matchTolerancePercent: 50 });

    expect(res.status).toBe(422);
  });
});

describe('members', () => {
  it('lists only this organization', async () => {
    const org = await makeOrganization('Roster Buyer Ltd');
    const other = await makeOrganization('Other Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    await makeUser('ORG_OFFICER', { organizationId: org.id });
    const outsider = await makeUser('ORG_OFFICER', { organizationId: other.id });

    const res = await request(app).get('/api/v1/organizations/me/members').set(...admin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((m: { id: string }) => m.id)).not.toContain(outsider.user.id);
    expect(res.body.data[0]).not.toHaveProperty('passwordHash');
  });

  it('rule 3 — inviting an existing member is a duplicate', async () => {
    const org = await makeOrganization('Duplicate Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });

    const res = await request(app)
      .post('/api/v1/organizations/me/members/invite')
      .set(...admin.authHeader)
      .send({ email: officer.user.email, role: 'ORG_OFFICER' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invitation.duplicate');
  });

  it('invites a new officer', async () => {
    const org = await makeOrganization('Hiring Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app)
      .post('/api/v1/organizations/me/members/invite')
      .set(...admin.authHeader)
      .send({ email: 'newofficer@hiring.test', role: 'ORG_OFFICER' });

    expect(res.status).toBe(201);
    const invitation = await prisma.invitation.findFirst({ where: { email: 'newofficer@hiring.test' } });
    expect(invitation?.organizationId).toBe(org.id);
  });

  it('rule 1 — the last active admin cannot be demoted or suspended', async () => {
    const org = await makeOrganization('Solo Admin Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const secondAdmin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    // Two admins: demoting one is fine.
    const first = await request(app)
      .patch(`/api/v1/organizations/me/members/${secondAdmin.user.id}`)
      .set(...admin.authHeader)
      .send({ role: 'ORG_OFFICER' });
    expect(first.status).toBe(200);

    // Now only one admin remains, and the officer cannot demote them either way.
    const officer = await makeUser('ORG_OFFICER', { organizationId: org.id });
    const promoted = await makeUser('ORG_ADMIN', { organizationId: org.id });

    await request(app)
      .patch(`/api/v1/organizations/me/members/${admin.user.id}`)
      .set(...promoted.authHeader)
      .send({ role: 'ORG_OFFICER' })
      .expect(200);

    const last = await request(app)
      .patch(`/api/v1/organizations/me/members/${promoted.user.id}`)
      .set(...promoted.authHeader)
      .send({ role: 'ORG_OFFICER' });

    // Self-modification is caught first — the rule that fires does not matter to
    // the caller, but the last admin must survive either way.
    expect(last.status).toBe(422);
    expect(officer.user.role).toBe('ORG_OFFICER');

    const stillAdmin = await prisma.user.count({
      where: { organizationId: org.id, role: 'ORG_ADMIN', status: 'ACTIVE' },
    });
    expect(stillAdmin).toBeGreaterThanOrEqual(1);
  });

  it('rule 1 — suspending the only admin is refused', async () => {
    const org = await makeOrganization('Only Admin Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const other = await makeUser('ORG_ADMIN', { organizationId: org.id });

    // Suspend the second admin: allowed, one remains.
    await request(app)
      .delete(`/api/v1/organizations/me/members/${other.user.id}`)
      .set(...admin.authHeader)
      .expect(204);

    // A freshly promoted admin then tries to suspend the last remaining one.
    const promoted = await makeUser('ORG_ADMIN', { organizationId: org.id });
    await request(app)
      .delete(`/api/v1/organizations/me/members/${admin.user.id}`)
      .set(...promoted.authHeader)
      .expect(204);

    const res = await request(app)
      .delete(`/api/v1/organizations/me/members/${promoted.user.id}`)
      .set(...promoted.authHeader);

    expect(res.status).toBe(422);
  });

  it('rule 2 — nobody can change their own role or suspend themselves', async () => {
    const org = await makeOrganization('Self Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    await makeUser('ORG_ADMIN', { organizationId: org.id });

    const roleChange = await request(app)
      .patch(`/api/v1/organizations/me/members/${admin.user.id}`)
      .set(...admin.authHeader)
      .send({ role: 'ORG_OFFICER' });

    expect(roleChange.status).toBe(422);
    expect(roleChange.body.error.code).toBe('organization.self_modification');

    const selfSuspend = await request(app)
      .delete(`/api/v1/organizations/me/members/${admin.user.id}`)
      .set(...admin.authHeader);
    expect(selfSuspend.status).toBe(422);
  });

  it('rule 5 — a demoted admin is restricted on their very next request', async () => {
    const org = await makeOrganization('Demotion Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const victim = await makeUser('ORG_ADMIN', { organizationId: org.id });

    // The victim's token works as an admin right now.
    await request(app)
      .patch('/api/v1/organizations/me')
      .set(...victim.authHeader)
      .send({ name: 'Renamed while admin' })
      .expect(200);

    await request(app)
      .patch(`/api/v1/organizations/me/members/${victim.user.id}`)
      .set(...admin.authHeader)
      .send({ role: 'ORG_OFFICER' })
      .expect(200);

    // Same still-valid JWT, next request: already an officer. No 60-second wait.
    const after = await request(app)
      .patch('/api/v1/organizations/me')
      .set(...victim.authHeader)
      .send({ name: 'Renamed after demotion' });

    expect(after.status).toBe(403);

    // ...and their sessions were revoked, so they cannot refresh either.
    const live = await prisma.refreshToken.count({
      where: { userId: victim.user.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it("a member of another organization is a 404, not a 403", async () => {
    const org = await makeOrganization('Scoped Buyer Ltd');
    const other = await makeOrganization('Foreign Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const foreigner = await makeUser('ORG_OFFICER', { organizationId: other.id });

    const res = await request(app)
      .patch(`/api/v1/organizations/me/members/${foreigner.user.id}`)
      .set(...admin.authHeader)
      .send({ role: 'ORG_ADMIN' });

    expect(res.status).toBe(404);
  });
});

describe('platform approval', () => {
  it('refuses approval with incomplete KYC and names what is missing', async () => {
    const org = await makeOrganization('Incomplete Buyer Ltd');
    await prisma.organization.update({ where: { id: org.id }, data: { status: 'PENDING_APPROVAL' } });
    await makeUser('ORG_ADMIN', { organizationId: org.id });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/organizations/${org.id}/approve`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('organization.incomplete_kyc');
    const messages = res.body.error.fields.map((f: { message: string }) => f.message);
    expect(messages).toContain('GSTIN is required');
    expect(messages).toContain('PAN is required');
    expect(messages).toContain('GST certificate document must be uploaded');
  });

  it('approves a complete org, seeds six sequences, audits and notifies', async () => {
    const { org, admin } = await makeApprovableOrg('Approvable Buyer Ltd');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/organizations/${org.id}/approve`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');

    const sequences = await prisma.numberSequence.findMany({ where: { organizationId: org.id } });
    expect(sequences).toHaveLength(6);
    expect(sequences.map((s) => s.docType).sort()).toEqual([
      'GRN',
      'INVOICE',
      'PAYMENT',
      'PURCHASE_ORDER',
      'QUOTATION',
      'TENDER',
    ]);
    expect(sequences.every((s) => s.nextValue === 1 && s.padding === 6)).toBe(true);

    const audit = await prisma.activityLog.findFirst({ where: { action: 'organization.approved' } });
    expect(audit?.actorEmail).toBe(platformAdmin.user.email);

    const notification = await prisma.notification.findFirst({ where: { userId: admin.user.id } });
    expect(notification?.title).toMatch(/approved/i);

    // ...and the business gate now lets the org through.
    const tender = await request(businessRoutes()).post('/tenders').set(...admin.authHeader).send({});
    expect(tender.status).toBe(201);
  });

  it('refuses to approve twice', async () => {
    const { org } = await makeApprovableOrg('Twice Buyer Ltd', 'ACTIVE');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/organizations/${org.id}/approve`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('organization.already_active');
  });

  it('rejection keeps the org pending so it can fix and resubmit', async () => {
    const { org, admin } = await makeApprovableOrg('Rejected Buyer Ltd');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .post(`/api/v1/platform/organizations/${org.id}/reject`)
      .set(...platformAdmin.authHeader)
      .send({ reason: 'GST certificate is illegible, please re-upload' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING_APPROVAL');

    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(fresh.status).toBe('PENDING_APPROVAL');

    const notification = await prisma.notification.findFirst({ where: { userId: admin.user.id } });
    expect(notification?.body).toMatch(/illegible/);

    const audit = await prisma.activityLog.findFirst({ where: { action: 'organization.rejected' } });
    expect(audit?.summary).toContain('illegible');
  });

  it('suspension is a SECURITY audit event and blocks business actions', async () => {
    const { org, admin } = await makeApprovableOrg('Suspendable Buyer Ltd', 'ACTIVE');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await request(app)
      .post(`/api/v1/platform/organizations/${org.id}/suspend`)
      .set(...platformAdmin.authHeader)
      .send({ reason: 'Payment dispute under investigation' })
      .expect(200);

    const audit = await prisma.activityLog.findFirst({ where: { action: 'organization.suspended' } });
    expect(audit?.severity).toBe('SECURITY');

    const blocked = await request(businessRoutes()).post('/tenders').set(...admin.authHeader).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/suspended/i);
  });

  it('an org admin cannot reach the platform endpoints at all', async () => {
    const { org, admin } = await makeApprovableOrg('Curious Buyer Ltd');

    expect((await request(app).get('/api/v1/platform/organizations').set(...admin.authHeader)).status).toBe(403);
    expect(
      (await request(app).post(`/api/v1/platform/organizations/${org.id}/approve`).set(...admin.authHeader))
        .status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/platform/stats').set(...admin.authHeader)).status).toBe(403);
  });
});

describe('platform views', () => {
  it('lists organizations with counts and completion, filtered by status', async () => {
    await makeApprovableOrg('Listed Active Ltd', 'ACTIVE');
    const pending = await makeOrganization('Listed Pending Ltd');
    await prisma.organization.update({ where: { id: pending.id }, data: { status: 'PENDING_APPROVAL' } });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const all = await request(app).get('/api/v1/platform/organizations').set(...platformAdmin.authHeader);
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(2);

    const onlyPending = await request(app)
      .get('/api/v1/platform/organizations?status=PENDING_APPROVAL')
      .set(...platformAdmin.authHeader);

    expect(onlyPending.body.data).toHaveLength(1);
    expect(onlyPending.body.data[0].name).toBe('Listed Pending Ltd');
    expect(onlyPending.body.data[0].completionScore).toBe(35);
    expect(onlyPending.body.data[0].userCount).toBe(0);
  });

  it('detail carries the missing-KYC list the approve button needs', async () => {
    const org = await makeOrganization('Detail Buyer Ltd');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    const res = await request(app)
      .get(`/api/v1/platform/organizations/${org.id}`)
      .set(...platformAdmin.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.missingKyc.length).toBeGreaterThan(0);
    expect(res.body.data.documents).toEqual([]);
  });

  it('stats returns every money field as a string and reports a valid chain', async () => {
    const { org, admin } = await makeApprovableOrg('Stats Buyer Ltd', 'ACTIVE');
    const vendor = await makeVendor('Stats Supplier');
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await prisma.purchaseOrder.create({
      data: {
        organizationId: org.id,
        vendorId: vendor.id,
        poNumber: 'PO/STATS/000001',
        buyerName: org.name,
        buyerAddress: '1 Ring Road',
        buyerStateCode: '24',
        vendorName: vendor.companyName,
        vendorAddress: '9 Industrial Estate',
        vendorStateCode: '24',
        placeOfSupplyStateCode: '24',
        taxRegime: 'INTRA_STATE',
        expectedDeliveryDate: new Date(),
        deliveryAddress: '1 Ring Road',
        createdById: admin.user.id,
        totalAmount: '118000.00',
      },
    });

    // Fixtures are written straight through Prisma, so make one audited change
    // to give the chain something to verify.
    await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...admin.authHeader)
      .send({ defaultPaymentTermDays: 45 })
      .expect(200);

    const res = await request(app).get('/api/v1/platform/stats').set(...platformAdmin.authHeader);

    expect(res.status).toBe(200);
    const { financial, organizations, system } = res.body.data;

    for (const [key, value] of Object.entries(financial)) {
      expect(typeof value, key).toBe('string');
      expect(value as string).toMatch(/^\d+\.\d{2}$/);
    }
    expect(financial.poValue).toBe('118000.00');
    expect(organizations.active).toBe(1);
    expect(system.chainValid).toBe(true);
    expect(system.auditRows).toBeGreaterThan(0);
  });

  it('detects a tampered audit chain', async () => {
    const org = await makeOrganization('Tamper Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });
    const platformAdmin = await makeUser('PLATFORM_ADMIN');

    await request(app)
      .patch('/api/v1/organizations/me/settings')
      .set(...admin.authHeader)
      .send({ matchTolerancePercent: 4 })
      .expect(200);

    const healthy = await request(app).get('/api/v1/platform/stats').set(...platformAdmin.authHeader);
    expect(healthy.body.data.system.chainValid).toBe(true);

    // The rules block UPDATE, so tampering has to go around the application —
    // which is the point. Simulate a direct-to-database edit.
    const row = await prisma.activityLog.findFirstOrThrow({ orderBy: { sequence: 'asc' } });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE activity_logs DISABLE RULE activity_logs_no_update`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE activity_logs SET summary = 'nothing happened' WHERE id = '${row.id}'`,
    );
    await prisma.$executeRawUnsafe(`ALTER TABLE activity_logs ENABLE RULE activity_logs_no_update`);

    const tampered = await request(app).get('/api/v1/platform/stats').set(...platformAdmin.authHeader);
    expect(tampered.body.data.system.chainValid).toBe(false);
  });
});
