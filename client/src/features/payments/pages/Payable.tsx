import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Lock, Wallet } from 'lucide-react';
import { PERMISSIONS as P } from '@tb/shared';
import { cn } from '@/lib/cn';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/data/EmptyState';
import { StatCard, StatCardGrid } from '@/components/data/StatCard';
import { StatusBadge } from '@/components/data/StatusBadge';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { usePayable } from '@/features/payments/api';

/**
 * `/payments/payable` — the worklist (plan 13).
 *
 * Approved invoices with something outstanding, oldest due first, with the TDS
 * the system suggests and the bank account it would go to. A blocked row shows
 * why rather than silently disappearing: "not payable" with no reason is how
 * people stop trusting a worklist.
 */
export function PayablePage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const payable = usePayable();

  if (!can(P.PAYMENT_VIEW)) return <Forbidden />;

  const canPay = can(P.PAYMENT_RECORD);
  const rows = payable.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Payables"
        description="Approved invoices waiting to be paid, oldest due date first."
        crumbs={[{ label: 'Payments', to: '/payments' }, { label: 'Payables' }]}
      />

      {payable.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <StatCardGrid>
          <StatCard
            label="Invoices due"
            value={formatCount(payable.data?.totals.count ?? 0)}
            tone="primary"
          />
          <StatCard
            label="Total outstanding"
            value={formatMoney(payable.data?.totals.outstanding ?? '0.00')}
            tone="neutral"
          />
          <StatCard
            label="Overdue"
            value={formatMoney(payable.data?.totals.overdue ?? '0.00')}
            tone={Number(payable.data?.totals.overdue ?? 0) > 0 ? 'danger' : 'success'}
          />
        </StatCardGrid>
      )}

      <Card className="mt-4">
        <CardHeader
          title="Worklist"
          description={
            canPay
              ? 'Recording a payment above your threshold still needs a second administrator.'
              : 'You can see what is due. Releasing money is an administrator action.'
          }
        />

        {payable.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-5" />}
            title="Nothing to pay"
            message="Invoices appear here once they are approved for payment and have a balance."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Invoice</TH>
                <TH>Vendor</TH>
                <TH>Due</TH>
                <TH numeric>Outstanding</TH>
                <TH numeric>Suggested TDS</TH>
                <TH>Match</TH>
                <TH className="text-right">Action</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.invoiceId} className={cn(row.isOverdue && 'bg-danger/5')}>
                  <TD>
                    <button
                      type="button"
                      className="text-left hover:text-primary"
                      onClick={() => navigate(`/invoices/${row.invoiceId}`)}
                    >
                      <span className="block font-mono text-xs font-medium">
                        {row.referenceNumber}
                      </span>
                      <span className="block text-xs text-muted">{row.vendorInvoiceNumber}</span>
                    </button>
                  </TD>
                  <TD>
                    <span className="block">{row.vendor.name}</span>
                    <span className="block font-mono text-xs text-muted">
                      {row.vendor.bankMasked ?? 'no bank details'}
                    </span>
                  </TD>
                  <TD>
                    <span className={cn('block', row.isOverdue && 'text-danger')}>
                      {formatDate(row.dueDate)}
                    </span>
                    <span className="block text-xs text-muted">
                      {row.daysToDue < 0 ? `${Math.abs(row.daysToDue)} days overdue` : `in ${row.daysToDue} days`}
                    </span>
                  </TD>
                  <TD numeric>{formatMoney(row.outstanding)}</TD>
                  <TD numeric>
                    {row.suggestedTds ? (
                      <Tooltip
                        content={`Section ${row.suggestedTds.section} at ${row.suggestedTds.percent}%`}
                      >
                        <span>{formatMoney(row.suggestedTds.amount)}</span>
                      </Tooltip>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TD>
                  <TD>
                    <StatusBadge status={row.matchStatus} />
                  </TD>
                  <TD className="text-right">
                    {row.blockedReason ? (
                      <Tooltip content={row.blockedReason}>
                        <span className="inline-flex items-center gap-1 text-xs text-muted">
                          <Lock aria-hidden className="size-3.5" />
                          blocked
                        </span>
                      </Tooltip>
                    ) : canPay ? (
                      <Button
                        size="sm"
                        onClick={() => navigate(`/payments/new?invoiceId=${row.invoiceId}`)}
                      >
                        Pay
                      </Button>
                    ) : (
                      <Tooltip content="Recording a payment is an administrator action.">
                        <AlertTriangle aria-hidden className="size-3.5 text-muted" />
                      </Tooltip>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
