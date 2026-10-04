import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom';
import { PERMISSIONS as P, type Permission } from '@tb/shared';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ErrorBoundary, RouteErrorBoundary } from '@/components/ErrorBoundary';
import { NotFound } from '@/components/Forbidden';
import { RequireAnonymous, RequireAuth, RequirePermission } from '@/components/RouteGuards';
import { AcceptInvitePage } from '@/features/auth/pages/AcceptInvite';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPassword';
import { LoginPage } from '@/features/auth/pages/Login';
import { RegisterPage } from '@/features/auth/pages/Register';
import { ResetPasswordPage } from '@/features/auth/pages/ResetPassword';
import { ActivityPage, EntityActivityPage, PlatformActivityPage } from '@/features/activity/pages/ActivityPage';
import { DashboardPage } from '@/features/dashboard/pages/Dashboard';
import { DispatchFormPage } from '@/features/deliveries/pages/DispatchForm';
import { ApprovalDetailPage, ApprovalListPage } from '@/features/evaluation/pages/Approvals';
import { ComparisonPage } from '@/features/evaluation/pages/Comparison';
import { GrnCapturePage } from '@/features/grns/pages/GrnCapture';
import { GrnDetailPage, GrnListPage } from '@/features/grns/pages/GrnList';
import { InvoiceBuilderPage } from '@/features/invoices/pages/InvoiceBuilder';
import { InvoiceListPage, VendorInvoiceListPage } from '@/features/invoices/pages/InvoiceList';
import { InvoiceVerificationPage } from '@/features/invoices/pages/InvoiceVerification';
import { VendorInvoiceDetailPage } from '@/features/invoices/pages/VendorInvoiceDetail';
import { NotificationsPage } from '@/features/notifications/pages/Notifications';
import { MembersPage } from '@/features/organization/pages/Members';
import { OrganizationSettingsPage } from '@/features/organization/pages/OrganizationSettings';
import { PayablePage } from '@/features/payments/pages/Payable';
import {
  PaymentDetailPage,
  PaymentRegisterPage,
  VendorPaymentsPage,
} from '@/features/payments/pages/PaymentRegister';
import { RecordPaymentPage } from '@/features/payments/pages/RecordPayment';
import {
  PlatformOrganizationDetailPage,
  PlatformOrganizationsPage,
} from '@/features/platform/pages/PlatformOrganizations';
import {
  PlatformVendorReviewPage,
  PlatformVendorsPage,
} from '@/features/platform/pages/PlatformVendors';
import {
  PurchaseOrderDetailPage,
  VendorPurchaseOrderDetailPage,
} from '@/features/purchaseOrders/pages/PoDetail';
import {
  PurchaseOrderListPage,
  VendorPurchaseOrderListPage,
} from '@/features/purchaseOrders/pages/PoList';
import { QuotationBuilderPage } from '@/features/quotations/pages/QuotationBuilder';
import { QuotationDetailPage } from '@/features/quotations/pages/QuotationDetail';
import { QuotationListPage } from '@/features/quotations/pages/QuotationList';
import { ReportsPage } from '@/features/reports/pages/Reports';
import { ProfilePage } from '@/features/settings/pages/Profile';
import { TenderCreatePage, TenderEditPage } from '@/features/tenders/pages/TenderCreate';
import { TenderDetailPage } from '@/features/tenders/pages/TenderDetail';
import { TenderListPage } from '@/features/tenders/pages/TenderList';
import {
  VendorTenderDetailPage,
  VendorTenderListPage,
} from '@/features/tenders/pages/VendorTenders';
import { VendorDetailPage } from '@/features/vendors/pages/VendorDetail';
import { VendorListPage } from '@/features/vendors/pages/VendorList';
import { VendorSettingsPage } from '@/features/vendors/pages/VendorSettings';

/**
 * All routes, nested layouts and guards. Pure configuration — the guards
 * themselves live in `components/RouteGuards.tsx`.
 *
 * The URL shapes are not arbitrary: `/vendor/...` and `/platform/...` mirror the
 * links the API already puts in its notifications and dashboard tiles, so every
 * link the server emits lands on a route that exists.
 */
const guarded = (perm: Permission | Permission[], element: ReactNode) => (
  <RequirePermission perm={perm}>{element}</RequirePermission>
);

