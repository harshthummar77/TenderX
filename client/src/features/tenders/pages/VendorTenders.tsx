import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileSignature, Gavel, ThumbsDown } from 'lucide-react';
import { PERMISSIONS as P, type TenderVendorDto } from '@tb/shared';
import { formatDateTime, formatQty, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { useCountdown } from '@/hooks/useCountdown';
import { usePagination } from '@/hooks/usePagination';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Countdown } from '@/components/Countdown';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { PageHeader } from '@/components/layout/PageHeader';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { useDeclineTender, useVendorTender, useVendorTenders } from '@/features/tenders/api';
import { useOpenDraft } from '@/features/quotations/api';

/**
 * `/vendor/tenders` — what this vendor has been invited to.
 *
 * Cards rather than a table, because this is the screen a vendor genuinely opens
 * on a phone (plan 17 §8): a 390 px viewport cannot hold a seven-column grid, and
 * the only things that matter here are what it is, when it closes, and whether
 * they have bid.
 */
export function VendorTenderListPage() {
  const navigate = useNavigate();
  const pagination = usePagination({ sort: '-createdAt' });
  const tenders = useVendorTenders(pagination.params);

  const rows = tenders.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Tenders"
        description="Opportunities you have been invited to bid on."
      />

      <FilterBar
        search={pagination.q}
        onSearchChange={pagination.setQuery}
        searchPlaceholder="Search title or reference…"
        onClear={pagination.reset}
        activeCount={pagination.getFilter('status') ? 1 : 0}
      >
        <Select
          aria-label="Status"
          className="h-9 w-44"
          placeholder="Any status"
          value={pagination.getFilter('status') ?? ''}
          options={[
            { value: 'PUBLISHED', label: 'Open for bidding' },
            { value: 'BIDDING_CLOSED', label: 'Bidding closed' },
            { value: 'AWARDED', label: 'Awarded' },
            { value: 'CANCELLED', label: 'Cancelled' },
          ]}
          onChange={(event) => pagination.setFilter('status', event.target.value || undefined)}
        />
      </FilterBar>

      {tenders.isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-40 w-full" />
          ))}
        </div>
      )}

      {!tenders.isLoading && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<Gavel className="size-5" />}
            title="No invitations yet"
            message="Buyers invite vendors by category and past performance. Keep your profile and categories up to date to be found."
          />
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((tender) => (
          <TenderCard
            key={tender.id}
            tender={tender}
            onOpen={() => navigate(`/vendor/tenders/${tender.id}`)}
          />
        ))}
      </div>

      {rows.length > 0 && (tenders.data?.meta.pages ?? 1) > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => pagination.setPage(pagination.page - 1)}
          >
            Previous
          </Button>
          <span className="font-mono text-xs tabular-nums text-muted">
            {pagination.page} / {tenders.data?.meta.pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= (tenders.data?.meta.pages ?? 1)}
            onClick={() => pagination.setPage(pagination.page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}

function TenderCard({ tender, onOpen }: { tender: TenderVendorDto; onOpen: () => void }) {
  const countdown = useCountdown(tender.bidSubmissionDeadline);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong hover:bg-subtle"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs text-muted">{tender.referenceNumber}</span>
        <StatusBadge status={tender.status} />
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm font-medium">{tender.title}</p>
      <p className="mt-1 text-xs text-muted">{tender.buyerOrganization.name}</p>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
        <Countdown deadline={tender.bidSubmissionDeadline} showIcon={!countdown.expired} />
        {tender.myQuotation ? (
          <Badge tone={tender.myQuotation.status === 'SUBMITTED' ? 'success' : 'warning'}>
            {humanize(tender.myQuotation.status)}
          </Badge>
        ) : (
          <Badge tone="neutral">not bid</Badge>
        )}
      </div>
    </button>
  );
}

