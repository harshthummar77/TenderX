import { Router } from 'express';
import multer from 'multer';
import { documentQuerySchema, idParamSchema, MAX_UPLOAD_MB, PERMISSIONS as P } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './document.controller.js';

/**
 * Documents (plan 14 Part A).
 *
 * `memoryStorage` on purpose: the bytes go straight to object storage and are
 * never written to the instance's disk, which is wiped on every redeploy anyway.
 * The 10 MB cap here is the hard ceiling; `UPLOAD_RULES` then applies a tighter
 * per-type limit.
 *
 * Every route sits behind `authenticate`, and the per-owner access table in
 * `document.service` is what actually decides each read — the permission below
 * only answers "may this role touch documents at all".
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

export const documentRoutes = Router();

documentRoutes.post(
  '/documents',
  authenticate,
  requirePermission(P.DOCUMENT_UPLOAD),
  upload.single('file'),
  controller.upload,
);

documentRoutes.get(
  '/documents',
  authenticate,
  validate({ query: documentQuerySchema }),
  controller.list,
);

documentRoutes.get(
  '/documents/:id',
  authenticate,
  validate({ params: idParamSchema }),
  controller.detail,
);

/** 302 to a signed URL that stops working after five minutes. */
documentRoutes.get(
  '/documents/:id/download',
  authenticate,
  validate({ params: idParamSchema }),
  controller.download,
);

documentRoutes.delete(
  '/documents/:id',
  authenticate,
  requirePermission(P.DOCUMENT_UPLOAD),
  validate({ params: idParamSchema }),
  controller.remove,
);
