import { Router } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerOrganizationSchema,
  registerVendorSchema,
  resetPasswordSchema,
  updateMeSchema,
} from '@tb/shared';
import { authenticate } from '../../middleware/authenticate.js';
import {
  forgotPasswordRateLimit,
  loginRateLimit,
  registerRateLimit,
} from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './auth.controller.js';

export const authRoutes = Router();

// --- public ---------------------------------------------------------------
authRoutes.post(
  '/auth/register/organization',
  registerRateLimit,
  validate({ body: registerOrganizationSchema }),
  controller.registerOrganization,
);

authRoutes.post(
  '/auth/register/vendor',
  registerRateLimit,
  validate({ body: registerVendorSchema }),
  controller.registerVendor,
);

authRoutes.post('/auth/login', loginRateLimit, validate({ body: loginSchema }), controller.login);

/** The only route that reads the refresh cookie. */
authRoutes.post('/auth/refresh', controller.refresh);

authRoutes.post(
  '/auth/forgot-password',
  forgotPasswordRateLimit,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);

authRoutes.post(
  '/auth/reset-password',
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

// --- authenticated --------------------------------------------------------
authRoutes.post('/auth/logout', authenticate, controller.logout);
authRoutes.post('/auth/logout-all', authenticate, controller.logoutAll);
authRoutes.get('/auth/me', authenticate, controller.me);
authRoutes.patch('/auth/me', authenticate, validate({ body: updateMeSchema }), controller.updateMe);
authRoutes.post(
  '/auth/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
