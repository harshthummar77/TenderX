import { Router } from 'express';
import { approvalRoutes } from './modules/approval/approval.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { deliveryRoutes } from './modules/delivery/delivery.routes.js';
import { evaluationRoutes } from './modules/evaluation/evaluation.routes.js';
import { grnRoutes } from './modules/grn/grn.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { categoryRoutes } from './modules/category/category.routes.js';
import { invitationRoutes } from './modules/invitation/invitation.routes.js';
import { organizationRoutes } from './modules/organization/organization.routes.js';
import { platformRoutes } from './modules/platform/platform.routes.js';
import { poRoutes } from './modules/purchase-order/po.routes.js';
import { poVendorRoutes } from './modules/purchase-order/po.vendor.routes.js';
import { installAwardHook } from './modules/purchase-order/po.service.js';
import { quotationBuyerRoutes } from './modules/quotation/quotation.buyer.routes.js';
import { quotationRoutes } from './modules/quotation/quotation.routes.js';
import { tenderRoutes } from './modules/tender/tender.routes.js';
import { vendorRoutes } from './modules/vendor/vendor.routes.js';

/**
 * Every feature route mounts here, and this router mounts at /api/v1.
 * Later plans add:
 * invoices (12), payments (13), documents + notifications + audit (14),
 * reports (15).
 */
/**
 * Plan 10 fills plan 09's award seam: approving an award generates the purchase
 * order inside the same transaction. Registered here, once, where the module
 * graph is assembled — not as an import side effect inside po.service itself.
 */
installAwardHook();

export const router = Router();

router.use(healthRoutes);
router.use(authRoutes);
router.use(invitationRoutes);
router.use(organizationRoutes);
router.use(platformRoutes);
router.use(vendorRoutes);
router.use(categoryRoutes);
router.use(tenderRoutes);
router.use(quotationRoutes);
router.use(quotationBuyerRoutes);
router.use(evaluationRoutes);
router.use(approvalRoutes);
router.use(poRoutes);
router.use(poVendorRoutes);
router.use(grnRoutes);
router.use(deliveryRoutes);
