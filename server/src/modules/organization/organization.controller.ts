import type { Request, RequestHandler } from 'express';
import { created, noContent, ok } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import * as memberService from './member.service.js';
import * as service from './organization.service.js';
import { toMemberDto, toOrgDto } from './organization.serializers.js';

const ctxOf = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export const getOrg: RequestHandler = async (req, res) => {
  const { org, ...meta } = await service.getOwnOrg(requireActor(req));
  ok(res, toOrgDto(org, meta));
};

export const updateOrg: RequestHandler = async (req, res) => {
  const { org, ...meta } = await service.updateOwnOrg(requireActor(req), req.body);
  ok(res, toOrgDto(org, meta));
};

export const getSettings: RequestHandler = async (req, res) => {
  ok(res, await service.getOwnSettings(requireActor(req)));
};

export const updateSettings: RequestHandler = async (req, res) => {
  ok(res, await service.updateOwnSettings(requireActor(req), req.body));
};

export const listMembers: RequestHandler = async (req, res) => {
  const members = await memberService.listMembers(requireActor(req));
  ok(res, members.map(toMemberDto));
};

export const inviteMember: RequestHandler = async (req, res) => {
  const invitation = await memberService.inviteMember(requireActor(req), req.body, ctxOf(req));
  created(res, {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  });
};

export const updateMember: RequestHandler = async (req, res) => {
  const member = await memberService.updateMember(
    requireActor(req),
    req.params.userId as string,
    req.body,
    ctxOf(req),
  );
  ok(res, toMemberDto(member));
};

export const suspendMember: RequestHandler = async (req, res) => {
  await memberService.suspendMember(requireActor(req), req.params.userId as string, ctxOf(req));
  noContent(res);
};
