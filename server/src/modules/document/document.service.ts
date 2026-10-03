import type { Document, Prisma } from '@prisma/client';
import type { DocumentOwnerType, DocumentQuery, DocumentType, UploadDocumentInput } from '@tb/shared';
import { SENSITIVE_DOCUMENT_TYPES, UPLOAD_RULES } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { AppError, BadRequest, BusinessRule, NotFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import {
  buildStorageKey,
  SIGNED_URL_TTL_SECONDS,
  storage,
} from '../../lib/storage.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { isSealed } from '../quotation/sealing.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

/* -------------------------------------------------------------------------- */
/* Content sniffing (plan 14 §A2)                                             */
/* -------------------------------------------------------------------------- */

/**
 * **Magic-byte sniffing is the important step.** A file named `invoice.pdf` with
 * a `Content-Type` of `application/pdf` can contain HTML with a script tag; the
 * client's declared type is a hint, not evidence. The first bytes are the
 * evidence.
 */
const SIGNATURES: { mime: string; test: (buffer: Buffer) => boolean }[] = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    // XLSX is a zip. This cannot distinguish it from any other zip, which is
    // why the extension and the declared type still have to agree with it.
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  },
];

/** Detect what the bytes actually are, or null when nothing recognises them. */
export function sniffMime(buffer: Buffer): string | null {
  for (const signature of SIGNATURES) {
    if (buffer.length >= 12 && signature.test(buffer)) return signature.mime;
  }
  return null;
}

/**
 * **SVG is never accepted anywhere.** It is executable XML: an `<svg>` with an
 * `onload` handler served inline is stored cross-site scripting. It appears in
 * no `UPLOAD_RULES` entry, and this catches a file that claims to be a PNG.
 */
export function looksLikeSvgOrMarkup(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 1024).toString('latin1').toLowerCase().trimStart();
  return (
    head.includes('<svg') ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml')
  );
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Everything the bytes must satisfy before they are stored. */
export function assertUploadAllowed(file: UploadedFile, type: DocumentType): string {
  const rule = UPLOAD_RULES[type];
  // An unlisted type is rejected outright rather than defaulted.
  if (!rule) {
    throw BusinessRule('document.type_not_allowed', `Uploads are not accepted for ${type}`);
  }

  if (file.size > rule.maxMb * 1024 * 1024) {
    throw BusinessRule(
      'document.too_large',
      `A ${type} may be at most ${rule.maxMb} MB; this file is ${(file.size / 1024 / 1024).toFixed(1)} MB`,
    );
  }

  if (looksLikeSvgOrMarkup(file.buffer)) {
    throw BusinessRule(
      'document.content_mismatch',
      'SVG and markup files are never accepted — they can carry executable script',
    );
  }

  const actual = sniffMime(file.buffer);
  if (!actual) {
    throw BusinessRule(
      'document.content_mismatch',
      'The file content is not a recognised PDF, image or spreadsheet',
    );
  }

  if (!rule.mime.includes(actual)) {
    throw BusinessRule(
      'document.type_not_allowed',
      `A ${type} must be one of ${rule.mime.join(', ')}; this file is ${actual}`,
    );
  }

  // The declared type has to agree with the bytes, or the name is a lie.
  if (file.mimetype && file.mimetype !== actual) {
    throw BusinessRule(
      'document.content_mismatch',
      `The file is declared as ${file.mimetype} but its content is ${actual}`,
    );
  }

  return actual;
}

/* -------------------------------------------------------------------------- */
/* Access control (plan 14 §A3)                                               */
/* -------------------------------------------------------------------------- */

const forbidden = (message: string) => new AppError(403, 'document.forbidden', message);

/**
 * May this actor read this document?
 *
 * The owner type decides, and the `QUOTATION` row is the one that is easy to
 * forget and a genuine leak: **a vendor can name their attachment
 * `bid-689000.pdf`**, so the buyer must not reach it before `bidOpenedAt`. The
 * sealing rule from plan 08 applies to attachments exactly as it applies to
 * amounts.
 */
