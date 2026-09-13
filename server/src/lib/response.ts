import type { Response } from 'express';
import type { PageMeta } from '@tb/shared';

/**
 * The success half of the envelope (00 §6). The failure half is produced in
 * exactly one place: middleware/errorHandler.ts.
 */

export const ok = <T>(res: Response, data: T, meta?: PageMeta) =>
  res.json({ success: true, data, ...(meta && { meta }) });

export const created = <T>(res: Response, data: T) =>
  res.status(201).json({ success: true, data });

export const noContent = (res: Response) => res.status(204).end();

export const paginated = <T>(
  res: Response,
  rows: T[],
  { page, limit, total }: { page: number; limit: number; total: number },
) =>
  res.json({
    success: true,
    data: rows,
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  });
