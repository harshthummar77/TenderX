import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_TYPES, UPLOAD_RULES } from '@tb/shared';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { storage } from '../src/lib/storage.js';
import { clearOrgCache } from '../src/middleware/requireActiveOrg.js';
import { clearVendorCache } from '../src/middleware/requireApprovedVendor.js';
import { looksLikeSvgOrMarkup, sniffMime } from '../src/modules/document/document.service.js';
import { makeOrganization, makeUser, makeVendor } from './helpers/actors.js';
import { bidFixture, closeBidding, placeBid, publishTender } from './helpers/bidding.js';
import { disconnect, truncateAll } from './helpers/db.js';

/**
 * Document upload and download (plan 14 Part A).
 *
 * The suite runs entirely against the in-memory storage adapter, which is
 * selected automatically under test — **no network, no Cloudinary credentials**.
 * A test suite that silently uploads to a real bucket is one nobody can run on a
 * train.
 */
vi.setConfig({ testTimeout: 120_000 });

/** A minimal but genuinely well-formed PDF, so the sniffer accepts it. */
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj<</Type/Catalog>>endobj\n'),
  Buffer.from('trailer<</Root 1 0 R>>\n%%EOF\n'),
]);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);

/** HTML with a script tag, which is what a malicious "PDF" actually contains. */
const HTML = Buffer.from(
  '<!DOCTYPE html><html><body><script>fetch("/steal")</script></body></html>\n'.padEnd(200, ' '),
);

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>'.padEnd(200, ' '),
);

const upload = (
  auth: [string, string],
  body: Record<string, string>,
  file: { buffer: Buffer; name: string; mime: string },
) =>
  request(app)
    .post('/api/v1/documents')
    .set(...auth)
    .field(body)
    .attach('file', file.buffer, { filename: file.name, contentType: file.mime });

beforeEach(async () => {
  await truncateAll();
  clearOrgCache();
  clearVendorCache();
});

afterAll(async () => {
  await disconnect();
});

/* -------------------------------------------------------------------------- */
/* Sniffing — pure                                                            */
/* -------------------------------------------------------------------------- */