export async function assertCanRead(actor: Actor, document: Document): Promise<void> {
  if (actor.isPlatformAdmin) return;

  const ownerType = document.ownerType as DocumentOwnerType;

  switch (ownerType) {
    case 'ORGANIZATION': {
      if (actor.organizationId === document.ownerId) return;
      throw forbidden('This document belongs to another organization');
    }

    case 'VENDOR': {
      if (actor.vendorId === document.ownerId) return;

      /*
       * A buyer may see a vendor's documents only once there is a commercial
       * relationship — an order or an invoice. Approving a vendor is not enough:
       * any org could otherwise read every vendor's bank details.
       */
      if (actor.organizationId) {
        const related = await prisma.purchaseOrder.count({
          where: { organizationId: actor.organizationId, vendorId: document.ownerId },
        });
        if (related > 0) return;
      }
      throw forbidden('You have no commercial relationship with this vendor');
    }

    case 'TENDER': {
      const tender = await prisma.tender.findUnique({ where: { id: document.ownerId } });
      if (!tender) throw NotFound('Document');

      if (actor.organizationId === tender.organizationId) return;

      // An invited vendor, but only once the tender is actually published.
      if (actor.vendorId && tender.publishedAt) {
        const invited = await prisma.tenderInvitation.count({
          where: { tenderId: tender.id, vendorId: actor.vendorId },
        });
        if (invited > 0) return;
      }
      throw forbidden('You were not invited to this tender');
    }

    case 'QUOTATION': {
      const quotation = await prisma.quotation.findUnique({
        where: { id: document.ownerId },
        include: { tender: true },
      });
      if (!quotation) throw NotFound('Document');

      // The owning vendor always sees their own attachment.
      if (actor.vendorId === quotation.vendorId) return;

      if (actor.organizationId === quotation.tender.organizationId) {
        if (isSealed(quotation.tender)) {
          throw forbidden(
            'Bid attachments stay sealed until bidding closes',
          );
        }
        return;
      }
      throw forbidden('This bid is not yours');
    }

    case 'PURCHASE_ORDER':
    case 'DELIVERY':
    case 'GRN': {
      const po = await resolvePurchaseOrder(ownerType, document.ownerId);
      if (!po) throw NotFound('Document');
      if (actor.organizationId === po.organizationId || actor.vendorId === po.vendorId) return;
      throw forbidden('This document belongs to another party');
    }

    case 'INVOICE': {
      const invoice = await prisma.invoice.findUnique({ where: { id: document.ownerId } });
      if (!invoice) throw NotFound('Document');
      if (actor.organizationId === invoice.organizationId || actor.vendorId === invoice.vendorId) {
        return;
      }
      throw forbidden('This document belongs to another party');
    }

    case 'PAYMENT': {
      const payment = await prisma.payment.findUnique({ where: { id: document.ownerId } });
      if (!payment) throw NotFound('Document');
      if (actor.organizationId === payment.organizationId || actor.vendorId === payment.vendorId) {
        return;
      }
      throw forbidden('This document belongs to another party');
    }

    default:
      throw forbidden('Unknown document owner');
  }
}

async function resolvePurchaseOrder(ownerType: DocumentOwnerType, ownerId: string) {
  if (ownerType === 'PURCHASE_ORDER') {
    return prisma.purchaseOrder.findUnique({ where: { id: ownerId } });
  }
  if (ownerType === 'DELIVERY') {
    const delivery = await prisma.delivery.findUnique({
      where: { id: ownerId },
      include: { purchaseOrder: true },
    });
    return delivery?.purchaseOrder ?? null;
  }
  const grn = await prisma.grn.findUnique({
    where: { id: ownerId },
    include: { purchaseOrder: true },
  });
  return grn?.purchaseOrder ?? null;
}

