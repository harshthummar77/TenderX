import { Router } from 'express';
import { idParamSchema, notificationQuerySchema, submitQuotationSchema } from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './notification.controller.js';

/**
 * Notifications (plan 14 §B4).
 *
 * No permission guards here, deliberately: a notification belongs to exactly one
 * user, and every query in the service is filtered by `userId = actor.userId`.
 * There is no cross-user read to protect, and a permission check would imply
 * there was one.
 *
 * `unread-count` and `read-all` are registered before `/notifications/:id/read`
 * so neither is ever parsed as an id.
 */
export const notificationRoutes = Router();

notificationRoutes.get(
  '/notifications',
  authenticate,
  validate({ query: notificationQuerySchema }),
  controller.list,
);

notificationRoutes.get('/notifications/unread-count', authenticate, controller.unreadCount);

notificationRoutes.post(
  '/notifications/read-all',
  authenticate,
  validate({ body: submitQuotationSchema }),
  controller.markAllRead,
);

notificationRoutes.post(
  '/notifications/:id/read',
  authenticate,
  validate({ params: idParamSchema, body: submitQuotationSchema }),
  controller.markRead,
);

notificationRoutes.get('/me/notification-preferences', authenticate, controller.preferences);
