import type { RequestHandler } from 'express';
import type { Notification } from '@prisma/client';
import type { NotificationDto, NotificationQuery } from '@tb/shared';
import { ok, paginated } from '../../lib/response.js';
import { requireActor } from '../../middleware/authenticate.js';
import { validatedQuery } from '../../middleware/validate.js';
import * as service from './notification.service.js';

const toDto = (notification: Notification): NotificationDto => ({
  id: notification.id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  entityType: notification.entityType,
  entityId: notification.entityId,
  link: notification.link,
  readAt: notification.readAt?.toISOString() ?? null,
  emailSentAt: notification.emailSentAt?.toISOString() ?? null,
  emailError: notification.emailError,
  createdAt: notification.createdAt.toISOString(),
});

export const list: RequestHandler = async (req, res) => {
  const query = validatedQuery<NotificationQuery>(req);
  const { rows, total, page, limit } = await service.listNotifications(requireActor(req), query);
  paginated(res, rows.map(toDto), { page, limit, total });
};

/** What the bell polls every 60 seconds. One indexed count, nothing else. */
export const unreadCount: RequestHandler = async (req, res) => {
  ok(res, { unread: await service.unreadCount(requireActor(req)) });
};

export const markRead: RequestHandler = async (req, res) => {
  ok(res, toDto(await service.markRead(requireActor(req), req.params.id as string)));
};

export const markAllRead: RequestHandler = async (req, res) => {
  ok(res, { marked: await service.markAllRead(requireActor(req)) });
};

/** The current policy per event. Read-only — the service explains why. */
export const preferences: RequestHandler = async (_req, res) => {
  ok(res, service.notificationPreferences());
};
