import {
  Building2,
  ClipboardCheck,
  ClipboardList,
  FileSignature,
  FileText,
  Gavel,
  LayoutDashboard,
  PackageCheck,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Store,
  Truck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { PERMISSIONS as P, Role, type Permission } from '@tb/shared';

/**
 * The sidebar, per role.
 *
 * **A vendor's sidebar is a different, shorter list — not a greyed-out copy of
 * the buyer's** (plan 16 §7). Showing a vendor eleven disabled items tells them
 * about an application they are not using; showing them six real ones tells them
 * what their job here is.
 *
 * The URL prefixes mirror the links the API already puts in notifications and
 * dashboard tiles (`/vendor/...`, `/platform/...`), so a notification always
 * lands on a route that exists.
 */

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Omitted for items every role may open (dashboard, own settings). */
  permission?: Permission;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

const DASHBOARD: NavItem = { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard };
const SETTINGS: NavItem = { label: 'Settings', to: '/settings', icon: Settings };

const BUYER: NavSection[] = [
  {
    items: [
      DASHBOARD,
      { label: 'Tenders', to: '/tenders', icon: Gavel, permission: P.TENDER_VIEW },
      { label: 'Vendors', to: '/vendors', icon: Store, permission: P.VENDOR_VIEW },
    ],
  },
  {
    label: 'Procurement',
    items: [
      { label: 'Orders', to: '/purchase-orders', icon: ClipboardList, permission: P.PO_VIEW },
      { label: 'Goods receipt', to: '/grns', icon: PackageCheck, permission: P.GRN_CREATE },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Invoices', to: '/invoices', icon: Receipt, permission: P.INVOICE_VIEW },
      { label: 'Payments', to: '/payments', icon: Wallet, permission: P.PAYMENT_VIEW },
      // ORG_OFFICER holds no APPROVAL_DECIDE, so this item simply is not there
      // for them — separation of duties, visible in the navigation (04 §7).
      { label: 'Approvals', to: '/approvals', icon: ClipboardCheck, permission: P.APPROVAL_DECIDE },
    ],
  },
  {
    items: [
      { label: 'Reports', to: '/reports', icon: FileText, permission: P.REPORT_VIEW },
      { label: 'Activity', to: '/activity', icon: ScrollText, permission: P.AUDIT_VIEW },
      SETTINGS,
    ],
  },
];

const VENDOR: NavSection[] = [
  {
    items: [
      DASHBOARD,
      { label: 'Tenders', to: '/vendor/tenders', icon: Gavel, permission: P.TENDER_VIEW },
      {
        label: 'My quotations',
        to: '/vendor/quotations',
        icon: FileSignature,
        permission: P.QUOTATION_VIEW_OWN,
      },
    ],
  },
  {
    label: 'Fulfilment',
    items: [
      {
        label: 'Orders',
        to: '/vendor/purchase-orders',
        icon: ClipboardList,
        permission: P.PO_VIEW,
      },
      { label: 'Deliveries', to: '/vendor/deliveries', icon: Truck, permission: P.DELIVERY_CREATE },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Invoices', to: '/vendor/invoices', icon: Receipt, permission: P.INVOICE_VIEW },
      { label: 'Payments', to: '/vendor/payments', icon: Wallet, permission: P.PAYMENT_VIEW },
    ],
  },
  { items: [SETTINGS] },
];

const PLATFORM: NavSection[] = [
  {
    items: [
      DASHBOARD,
      {
        label: 'Organizations',
        to: '/platform/organizations',
        icon: Building2,
        permission: P.ORG_APPROVE,
      },
      { label: 'Vendors', to: '/vendors', icon: Store, permission: P.VENDOR_VIEW },
      { label: 'Tenders', to: '/tenders', icon: Gavel, permission: P.TENDER_VIEW },
    ],
  },
  {
    items: [
      { label: 'Reports', to: '/reports', icon: FileText, permission: P.REPORT_VIEW },
      {
        label: 'Audit log',
        to: '/platform/activity',
        icon: ShieldCheck,
        permission: P.AUDIT_VIEW,
      },
      SETTINGS,
    ],
  },
];

const SECTIONS_BY_ROLE: Record<Role, NavSection[]> = {
  PLATFORM_ADMIN: PLATFORM,
  ORG_ADMIN: BUYER,
  ORG_OFFICER: BUYER,
  VENDOR: VENDOR,
};

/**
 * The role picks the list; `can` then removes what that role cannot open, so a
 * sidebar never offers a link that renders `<Forbidden />`.
 */
export function navFor(
  role: Role | null,
  can: (permission: Permission) => boolean,
): NavSection[] {
  if (!role) return [];

  return SECTIONS_BY_ROLE[role]
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.permission || can(item.permission)),
    }))
    .filter((section) => section.items.length > 0);
}

/** Where "TenderBridge" in the topbar points, per role. */
export const homePathFor = (role: Role | null) => (role ? '/dashboard' : '/login');

export { Role };
