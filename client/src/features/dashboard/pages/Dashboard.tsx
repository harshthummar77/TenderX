import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Building2,
  ClipboardCheck,
  Database,
  FileWarning,
  Gavel,
  Receipt,
  ShieldCheck,
  Store,
  Wallet,
} from 'lucide-react';
import type {
  ActionTile,
  BuyerDashboard,
  PlatformDashboard,
  PlatformStats,
  VendorDashboard,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import {
  formatCount,
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatRelative,
} from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Countdown } from '@/components/Countdown';
import { EmptyState } from '@/components/data/EmptyState';
import { StatCard, StatCardGrid } from '@/components/data/StatCard';
import { PageHeader } from '@/components/layout/PageHeader';
import { useDashboard } from '@/features/dashboard/api';

/**
 * `/dashboard` — dispatches on the role in the payload (plan 15).
 *
 * **Every number is a link.** A tile that cannot be clicked through to the rows
 * behind it is decoration: the whole point is "six invoices in exception" taking
 * you to those six invoices, with the filter already applied.
 */
export function DashboardPage() {
  const { role, user, partyName } = useAuth();
  const dashboard = useDashboard(role);

  if (dashboard.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      </>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <EmptyState
            icon={<AlertTriangle className="size-5 text-danger" />}
            title="The dashboard could not be loaded"
            message="Everything else still works — try again in a moment."
          />
        </Card>
      </>
    );
  }

  const data = dashboard.data;
  const greeting = user?.fullName?.split(' ')[0] ?? 'there';

  return (
    <>
      <PageHeader
        title={`Hello, ${greeting}`}
        description={partyName ? `${partyName} · what needs you today` : 'What needs you today'}
      />

      {data.role === 'VENDOR' ? (
        <VendorView data={data} />
      ) : data.role === 'PLATFORM_ADMIN' ? (
        <PlatformView data={data} />
      ) : (
        <BuyerView data={data} />
      )}
    </>
  );
}

/** The action tiles: count, optional amount, and a link that is never optional. */
function ActionTiles({ tiles }: { tiles: ActionTile[] }) {
  if (tiles.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<ClipboardCheck className="size-5 text-success" />}
          title="Nothing needs you right now"
          message="Approvals, exceptions and overdue items appear here when they arise."
        />
      </Card>
    );
  }

  return (
    <StatCardGrid>
      {tiles.map((tile) => (
        <StatCard
          key={tile.key}
          label={tile.label}
          value={tile.amount ? formatMoneyCompact(tile.amount) : formatCount(tile.count)}
          tone={tile.severity === 'high' ? 'danger' : 'primary'}
          to={tile.link}
          // The count is the headline when there is no amount; when there is one,
          // the count still matters, so it rides along underneath.
          delta={
            tile.amount
              ? { value: formatCount(tile.count), direction: 'flat', label: 'items' }
              : null
          }
        />
      ))}
    </StatCardGrid>
  );
}