export const router = createBrowserRouter([
  {
    element: (
      <ErrorBoundary>
        <Outlet />
      </ErrorBoundary>
    ),
    errorElement: <RouteErrorBoundary />,
    children: [
      /* --- public ------------------------------------------------------- */
      {
        path: '/login',
        element: (
          <RequireAnonymous>
            <LoginPage />
          </RequireAnonymous>
        ),
      },
      {
        path: '/register',
        element: (
          <RequireAnonymous>
            <RegisterPage />
          </RequireAnonymous>
        ),
      },
      // The plan's route map links the vendor registration directly; the page
      // opens on the right tab either way.
      {
        path: '/register/vendor',
        element: (
          <RequireAnonymous>
            <RegisterPage />
          </RequireAnonymous>
        ),
      },
      {
        path: '/forgot-password',
        element: (
          <RequireAnonymous>
            <ForgotPasswordPage />
          </RequireAnonymous>
        ),
      },
      // Both token paths match the links auth.service and invitation.service email.
      { path: '/reset-password/:token', element: <ResetPasswordPage /> },
      { path: '/accept-invite/:token', element: <AcceptInvitePage /> },

      /* --- authenticated ------------------------------------------------ */
      {
        path: '/',
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },

          {
            path: 'dashboard',
            handle: { crumb: 'Dashboard' },
            element: <DashboardPage />,
          },
          {
            path: 'notifications',
            handle: { crumb: 'Notifications' },
            element: <NotificationsPage />,
          },

          /* ----------------------------- sourcing ----------------------- */
          {
            path: 'tenders',
            handle: { crumb: 'Tenders' },
            children: [
              { index: true, element: guarded(P.TENDER_VIEW, <TenderListPage />) },
              { path: 'new', element: guarded(P.TENDER_CREATE, <TenderCreatePage />) },
              { path: ':id', element: guarded(P.TENDER_VIEW, <TenderDetailPage />) },
              { path: ':id/edit', element: guarded(P.TENDER_UPDATE, <TenderEditPage />) },
              {
                path: ':id/comparison',
                element: guarded(P.EVALUATION_RUN, <ComparisonPage />),
              },
            ],
          },

          {
            path: 'approvals',
            handle: { crumb: 'Approvals' },
            children: [
              { index: true, element: guarded(P.APPROVAL_DECIDE, <ApprovalListPage />) },
              { path: ':id', element: guarded(P.APPROVAL_DECIDE, <ApprovalDetailPage />) },
            ],
          },

          {
            path: 'vendors',
            handle: { crumb: 'Vendors' },
            children: [
              { index: true, element: guarded(P.VENDOR_VIEW, <VendorListPage />) },
              { path: ':id', element: guarded(P.VENDOR_VIEW, <VendorDetailPage />) },
            ],
          },

          /* --------------------------- procurement ---------------------- */
          {
            path: 'purchase-orders',
            handle: { crumb: 'Orders' },
            children: [
              { index: true, element: guarded(P.PO_VIEW, <PurchaseOrderListPage />) },
              { path: ':id', element: guarded(P.PO_VIEW, <PurchaseOrderDetailPage />) },
              { path: ':id/receive', element: guarded(P.GRN_CREATE, <GrnCapturePage />) },
            ],
          },

          {
            path: 'grns',
            handle: { crumb: 'Goods receipts' },
            children: [
              { index: true, element: guarded(P.GRN_CREATE, <GrnListPage />) },
              { path: ':id', element: guarded(P.GRN_CREATE, <GrnDetailPage />) },
            ],
          },

          /* ----------------------------- finance ------------------------ */
          {
            path: 'invoices',
            handle: { crumb: 'Invoices' },
            children: [
              { index: true, element: guarded(P.INVOICE_VIEW, <InvoiceListPage />) },
              { path: ':id', element: guarded(P.INVOICE_VIEW, <InvoiceVerificationPage />) },
            ],
          },

          {
            path: 'payments',
            handle: { crumb: 'Payments' },
            children: [
              { index: true, element: guarded(P.PAYMENT_VIEW, <PaymentRegisterPage />) },
              { path: 'payable', element: guarded(P.PAYMENT_VIEW, <PayablePage />) },
              { path: 'new', element: guarded(P.PAYMENT_RECORD, <RecordPaymentPage />) },
              { path: ':id', element: guarded(P.PAYMENT_VIEW, <PaymentDetailPage />) },
            ],
          },

          /* --------------------------- reporting ------------------------ */
          {
            path: 'reports',
            handle: { crumb: 'Reports' },
            element: guarded(P.REPORT_VIEW, <ReportsPage />),
          },
          {
            path: 'activity',
            handle: { crumb: 'Activity' },
            children: [
              { index: true, element: guarded(P.AUDIT_VIEW, <ActivityPage />) },
              {
                path: ':entityType/:entityId',
                element: guarded(P.AUDIT_VIEW, <EntityActivityPage />),
              },
            ],
          },

          /* ---------------------------- vendor side --------------------- */
          {
            path: 'vendor/tenders',
            handle: { crumb: 'Tenders' },
            children: [
              { index: true, element: guarded(P.TENDER_VIEW, <VendorTenderListPage />) },
              { path: ':id', element: guarded(P.TENDER_VIEW, <VendorTenderDetailPage />) },
            ],
          },

          {
            path: 'vendor/quotations',
            handle: { crumb: 'My quotations' },
            children: [
              { index: true, element: guarded(P.QUOTATION_VIEW_OWN, <QuotationListPage />) },
              { path: ':id', element: guarded(P.QUOTATION_VIEW_OWN, <QuotationDetailPage />) },
              {
                path: ':id/edit',
                element: guarded(P.QUOTATION_SUBMIT, <QuotationBuilderPage />),
              },
            ],
          },

          {
            path: 'vendor/purchase-orders',
            handle: { crumb: 'Orders' },
            children: [
              { index: true, element: guarded(P.PO_VIEW, <VendorPurchaseOrderListPage />) },
              { path: ':id', element: guarded(P.PO_VIEW, <VendorPurchaseOrderDetailPage />) },
              {
                path: ':id/dispatch',
                element: guarded(P.DELIVERY_CREATE, <DispatchFormPage />),
              },
            ],
          },

          {
            path: 'vendor/invoices',
            handle: { crumb: 'Invoices' },
            children: [
              { index: true, element: guarded(P.INVOICE_VIEW, <VendorInvoiceListPage />) },
              { path: 'new', element: guarded(P.INVOICE_SUBMIT, <InvoiceBuilderPage />) },
              { path: ':id', element: guarded(P.INVOICE_VIEW, <VendorInvoiceDetailPage />) },
            ],
          },

          {
            path: 'vendor/payments',
            handle: { crumb: 'Payments' },
            element: guarded(P.PAYMENT_VIEW, <VendorPaymentsPage />),
          },

          /* -------------------------- platform admin -------------------- */
          // `/platform` is the platform admin's landing page in the plan's route
          // map; their dashboard already IS stats plus system health.
          { path: 'platform', element: <Navigate to="/dashboard" replace /> },

          {
            path: 'platform/organizations',
            handle: { crumb: 'Organizations' },
            children: [
              { index: true, element: guarded(P.ORG_APPROVE, <PlatformOrganizationsPage />) },
              {
                path: ':id',
                element: guarded(P.ORG_APPROVE, <PlatformOrganizationDetailPage />),
              },
            ],
          },

          {
            path: 'platform/vendors',
            handle: { crumb: 'Vendors' },
            children: [
              { index: true, element: guarded(P.VENDOR_VIEW, <PlatformVendorsPage />) },
              { path: ':id', element: guarded(P.VENDOR_VIEW, <PlatformVendorReviewPage />) },
            ],
          },

          {
            path: 'platform/activity',
            handle: { crumb: 'Audit log' },
            element: guarded(P.AUDIT_VIEW, <PlatformActivityPage />),
          },

          /* ----------------------------- settings ----------------------- */
          {
            path: 'settings',
            handle: { crumb: 'Settings' },
            children: [
              { index: true, element: <Navigate to="/settings/profile" replace /> },
              { path: 'profile', element: <ProfilePage /> },
              {
                path: 'organization',
                element: guarded(P.ORG_VIEW, <OrganizationSettingsPage />),
              },
              {
                path: 'members',
                element: guarded(P.ORG_MEMBER_MANAGE, <MembersPage />),
              },
              {
                path: 'vendor',
                element: guarded(P.VENDOR_UPDATE_SELF, <VendorSettingsPage />),
              },
            ],
          },

          // 404 inside the shell, so a mistyped URL keeps the navigation. An
          // anonymous visitor hits `RequireAuth` above this and lands on /login
          // with the bad path remembered — they would need to sign in either way.
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
