import { z } from 'zod';
import { TENDER_STATUSES } from '../enums.js';
import { uuidSchema } from './common.js';

/**
 * Reports and dashboards (plan 15).
 *
 * **One response contract for all four reports**, so the frontend needs a single
 * `ReportTable` component and one CSV exporter rather than four of each. The
 * column list travels with the data, which is what lets the table render a
 * report it has never seen.
 */

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .or(z.string().datetime({ offset: true }));

export const SPEND_GROUP_BY = ['category', 'vendor', 'month'] as const;
export type SpendGroupBy = (typeof SPEND_GROUP_BY)[number];

/** Shared by every report: a window, and an output format. */
export const reportQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

export const spendReportQuerySchema = reportQuerySchema.extend({
  groupBy: z.enum(SPEND_GROUP_BY).default('category'),
});

export const tenderReportQuerySchema = reportQuerySchema.extend({
  status: z.enum(TENDER_STATUSES).optional(),
});

export const vendorPerformanceQuerySchema = reportQuerySchema.extend({
  vendorId: uuidSchema.optional(),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type SpendReportQuery = z.infer<typeof spendReportQuerySchema>;
export type TenderReportQuery = z.infer<typeof tenderReportQuerySchema>;
export type VendorPerformanceQuery = z.infer<typeof vendorPerformanceQuerySchema>;

/* -------------------------------------------------------------------------- */
/* The shared report contract                                                 */
/* -------------------------------------------------------------------------- */

/** `money` and `percent` tell the renderer how to align and format a column. */
export type ReportColumnType = 'string' | 'number' | 'money' | 'percent' | 'date';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportResponse {
  report: string;
  params: Record<string, string | undefined>;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Column totals, where a total means anything. Keyed by column. */
  totals: ReportRow;
  meta: { generatedAt: string; rowCount: number };
}

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One action tile.
 *
 * **Every number is a link.** A tile without one is decoration, so `link` is
 * required rather than optional — the type is the reminder.
 */
export interface ActionTile {
  key: string;
  label: string;
  count: number;
  /** Present when the tile represents money as well as a count. */
  amount?: string;
  link: string;
  severity?: 'high' | 'normal';
}

export interface SpendTrendPoint {
  month: string;
  committed: string;
  invoiced: string;
  paid: string;
}

export interface TopVendorRow {
  vendorId: string;
  name: string;
  poValue: string;
  orders: number;
  rating: string | null;
}

export interface CategorySplitRow {
  category: string;
  value: string;
  /** Percentage of total committed spend. */
  share: number;
}

export interface ClosingSoonRow {
  tenderId: string;
  reference: string | null;
  title: string;
  deadline: string;
  bidCount: number;
}

export interface BuyerDashboard {
  role: 'ORG_ADMIN' | 'ORG_OFFICER';
  actionRequired: ActionTile[];
  kpis: {
    activeTenders: number;
    openPoValue: string;
    invoicedThisMonth: string;
    paidThisMonth: string;
    /** Days from tender publish to award, averaged. Null without an award yet. */
    avgCycleDays: number | null;
    onTimeDeliveryRate: number | null;
  };
  spendTrend: SpendTrendPoint[];
  topVendors: TopVendorRow[];
  byCategory: CategorySplitRow[];
  closingSoon: ClosingSoonRow[];
  recentActivity: {
    id: string;
    action: string;
    summary: string;
    severity: string;
    createdAt: string;
  }[];
}

export interface VendorDashboard {
  role: 'VENDOR';
  actionRequired: ActionTile[];
  kpis: {
    winRate: number | null;
    activeOrders: number;
    outstandingReceivable: string;
    paidThisYear: string;
    rating: string | null;
    onTimeDeliveryRate: number | null;
  };
  receivableAgeing: { bucket: string; amount: string }[];
  bidHistory: { month: string; submitted: number; won: number }[];
}

export interface PlatformDashboard {
  role: 'PLATFORM_ADMIN';
  actionRequired: ActionTile[];
  stats: unknown;
  health: {
    unsentNotifications: number;
    failedEmails24h: number;
    auditChainValid: boolean;
    auditRows: number;
    dbResponseMs: number;
  };
}

export type DashboardResponse = BuyerDashboard | VendorDashboard | PlatformDashboard;