/** The owner must exist, and the actor must already be able to see it. */
async function assertOwnerVisible(actor: Actor, input: UploadDocumentInput): Promise<void> {
  await assertCanRead(actor, {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  } as Document);
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

/** Which party columns to stamp, so the row is scopeable without a join. */
function partyColumnsFor(actor: Actor, input: UploadDocumentInput) {
  if (input.ownerType === 'ORGANIZATION') {
    return { organizationId: input.ownerId, vendorId: null };
  }
  if (input.ownerType === 'VENDOR') {
    return { organizationId: actor.organizationId ?? null, vendorId: input.ownerId };
  }
  return {
    organizationId: actor.organizationId ?? null,
    vendorId: actor.vendorId ?? null,
  };
}

export async function uploadDocument(
  actor: Actor,
  file: UploadedFile,
  input: UploadDocumentInput,
  ctx: RefreshContext,
) {
  if (!file?.buffer?.length) throw BadRequest('document.empty', 'No file was uploaded');

  const mimeType = assertUploadAllowed(file, input.type);
  await assertOwnerVisible(actor, input);

  const party = partyColumnsFor(actor, input);

  /*
   * The row is created first so its id can go in the storage key, then the bytes
   * are uploaded, then the row is completed. A failed upload therefore leaves a
   * row with no storageKey rather than an orphaned object nobody can find.
   */
  const placeholder = await prisma.document.create({
    data: {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      organizationId: party.organizationId,
      vendorId: party.vendorId,
      type: input.type,
      fileName: file.originalname,
      mimeType,
      sizeBytes: file.size,
      storageKey: '',
      uploadedById: actor.userId,
    },
  });

  const storageKey = buildStorageKey({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    documentId: placeholder.id,
    fileName: file.originalname,
  });

  let stored;
  try {
    stored = await storage.upload({ buffer: file.buffer, storageKey, mimeType });
  } catch (err) {
    // Do not leave a half-made row behind; it has no bytes and never will.
    await prisma.document.delete({ where: { id: placeholder.id } });
    throw err;
  }

  const document = await prisma.$transaction(async (tx) => {
    const row = await tx.document.update({
      where: { id: placeholder.id },
      data: {
        storageKey: stored.storageKey,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
      },
    });

    await writeAudit(tx, {
      action: 'document.uploaded',
      entityType: 'Document',
      entityId: row.id,
      summary: `${actor.email} uploaded ${input.type} "${file.originalname}" for ${input.ownerType} ${input.ownerId}`,
      organizationId: party.organizationId,
      vendorId: party.vendorId,
      actor: auditActorOf(actor, ctx),
      after: {
        type: input.type,
        fileName: file.originalname,
        mimeType,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
      },
    });

    return row;
  });

  return document;
}

/* -------------------------------------------------------------------------- */
/* Read, list, delete                                                         */
/* -------------------------------------------------------------------------- */

export async function loadDocument(actor: Actor, id: string): Promise<Document> {
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) throw NotFound('Document');
  await assertCanRead(actor, document);
  return document;
}

export async function listDocuments(actor: Actor, query: DocumentQuery) {
  const where: Prisma.DocumentWhereInput = {
    ...(query.ownerType ? { ownerType: query.ownerType } : {}),
    ...(query.ownerId ? { ownerId: query.ownerId } : {}),
    ...(query.type ? { type: query.type } : {}),
    // Cheap pre-filter; `assertCanRead` is still the authority per row.
    ...(actor.isPlatformAdmin
      ? {}
      : {
          OR: [
            ...(actor.organizationId ? [{ organizationId: actor.organizationId }] : []),
            ...(actor.vendorId ? [{ vendorId: actor.vendorId }] : []),
            ...(actor.vendorId ? [{ ownerType: 'VENDOR', ownerId: actor.vendorId }] : []),
          ],
        }),
  };

  const rows = await prisma.document.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (query.page - 1) * query.limit,
    take: query.limit,
  });

  // Filtered per row, because the owner rules cannot all be expressed as SQL.
  const visible: Document[] = [];
  for (const row of rows) {
    try {
      await assertCanRead(actor, row);
      visible.push(row);
    } catch {
      // Not visible to this actor; silently omitted rather than 403-ing a list.
    }
  }

  const total = await prisma.document.count({ where });
  return { rows: visible, total, page: query.page, limit: query.limit };
}

/**
 * A short-lived signed URL, issued only after the permission check above.
 *
 * Downloads of sensitive types are audited: who read a cancelled cheque, and
 * when, is worth keeping (§C2).
 */