/** `/vendor/tenders/:id` — the invitation, and the way into the bid. */
export function VendorTenderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('overview');
  const tender = useVendorTender(id);
  const openDraft = useOpenDraft();
  const decline = useDeclineTender(id);
  const [declining, setDeclining] = useState(false);

  const countdown = useCountdown(tender.data?.bidSubmissionDeadline);

  if (tender.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!tender.data) {
    return (
      <EmptyState
        title="Tender not available"
        message="It may have been cancelled, or your invitation withdrawn."
      />
    );
  }

  const data = tender.data;
  const open = data.status === 'PUBLISHED' && !countdown.expired;
  const existing = data.myQuotation;

  const startBid = () => {
    if (existing) {
      navigate(
        existing.status === 'DRAFT'
          ? `/vendor/quotations/${existing.id}/edit`
          : `/vendor/quotations/${existing.id}`,
      );
      return;
    }

    openDraft.mutate(data.id, {
      onSuccess: (draft) => navigate(`/vendor/quotations/${draft.id}/edit`),
      onError: (error) => toast.fromError(error),
    });
  };

  return (
    <>
      <PageHeader
        title={data.title}
        status={data.status}
        backTo="/vendor/tenders"
        crumbs={[
          { label: 'Tenders', to: '/vendor/tenders' },
          { label: data.referenceNumber ?? 'Tender' },
        ]}
        meta={
          <>
            <span className="font-mono">{data.referenceNumber}</span>
            <span>{data.buyerOrganization.name}</span>
            <span>
              {data.buyerOrganization.city}, {data.buyerOrganization.state}
            </span>
            <Countdown deadline={data.bidSubmissionDeadline} label="Closes" />
          </>
        }
        actions={
          <>
            {open && !existing && can(P.QUOTATION_SUBMIT) && (
              <Button
                variant="outline"
                leftIcon={<ThumbsDown className="size-3.5" />}
                onClick={() => setDeclining(true)}
              >
                Decline
              </Button>
            )}
            {can(P.QUOTATION_SUBMIT) && (open || existing) && (
              <Button
                leftIcon={<FileSignature className="size-3.5" />}
                loading={openDraft.isPending}
                disabled={!open && !existing}
                onClick={startBid}
              >
                {existing
                  ? existing.status === 'DRAFT'
                    ? 'Continue your bid'
                    : 'View your bid'
                  : 'Submit quotation'}
              </Button>
            )}
          </>
        }
      />

      {countdown.expired && data.status === 'PUBLISHED' && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Bidding has closed</p>
            <p className="text-xs text-muted">
              The deadline passed. Submitted bids are now with the buyer for evaluation.
            </p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="items" count={data.items.length}>
            Items
          </Tab>
          <Tab value="documents">Documents</Tab>
        </TabList>

        <TabPanel value="overview">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <Card>
              <CardHeader title="What the buyer needs" />
              <CardBody>
                <p className="text-sm whitespace-pre-wrap">{data.description}</p>

                {data.termsAndConditions && (
                  <div className="mt-5 border-t border-border pt-4">
                    <p className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">
                      Terms and conditions
                    </p>
                    <p className="text-sm whitespace-pre-wrap text-muted">
                      {data.termsAndConditions}
                    </p>
                  </div>
                )}
              </CardBody>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Key facts" />
                <CardBody>
                  <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                    <Field label="Bids close">{formatDateTime(data.bidSubmissionDeadline)}</Field>
                    <Field label="Delivery by">{formatDateTime(data.deliveryDeadline)}</Field>
                    <Field label="Delivery to">{data.deliveryLocation}</Field>
                    <Field label="Category">{data.category?.name ?? '—'}</Field>
                  </FieldGrid>
                </CardBody>
              </Card>

              {data.criteria.length > 0 && (
                <Card>
                  <CardHeader
                    title="How you will be judged"
                    description="The weights the buyer set when creating this tender."
                  />
                  <CardBody>
                    <ul className="space-y-1">
                      {data.criteria.map((criterion) => (
                        <li key={criterion.key} className="flex justify-between text-xs">
                          <span>{criterion.label}</span>
                          <span className="font-mono tabular-nums text-muted">
                            {criterion.weight}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              )}

              {data.invitationStatus && (
                <Card>
                  <CardHeader title="Your invitation" />
                  <CardBody>
                    <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                      <Field label="Invited">{formatDateTime(data.invitationStatus.invitedAt)}</Field>
                      <Field label="Responded">
                        {data.invitationStatus.respondedAt
                          ? formatDateTime(data.invitationStatus.respondedAt)
                          : 'not yet'}
                      </Field>
                    </FieldGrid>
                  </CardBody>
                </Card>
              )}
            </div>
          </div>
        </TabPanel>

        <TabPanel value="items">
          <Card>
            <CardHeader
              title="Line items"
              description="You price every line in the quotation builder."
            />
            <Table>
              <THead>
                <tr>
                  <TH>#</TH>
                  <TH>Description</TH>
                  <TH>HSN</TH>
                  <TH numeric>Quantity</TH>
                  <TH numeric>GST</TH>
                </tr>
              </THead>
              <TBody>
                {data.items.map((item) => (
                  <TR key={item.id}>
                    <TD className="font-mono text-xs text-muted">{item.srNo}</TD>
                    <TD>
                      {item.description}
                      {item.specifications && (
                        <span className="block text-xs text-muted">{item.specifications}</span>
                      )}
                    </TD>
                    <TD>
                      <span className="font-mono text-xs">{item.hsnCode ?? '—'}</span>
                    </TD>
                    <TD numeric>{formatQty(item.quantity, item.unit)}</TD>
                    <TD numeric>{item.taxRatePercent}%</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="TENDER"
            ownerId={id}
            canUpload={false}
            description="Specifications and drawings the buyer attached."
          />
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={declining}
        onClose={() => setDeclining(false)}
        title="Decline this invitation?"
        message="The buyer is told you are not bidding, and why. Declining does not affect your rating."
        confirmLabel="Decline invitation"
        requireReason
        reasonMinLength={5}
        loading={decline.isPending}
        onConfirm={(reason) =>
          decline.mutate(reason, {
            onSuccess: () => {
              toast.success('Invitation declined');
              setDeclining(false);
              navigate('/vendor/tenders');
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />
    </>
  );
}