function BuyerView({ data }: { data: BuyerDashboard }) {
  const maxTrend = Math.max(
    1,
    ...data.spendTrend.map((point) => Number(point.committed) || 0),
  );

  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Action required
        </h2>
        <ActionTiles tiles={data.actionRequired} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">This month</h2>
        <StatCardGrid>
          <StatCard
            label="Active tenders"
            value={formatCount(data.kpis.activeTenders)}
            icon={<Gavel className="size-4" />}
            to="/tenders?status=PUBLISHED"
          />
          <StatCard
            label="Open order value"
            value={formatMoneyCompact(data.kpis.openPoValue)}
            icon={<Receipt className="size-4" />}
            to="/purchase-orders?status=ACCEPTED"
          />
          <StatCard
            label="Invoiced"
            value={formatMoneyCompact(data.kpis.invoicedThisMonth)}
            icon={<Receipt className="size-4" />}
            to="/invoices"
          />
          <StatCard
            label="Paid"
            value={formatMoneyCompact(data.kpis.paidThisMonth)}
            icon={<Wallet className="size-4" />}
            to="/payments"
          />
        </StatCardGrid>

        <div className="mt-3 flex flex-wrap gap-6 text-xs text-muted">
          <span>
            Average tender-to-award:{' '}
            <span className="font-mono tabular-nums text-text">
              {data.kpis.avgCycleDays === null ? 'no data' : `${data.kpis.avgCycleDays} days`}
            </span>
          </span>
          <span>
            On-time delivery:{' '}
            <span className="font-mono tabular-nums text-text">
              {data.kpis.onTimeDeliveryRate === null
                ? 'no data'
                : formatPercent(data.kpis.onTimeDeliveryRate, 0)}
            </span>
          </span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Spend trend" description="Committed, invoiced and paid by month." />
          <CardBody>
            {data.spendTrend.length === 0 ? (
              <p className="text-xs text-muted">No spend recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.spendTrend.map((point) => (
                  <li key={point.month}>
                    <div className="flex justify-between text-xs">
                      <span>{point.month}</span>
                      <span className="font-mono tabular-nums text-muted">
                        {formatMoneyCompact(point.committed)}
                      </span>
                    </div>
                    {/* Three thin bars rather than a chart library: this is a
                        comparison of three numbers, not a visualisation. */}
                    <div className="mt-1 space-y-0.5">
                      {(
                        [
                          { key: 'committed', value: point.committed, tone: 'bg-primary' },
                          { key: 'invoiced', value: point.invoiced, tone: 'bg-info' },
                          { key: 'paid', value: point.paid, tone: 'bg-success' },
                        ] as const
                      ).map((bar) => (
                        <div key={bar.key} className="h-1 overflow-hidden rounded-full bg-border">
                          <div
                            className={cn('h-full rounded-full', bar.tone)}
                            style={{
                              width: `${Math.min(100, (Number(bar.value) / maxTrend) * 100)}%`,
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Closing soon" description="Tenders whose bidding window is nearly up." />
          {data.closingSoon.length === 0 ? (
            <EmptyState title="Nothing closing soon" message="No live tender closes in the next few days." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Tender</TH>
                  <TH numeric>Bids</TH>
                  <TH>Closes</TH>
                </tr>
              </THead>
              <TBody>
                {data.closingSoon.map((tender) => (
                  <TR key={tender.tenderId}>
                    <TD>
                      <Link
                        to={`/tenders/${tender.tenderId}`}
                        className="hover:text-primary hover:underline"
                      >
                        <span className="block truncate">{tender.title}</span>
                        <span className="block font-mono text-xs text-muted">
                          {tender.reference}
                        </span>
                      </Link>
                    </TD>
                    <TD numeric>{formatCount(tender.bidCount)}</TD>
                    <TD>
                      <Countdown deadline={tender.deadline} showIcon={false} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Top vendors" description="By committed order value." />
          {data.topVendors.length === 0 ? (
            <EmptyState title="No orders yet" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Vendor</TH>
                  <TH numeric>Orders</TH>
                  <TH numeric>Value</TH>
                  <TH numeric>Rating</TH>
                </tr>
              </THead>
              <TBody>
                {data.topVendors.map((vendor) => (
                  <TR key={vendor.vendorId}>
                    <TD>
                      <Link
                        to={`/vendors/${vendor.vendorId}`}
                        className="hover:text-primary hover:underline"
                      >
                        {vendor.name}
                      </Link>
                    </TD>
                    <TD numeric>{formatCount(vendor.orders)}</TD>
                    <TD numeric>{formatMoney(vendor.poValue)}</TD>
                    <TD numeric>{vendor.rating ?? 'no data'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          <CardBody>
            {data.recentActivity.length === 0 ? (
              <p className="text-xs text-muted">Nothing has happened yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.recentActivity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2 text-xs">
                    <Activity aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="block">{entry.summary}</span>
                      <span className="block text-muted">{formatRelative(entry.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {data.byCategory.length > 0 && (
        <Card>
          <CardHeader title="Spend by category" />
          <CardBody>
            <ul className="space-y-2">
              {data.byCategory.map((row) => (
                <li key={row.category}>
                  <div className="flex justify-between text-xs">
                    <span>{row.category}</span>
                    <span className="font-mono tabular-nums text-muted">
                      {formatMoney(row.value)} · {formatPercent(row.share, 0)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, row.share)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function VendorView({ data }: { data: VendorDashboard }) {
  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Action required
        </h2>
        <ActionTiles tiles={data.actionRequired} />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Your business
        </h2>
        <StatCardGrid>
          <StatCard
            label="Win rate"
            value={data.kpis.winRate === null ? 'no data' : formatPercent(data.kpis.winRate, 0)}
            icon={<Gavel className="size-4" />}
            to="/vendor/quotations"
          />
          <StatCard
            label="Active orders"
            value={formatCount(data.kpis.activeOrders)}
            icon={<Receipt className="size-4" />}
            to="/vendor/purchase-orders?status=ACCEPTED"
          />
          <StatCard
            label="Outstanding receivable"
            value={formatMoneyCompact(data.kpis.outstandingReceivable)}
            icon={<Wallet className="size-4" />}
            tone="warning"
            to="/vendor/invoices"
          />
          <StatCard
            label="Paid this year"
            value={formatMoneyCompact(data.kpis.paidThisYear)}
            icon={<Wallet className="size-4" />}
            tone="success"
            to="/vendor/payments"
          />
        </StatCardGrid>

        <div className="mt-3 flex flex-wrap gap-6 text-xs text-muted">
          <span>
            Rating:{' '}
            <span className="font-mono tabular-nums text-text">
              {data.kpis.rating ?? 'no data'}
            </span>
          </span>
          <span>
            On-time delivery:{' '}
            <span className="font-mono tabular-nums text-text">
              {data.kpis.onTimeDeliveryRate === null
                ? 'no data'
                : formatPercent(data.kpis.onTimeDeliveryRate, 0)}
            </span>
          </span>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Receivable ageing" description="What is owed to you, by age." />
          <CardBody>
            {data.receivableAgeing.length === 0 ? (
              <p className="text-xs text-muted">Nothing outstanding.</p>
            ) : (
              <ul className="space-y-2">
                {data.receivableAgeing.map((bucket) => (
                  <li key={bucket.bucket} className="flex justify-between text-sm">
                    <span className="text-muted">{bucket.bucket}</span>
                    <span className="numeric">{formatMoney(bucket.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Bid history" description="Submitted against won, by month." />
          <CardBody>
            {data.bidHistory.length === 0 ? (
              <p className="text-xs text-muted">No bids yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.bidHistory.map((month) => (
                  <li key={month.month} className="flex items-center justify-between gap-3 text-xs">
                    <span className="w-16 shrink-0">{month.month}</span>
                    <span className="flex-1">
                      <span className="flex h-1.5 overflow-hidden rounded-full bg-border">
                        <span
                          className="h-full bg-success"
                          style={{
                            width: `${month.submitted === 0 ? 0 : (month.won / month.submitted) * 100}%`,
                          }}
                        />
                      </span>
                    </span>
                    <span className="w-20 shrink-0 text-right font-mono tabular-nums text-muted">
                      {month.won} / {month.submitted}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function PlatformView({ data }: { data: PlatformDashboard }) {
  const stats = data.stats as PlatformStats | undefined;

  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Action required
        </h2>
        <ActionTiles tiles={data.actionRequired} />
      </section>

      {stats && (
        <section>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Platform</h2>
          <StatCardGrid>
            <StatCard
              label="Organizations"
              value={formatCount(stats.organizations.total)}
              icon={<Building2 className="size-4" />}
              delta={{
                value: formatCount(stats.organizations.pendingApproval),
                direction: 'flat',
                label: 'pending',
              }}
              to="/platform/organizations"
            />
            <StatCard
              label="Vendors"
              value={formatCount(stats.vendors.total)}
              icon={<Store className="size-4" />}
              delta={{
                value: formatCount(stats.vendors.pendingApproval),
                direction: 'flat',
                label: 'pending',
              }}
              to="/platform/vendors"
            />
            <StatCard
              label="Tenders"
              value={formatCount(stats.tenders.total)}
              icon={<Gavel className="size-4" />}
              delta={{ value: formatCount(stats.tenders.live), direction: 'flat', label: 'live' }}
              to="/tenders"
            />
            <StatCard
              label="Order value"
              value={formatMoneyCompact(stats.financial.poValue)}
              icon={<Receipt className="size-4" />}
            />
          </StatCardGrid>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="System health" />
          <CardBody>
            <FieldGrid className="grid-cols-2 sm:grid-cols-2">
              <Field label="Audit chain" >
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5',
                    data.health.auditChainValid ? 'text-success' : 'text-danger',
                  )}
                >
                  <ShieldCheck aria-hidden className="size-4" />
                  {data.health.auditChainValid ? 'verified' : 'BROKEN'}
                </span>
              </Field>
              <Field label="Audit rows" numeric>
                {formatCount(data.health.auditRows)}
              </Field>
              <Field label="Unsent notifications" numeric>
                {formatCount(data.health.unsentNotifications)}
              </Field>
              <Field label="Failed emails (24h)" numeric>
                {formatCount(data.health.failedEmails24h)}
              </Field>
              <Field label="Database response" numeric>
                {data.health.dbResponseMs} ms
              </Field>
            </FieldGrid>

            <div className="mt-4 flex gap-2 border-t border-border pt-3">
              <ButtonLink
                to="/platform/activity"
                variant="outline"
                size="sm"
                leftIcon={<Database className="size-3.5" />}
              >
                Audit log
              </ButtonLink>
              {!data.health.auditChainValid && (
                <ButtonLink
                  to="/platform/activity?verify=1"
                  variant="danger"
                  size="sm"
                  leftIcon={<FileWarning className="size-3.5" />}
                >
                  Verify chain
                </ButtonLink>
              )}
            </div>
          </CardBody>
        </Card>

        {stats && (
          <Card>
            <CardHeader title="Money across the platform" />
            <CardBody>
              <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                <Field label="Committed on purchase orders" numeric>
                  {formatMoney(stats.financial.poValue)}
                </Field>
                <Field label="Invoiced" numeric>
                  {formatMoney(stats.financial.invoiced)}
                </Field>
                <Field label="Paid" numeric>
                  {formatMoney(stats.financial.paid)}
                </Field>
                <Field label="Users" numeric>
                  {formatCount(stats.users.total)}
                </Field>
                <Field label="Active in the last 7 days" numeric>
                  {formatCount(stats.users.activeLast7Days)}
                </Field>
              </FieldGrid>
              <p className="mt-3 text-xs text-muted">As of {formatDate(new Date())}.</p>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
