import type { Request, RequestHandler, Response } from 'express';
import { Unauthorized } from '../../lib/errors.js';
import { created, ok } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { toMeDto } from './auth.serializers.js';
import * as service from './auth.service.js';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  revokeToken,
  rotateRefresh,
  setRefreshCookie,
} from './token.service.js';

/** Request context recorded on refresh tokens and audit rows. */
const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const refreshCookie = (req: Request): string | undefined => req.cookies?.[REFRESH_COOKIE];

export const registerOrganization: RequestHandler = async (req, res) => {
  const { session, refreshToken } = await service.registerOrganization(req.body, ctxOf(req));
  setRefreshCookie(res, refreshToken);
  created(res, session);
};

export const registerVendor: RequestHandler = async (req, res) => {
  const { session, refreshToken } = await service.registerVendor(req.body, ctxOf(req));
  setRefreshCookie(res, refreshToken);
  created(res, session);
};

export const login: RequestHandler = async (req, res) => {
  const { session, refreshToken } = await service.login(req.body, ctxOf(req));
  setRefreshCookie(res, refreshToken);
  ok(res, session);
};

export const refresh: RequestHandler = async (req, res) => {
  const token = refreshCookie(req);
  if (!token) throw Unauthorized('Session expired, sign in again');

  const rotated = await rotateRefresh(token, ctxOf(req));
  const { session, refreshToken } = await service.sessionForUser(rotated.user.id, rotated.refreshToken);
  setRefreshCookie(res, refreshToken);
  ok(res, session);
};

export const logout: RequestHandler = async (req, res) => {
  const token = refreshCookie(req);
  if (token) await revokeToken(token);
  clearRefreshCookie(res);
  ok(res, { loggedOut: true });
};

export const logoutAll: RequestHandler = async (req, res) => {
  const result = await service.logoutAll(requireActor(req).userId, ctxOf(req));
  clearRefreshCookie(res);
  ok(res, result);
};

export const me: RequestHandler = async (req, res) => {
  ok(res, toMeDto(await service.getMe(requireActor(req).userId)));
};

export const updateMe: RequestHandler = async (req, res) => {
  ok(res, toMeDto(await service.updateMe(requireActor(req).userId, req.body)));
};

export const changePassword: RequestHandler = async (req, res) => {
  const result = await service.changePassword(
    requireActor(req).userId,
    req.body,
    refreshCookie(req),
    ctxOf(req),
  );
  ok(res, result);
};

/** Always the same answer, whether or not the email is registered. */
export const forgotPassword: RequestHandler = async (req, res) => {
  await service.forgotPassword(req.body.email);
  ok(res, { message: 'If that email is registered, a reset link is on its way.' });
};

export const resetPassword: RequestHandler = async (req, res: Response) => {
  await service.resetPassword(req.body, ctxOf(req));
  clearRefreshCookie(res);
  ok(res, { message: 'Password updated. Sign in with your new password.' });
};
