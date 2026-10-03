import { Navigate, Outlet, createBrowserRouter } from 'react-router-dom';
import { PERMISSIONS as P, type Permission } from '@tb/shared';
import { AppShell } from '@/components/layout/AppShell';
import { ErrorBoundary, RouteErrorBoundary } from '@/components/ErrorBoundary';
import { NotFound } from '@/components/Forbidden';
import { Placeholder } from '@/components/Placeholder';
import { RequireAnonymous, RequireAuth, RequirePermission } from '@/components/RouteGuards';
import { AcceptInvitePage } from '@/features/auth/pages/AcceptInvite';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPassword';
import { LoginPage } from '@/features/auth/pages/Login';
import { RegisterPage } from '@/features/auth/pages/Register';
import { ResetPasswordPage } from '@/features/auth/pages/ResetPassword';

/**
 * All routes, nested layouts and guards. Pure configuration — the guards
 * themselves live in `components/RouteGuards.tsx`.
 *
 * `guarded(P.TENDER_VIEW, 'Tenders')` — a plan 17 screen replaces the element.
 */
const guarded = (perm: Permission | Permission[], title: string) => (
  <RequirePermission perm={perm}>
    <Placeholder title={title} />
  </RequirePermission>
);

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

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
            element: <Placeholder title="Dashboard" plan={15} />,
          },

          /* sourcing — buyer and platform */
          {
            path: 'tenders',
            handle: { crumb: 'Tenders' },
            element: guarded(P.TENDER_VIEW, 'Tenders'),
          },
          {
            path: 'vendors',
            handle: { crumb: 'Vendors' },
            element: guarded(P.VENDOR_VIEW, 'Vendors'),
          },

          /* procurement */
          {
            path: 'purchase-orders',
            handle: { crumb: 'Orders' },
            element: guarded(P.PO_VIEW, 'Purchase orders'),
          },
          {
            path: 'grns',
            handle: { crumb: 'Goods receipt' },
            element: guarded(P.GRN_CREATE, 'Goods receipt notes'),
          },

          /* finance */
          {
            path: 'invoices',
            handle: { crumb: 'Invoices' },
            element: guarded(P.INVOICE_VIEW, 'Invoices'),
          },
          {
            path: 'payments',
            handle: { crumb: 'Payments' },
            element: guarded(P.PAYMENT_VIEW, 'Payments'),
          },
          // ORG_OFFICER holds no APPROVAL_DECIDE: this route renders <Forbidden />
          // for them, in place, with the sidebar intact (04 §7).
          {
            path: 'approvals',
            handle: { crumb: 'Approvals' },
            element: guarded(P.APPROVAL_DECIDE, 'Approvals'),
          },

          /* reporting */
          {
            path: 'reports',
            handle: { crumb: 'Reports' },
            element: guarded(P.REPORT_VIEW, 'Reports'),
          },
          {
            path: 'activity',
            handle: { crumb: 'Activity' },
            element: guarded(P.AUDIT_VIEW, 'Activity log'),
          },

          /* vendor-side paths, matching the links in the API's notifications */
          {
            path: 'vendor/tenders',
            handle: { crumb: 'Tenders' },
            element: guarded(P.TENDER_VIEW, 'Open tenders'),
          },
          {
            path: 'vendor/quotations',
            handle: { crumb: 'My quotations' },
            element: guarded(P.QUOTATION_VIEW_OWN, 'My quotations'),
          },
          {
            path: 'vendor/purchase-orders',
            handle: { crumb: 'Orders' },
            element: guarded(P.PO_VIEW, 'My orders'),
          },
          {
            path: 'vendor/deliveries',
            handle: { crumb: 'Deliveries' },
            element: guarded(P.DELIVERY_CREATE, 'Deliveries'),
          },
          {
            path: 'vendor/invoices',
            handle: { crumb: 'Invoices' },
            element: guarded(P.INVOICE_VIEW, 'My invoices'),
          },
          {
            path: 'vendor/payments',
            handle: { crumb: 'Payments' },
            element: guarded(P.PAYMENT_VIEW, 'Payments received'),
          },

          /* platform admin */
          {
            path: 'platform/organizations',
            handle: { crumb: 'Organizations' },
            element: guarded(P.ORG_APPROVE, 'Organizations'),
          },
          {
            path: 'platform/activity',
            handle: { crumb: 'Audit log' },
            element: guarded(P.AUDIT_VIEW, 'Audit log'),
          },

          /* every role has a profile */
          {
            path: 'settings',
            handle: { crumb: 'Settings' },
            element: <Placeholder title="Settings" />,
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
