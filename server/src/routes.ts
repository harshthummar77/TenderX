import { Router } from 'express';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { invitationRoutes } from './modules/invitation/invitation.routes.js';

/**
 * Every feature route mounts here, and this router mounts at /api/v1.
 * Later plans add: organizations (05), vendors (06), tenders (07),
 * quotations (08), purchase-orders (10), deliveries (11), grns (11),
 * invoices (12), payments (13), documents + notifications + audit (14),
 * reports (15).
 */
export const router = Router();

router.use(healthRoutes);
router.use(authRoutes);
router.use(invitationRoutes);
