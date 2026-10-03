import type { Request, RequestHandler } from 'express';
import type { DocumentDto, DocumentQuery, UploadDocumentInput } from '@tb/shared';
import { uploadDocumentSchema } from '@tb/shared';
import type { Document } from '@prisma/client';
import { BadRequest } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { created, noContent, ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import * as service from './document.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const namesFor = async (documents: Document[]): Promise<Map<string, string>> => {
  const ids = [...new Set(documents.map((doc) => doc.uploadedById))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
};

const toDto = (
  document: Document,
  names: Map<string, string>,
  canDelete: boolean,
): DocumentDto => ({
  id: document.id,
  ownerType: document.ownerType,
  ownerId: document.ownerId,
  type: document.type,
  fileName: document.fileName,
  mimeType: document.mimeType,
  sizeBytes: document.sizeBytes,
  checksum: document.checksum,
  uploadedById: document.uploadedById,
  uploadedByName: names.get(document.uploadedById) ?? null,
  canDelete,
  createdAt: document.createdAt.toISOString(),
});

/**
 * The multipart fields arrive as strings alongside the file, so they are parsed
 * here rather than by `validate` — that middleware runs before multer has
 * populated `req.body`.
 */
export const upload: RequestHandler = async (req, res) => {
  const file = (req as Request & { file?: service.UploadedFile }).file;
  if (!file) throw BadRequest('document.no_file', 'Attach a file in the `file` field');

  const input: UploadDocumentInput = uploadDocumentSchema.parse(req.body);
  const actor = requireActor(req);

  const document = await service.uploadDocument(actor, file, input, ctxOf(req));
  const names = await namesFor([document]);

  created(res, toDto(document, names, await service.canDelete(actor, document)));
};

export const list: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  const query = validatedQuery<DocumentQuery>(req);
  const { rows, total, page, limit } = await service.listDocuments(actor, query);
  const names = await namesFor(rows);

  const data = await Promise.all(
    rows.map(async (row) => toDto(row, names, await service.canDelete(actor, row))),
  );
  paginated(res, data, { page, limit, total });
};

export const detail: RequestHandler = async (req, res) => {
  const actor = requireActor(req);
  const document = await service.loadDocument(actor, req.params.id as string);
  const names = await namesFor([document]);
  ok(res, toDto(document, names, await service.canDelete(actor, document)));
};

/**
 * A 302 to a short-lived signed URL. The permission check happens here, before
 * the URL exists at all — uploads are stored `authenticated`, so the Cloudinary
 * address is not guessable and this is the only way in.
 */
export const download: RequestHandler = async (req, res) => {
  const { url } = await service.getDownloadUrl(
    requireActor(req),
    req.params.id as string,
    ctxOf(req),
  );
  res.redirect(302, url);
};

export const remove: RequestHandler = async (req, res) => {
  await service.deleteDocument(requireActor(req), req.params.id as string, ctxOf(req));
  noContent(res);
};
