import type { Request, RequestHandler } from 'express';
import { created, noContent, ok } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { setRefreshCookie } from '../auth/token.service.js';
import * as service from './invitation.service.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export const create: RequestHandler = async (req, res) => {
  const invitation = await service.createInvitation(requireActor(req), req.body, ctxOf(req));
  created(res, { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt });
};

export const list: RequestHandler = async (req, res) => {
  ok(res, await service.listInvitations(requireActor(req)));
};

export const preview: RequestHandler = async (req, res) => {
  ok(res, await service.previewInvitation(req.params.token as string));
};

export const accept: RequestHandler = async (req, res) => {
  const { session, refreshToken } = await service.acceptInvitation(
    req.params.token as string,
    req.body,
    ctxOf(req),
  );
  setRefreshCookie(res, refreshToken);
  created(res, session);
};

export const revoke: RequestHandler = async (req, res) => {
  await service.revokeInvitation(requireActor(req), req.params.id as string, ctxOf(req));
  noContent(res);
};