describe('content sniffing', () => {
  it('recognises the formats it accepts', () => {
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
  });

  it('recognises nothing in HTML dressed as a document', () => {
    expect(sniffMime(HTML)).toBeNull();
  });

  it('spots SVG and markup regardless of what they are named', () => {
    expect(looksLikeSvgOrMarkup(SVG)).toBe(true);
    expect(looksLikeSvgOrMarkup(HTML)).toBe(true);
    expect(looksLikeSvgOrMarkup(PDF)).toBe(false);
    expect(looksLikeSvgOrMarkup(PNG)).toBe(false);
  });

  /** SVG must appear in no rule, for any type. */
  it('never allows SVG for any document type', () => {
    for (const type of DOCUMENT_TYPES) {
      expect(UPLOAD_RULES[type].mime, type).not.toContain('image/svg+xml');
    }
  });

  it('has a rule for every document type, so none is implicitly allowed', () => {
    for (const type of DOCUMENT_TYPES) {
      expect(UPLOAD_RULES[type], type).toBeDefined();
      expect(UPLOAD_RULES[type].mime.length, type).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

describe('upload', () => {
  it('stores a PDF with a checksum and a scoped storage key', async () => {
    const org = await makeOrganization('Upload Test Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await upload(
      admin.authHeader,
      { type: 'ORG_GST_CERTIFICATE', ownerType: 'ORGANIZATION', ownerId: org.id },
      { buffer: PDF, name: 'gst.pdf', mime: 'application/pdf' },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.mimeType).toBe('application/pdf');
    expect(res.body.data.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.data.canDelete).toBe(true);

    const row = await prisma.document.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.storageKey).toContain(org.id);
    expect(row.storageKey).toContain('gst');
    // The bytes really are in the adapter.
    expect(storage.read?.(row.storageKey)?.equals(PDF)).toBe(true);

    const audit = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'document.uploaded', entityId: row.id },
    });
    expect(audit.summary).toContain('gst.pdf');
  });

  /** Plan 14 acceptance — `payload.html` renamed to `.pdf`. */
  it('rejects HTML renamed as a PDF', async () => {
    const org = await makeOrganization('Sniff Test Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await upload(
      admin.authHeader,
      { type: 'ORG_GST_CERTIFICATE', ownerType: 'ORGANIZATION', ownerId: org.id },
      { buffer: HTML, name: 'payload.pdf', mime: 'application/pdf' },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('document.content_mismatch');
    expect(await prisma.document.count()).toBe(0);
  });

  /** Plan 14 acceptance — an SVG is rejected for every type. */
  it('rejects an SVG however it is labelled', async () => {
    const org = await makeOrganization('SVG Test Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    for (const [type, name, mime] of [
      ['ORG_LOGO', 'logo.svg', 'image/svg+xml'],
      ['ORG_LOGO', 'logo.png', 'image/png'],
      ['TENDER_ATTACHMENT', 'spec.pdf', 'application/pdf'],
    ] as const) {
      const res = await upload(
        admin.authHeader,
        { type, ownerType: 'ORGANIZATION', ownerId: org.id },
        { buffer: SVG, name, mime },
      );
      expect(res.status, `${type}/${name}`).toBe(422);
      expect(res.body.error.code).toBe('document.content_mismatch');
    }
  });

  it('rejects a real PNG for a PDF-only type', async () => {
    const org = await makeOrganization('Mime Rule Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await upload(
      admin.authHeader,
      { type: 'INVOICE_PDF', ownerType: 'ORGANIZATION', ownerId: org.id },
      { buffer: PNG, name: 'scan.png', mime: 'image/png' },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('document.type_not_allowed');
  });

  it('rejects a declared type that disagrees with the bytes', async () => {
    const org = await makeOrganization('Declared Mime Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await upload(
      admin.authHeader,
      { type: 'ORG_GST_CERTIFICATE', ownerType: 'ORGANIZATION', ownerId: org.id },
      { buffer: PDF, name: 'gst.png', mime: 'image/png' },
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('document.content_mismatch');
  });

  it('refuses to attach a document to another organization', async () => {
    const org = await makeOrganization('Owner Ltd');
    const rival = await makeOrganization('Rival Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await upload(
      admin.authHeader,
      { type: 'ORG_GST_CERTIFICATE', ownerType: 'ORGANIZATION', ownerId: rival.id },
      { buffer: PDF, name: 'gst.pdf', mime: 'application/pdf' },
    );

    expect(res.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Download and access rules (plan 14 §A3)                                    */
/* -------------------------------------------------------------------------- */

describe('download', () => {
  async function vendorDocument() {
    const vendor = await makeVendor('Acme Networks');
    const contact = await makeUser('VENDOR', { vendorId: vendor.id });

    const res = await upload(
      contact.authHeader,
      { type: 'VENDOR_GST_CERTIFICATE', ownerType: 'VENDOR', ownerId: vendor.id },
      { buffer: PDF, name: 'vendor-gst.pdf', mime: 'application/pdf' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { vendor, contact, documentId: res.body.data.id as string };
  }

  it('redirects the owner to a signed URL that carries an expiry', async () => {
    const { contact, documentId } = await vendorDocument();

    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...contact.authHeader)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/expires=\d+/);

    // Five minutes, not an hour: the link is a handoff, not a share.
    const expires = Number(res.headers.location.match(/expires=(\d+)/)![1]);
    const seconds = expires - Math.floor(Date.now() / 1000);
    expect(seconds).toBeGreaterThan(240);
    expect(seconds).toBeLessThanOrEqual(300);
  });

  /** Plan 14 acceptance — a vendor cannot read another vendor's GST certificate. */
  it("refuses another vendor's certificate", async () => {
    const { documentId } = await vendorDocument();
    const other = await makeVendor('Northwind Systems');
    const otherContact = await makeUser('VENDOR', { vendorId: other.id });

    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...otherContact.authHeader)
      .redirects(0);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('document.forbidden');
  });

  /** A buyer needs a commercial relationship, not merely an account. */
  it("refuses a buyer with no orders against that vendor", async () => {
    const { documentId } = await vendorDocument();
    const org = await makeOrganization('Unrelated Buyer Ltd');
    const admin = await makeUser('ORG_ADMIN', { organizationId: org.id });

    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...admin.authHeader)
      .redirects(0);

    expect(res.status).toBe(403);
  });

  it('audits the download of a sensitive type', async () => {
    const { contact, documentId } = await vendorDocument();

    await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...contact.authHeader)
      .redirects(0)
      .expect(302);

    const audit = await prisma.activityLog.count({
      where: { action: 'document.downloaded', entityId: documentId },
    });
    expect(audit).toBe(1);
  });

  /**
   * Plan 14 acceptance, and the row that is easy to forget: **a vendor can name
   * their attachment `bid-689000.pdf`**, so the sealing rule from plan 08 has to
   * cover attachments too.
   */
  it('keeps a bid attachment sealed from the buyer until bidding closes', async () => {
    const f = await bidFixture(3);
    const tender = await publishTender(f);
    const bid = await placeBid(f, tender.id, 0, { prices: ['58500.00', '8200.00'] });

    const uploaded = await upload(
      f.vendors[0]!.contact.authHeader,
      { type: 'QUOTATION_ATTACHMENT', ownerType: 'QUOTATION', ownerId: bid.id },
      { buffer: PDF, name: 'bid-689000.pdf', mime: 'application/pdf' },
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const documentId = uploaded.body.data.id;

    // Sealed: the buyer is refused, and the refusal names no amount.
    const sealed = await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...f.officer.authHeader)
      .redirects(0);
    expect(sealed.status).toBe(403);
    expect(JSON.stringify(sealed.body)).not.toContain('689000');

    // The owning vendor can always reach their own attachment.
    await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...f.vendors[0]!.contact.authHeader)
      .redirects(0)
      .expect(302);

    // Opening the bids opens the attachment with them.
    await closeBidding(f, tender.id).expect(200);

    await request(app)
      .get(`/api/v1/documents/${documentId}/download`)
      .set(...f.officer.authHeader)
      .redirects(0)
      .expect(302);
  });

  it('hides an undownloadable document from the list rather than failing it', async () => {
    const { documentId } = await vendorDocument();
    const other = await makeVendor('Orion Traders');
    const otherContact = await makeUser('VENDOR', { vendorId: other.id });

    const res = await request(app)
      .get('/api/v1/documents')
      .set(...otherContact.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.map((row: { id: string }) => row.id)).not.toContain(documentId);
  });
});

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

describe('delete', () => {
  it('lets the uploader remove their own document inside the window', async () => {
    const vendor = await makeVendor('Delete Test Supplies');
    const contact = await makeUser('VENDOR', { vendorId: vendor.id });

    const uploaded = await upload(
      contact.authHeader,
      { type: 'VENDOR_CERTIFICATE', ownerType: 'VENDOR', ownerId: vendor.id },
      { buffer: PDF, name: 'iso.pdf', mime: 'application/pdf' },
    );
    const id = uploaded.body.data.id;

    await request(app)
      .delete(`/api/v1/documents/${id}`)
      .set(...contact.authHeader)
      .expect(204);

    expect(await prisma.document.count({ where: { id } })).toBe(0);
    const audit = await prisma.activityLog.count({
      where: { action: 'document.deleted', entityId: id },
    });
    expect(audit).toBe(1);
  });

  it('refuses after the 24-hour window', async () => {
    const vendor = await makeVendor('Stale Delete Supplies');
    const contact = await makeUser('VENDOR', { vendorId: vendor.id });

    const uploaded = await upload(
      contact.authHeader,
      { type: 'VENDOR_CERTIFICATE', ownerType: 'VENDOR', ownerId: vendor.id },
      { buffer: PDF, name: 'iso.pdf', mime: 'application/pdf' },
    );
    const id = uploaded.body.data.id;

    await prisma.document.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const res = await request(app)
      .delete(`/api/v1/documents/${id}`)
      .set(...contact.authHeader);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('document.delete_window_closed');
  });

  it('refuses somebody who did not upload it', async () => {
    const vendor = await makeVendor('Shared Account Supplies');
    const uploader = await makeUser('VENDOR', { vendorId: vendor.id });
    const colleague = await makeUser('VENDOR', { vendorId: vendor.id });

    const uploaded = await upload(
      uploader.authHeader,
      { type: 'VENDOR_CERTIFICATE', ownerType: 'VENDOR', ownerId: vendor.id },
      { buffer: PDF, name: 'iso.pdf', mime: 'application/pdf' },
    );

    const res = await request(app)
      .delete(`/api/v1/documents/${uploaded.body.data.id}`)
      .set(...colleague.authHeader);

    expect(res.status).toBe(403);
  });
});
