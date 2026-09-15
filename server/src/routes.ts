import { Router } from 'express';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { categoryRoutes } from './modules/category/category.routes.js';
import { invitationRoutes } from './modules/invitation/invitation.routes.js';
import { organizationRoutes } from './modules/organization/organization.routes.js';
import { platformRoutes } from './modules/platform/platform.routes.js';
import { vendorRoutes } from './modules/vendor/vendor.routes.js';

/**
 * Every feature route mounts here, and this router mounts at /api/v1.
 * Later plans add: tenders (07),
 * quotations (08), purchase-orders (10), deliveries (11), grns (11),
 * invoices (12), payments (13), documents + notifications + audit (14),
 * reports (15).
 */
export const router = Router();

router.use(healthRoutes);
router.use(authRoutes);
router.use(invitationRoutes);
router.use(organizationRoutes);
router.use(platformRoutes);
router.use(vendorRoutes);
router.use(categoryRoutes);