export async function getDownloadUrl(actor: Actor, id: string, ctx: RefreshContext) {
  const document = await loadDocument(actor, id);
  const url = await storage.signedUrl(document.storageKey, SIGNED_URL_TTL_SECONDS);

  if ((SENSITIVE_DOCUMENT_TYPES as string[]).includes(document.type)) {
    await prisma.$transaction(async (tx) => {
      await writeAudit(tx, {
        action: 'document.downloaded',
        entityType: 'Document',
        entityId: document.id,
        severity: 'INFO',
        summary: `${actor.email} downloaded ${document.type} "${document.fileName}"`,
        organizationId: document.organizationId,
        vendorId: document.vendorId,
        actor: auditActorOf(actor, ctx),
        after: { type: document.type, fileName: document.fileName },
      });
    });
  }

  return { document, url, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}

/** Uploader only, within 24 hours, and only while nothing references it. */
export const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function canDelete(actor: Actor, document: Document): Promise<boolean> {
  if (document.uploadedById !== actor.userId) return false;
  if (Date.now() - document.createdAt.getTime() > DELETE_WINDOW_MS) return false;
  return true;
}

export async function deleteDocument(actor: Actor, id: string, ctx: RefreshContext) {
  const document = await loadDocument(actor, id);

  if (document.uploadedById !== actor.userId) {
    throw forbidden('Only the person who uploaded a document may delete it');
  }
  if (Date.now() - document.createdAt.getTime() > DELETE_WINDOW_MS) {
    throw BusinessRule(
      'document.delete_window_closed',
      'A document can only be deleted within 24 hours of upload',
    );
  }

  /*
   * A generated PO or invoice PDF is part of a document trail somebody may have
   * already been sent. Deleting it would break the record it belongs to.
   */
  if (document.type === 'PO_PDF' || document.type === 'INVOICE_PDF') {
    throw BusinessRule(
      'document.referenced',
      'Generated documents are part of the record and cannot be deleted',
    );
  }

  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: 'document.deleted',
      entityType: 'Document',
      entityId: document.id,
      severity: 'NOTABLE',
      summary: `${actor.email} deleted ${document.type} "${document.fileName}"`,
      organizationId: document.organizationId,
      vendorId: document.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { type: document.type, fileName: document.fileName },
    });
    await tx.document.delete({ where: { id: document.id } });
  });

  // After the row is gone: an orphaned object is cheaper than a dangling row.
  await storage.remove(document.storageKey).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Generated documents (plan 14 §A4)                                          */
/* -------------------------------------------------------------------------- */

export interface GeneratedDocMeta {
  ownerType: DocumentOwnerType;
  ownerId: string;
  type: DocumentType;
  fileName: string;
  organizationId: string | null;
  vendorId: string | null;
  uploadedById: string;
}

/**
 * Store an already-rendered PDF buffer as a `Document`.
 *
 * Generated documents go through the same row and the same permission path as
 * uploads, so they are versioned and downloadable without a second code path.
 * Plans 10, 12 and 13 render on demand today; this is the seam that lets them
 * persist a copy instead.
 */
export async function storeGeneratedPdf(buffer: Buffer, meta: GeneratedDocMeta, actor: AuditActor) {
  const placeholder = await prisma.document.create({
    data: {
      ownerType: meta.ownerType,
      ownerId: meta.ownerId,
      organizationId: meta.organizationId,
      vendorId: meta.vendorId,
      type: meta.type,
      fileName: meta.fileName,
      mimeType: 'application/pdf',
      sizeBytes: buffer.byteLength,
      storageKey: '',
      uploadedById: meta.uploadedById,
    },
  });

  const stored = await storage.upload({
    buffer,
    storageKey: buildStorageKey({
      ownerType: meta.ownerType,
      ownerId: meta.ownerId,
      documentId: placeholder.id,
      fileName: meta.fileName,
    }),
    mimeType: 'application/pdf',
  });

  return prisma.$transaction(async (tx) => {
    const row = await tx.document.update({
      where: { id: placeholder.id },
      data: {
        storageKey: stored.storageKey,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
      },
    });

    await writeAudit(tx, {
      action: 'document.generated',
      entityType: 'Document',
      entityId: row.id,
      severity: 'INFO',
      summary: `${meta.type} "${meta.fileName}" generated for ${meta.ownerType} ${meta.ownerId}`,
      organizationId: meta.organizationId,
      vendorId: meta.vendorId,
      actor,
      after: { type: meta.type, fileName: meta.fileName, sizeBytes: stored.sizeBytes },
    });

    return row;
  });
}
