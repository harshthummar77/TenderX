import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as controller from './dashboard.controller.js';

/**
 * The dashboard (plan 15 §2).
 *
 * No permission guard: every authenticated role has a dashboard, and which one
 * they get is decided by their role inside the controller rather than by a
 * parameter they could change. A guard here would have to grant all four roles
 * anyway, which says nothing.
 */
export const dashboardRoutes = Router();

dashboardRoutes.get('/dashboard', authenticate, controller.dashboard);
