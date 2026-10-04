import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ban, GitCompare, Pencil, Send, Trash2, UserPlus } from 'lucide-react';
import { PERMISSIONS as P } from '@tb/shared';
import { formatCount, formatDate, formatDateTime, formatMoney, formatQty } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Countdown } from '@/components/Countdown';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/data/EmptyState';
import { StatusBadge } from '@/components/data/StatusBadge';
import { Forbidden } from '@/components/Forbidden';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { BidsPanel } from '@/features/tenders/components/BidsPanel';
import { VendorPicker } from '@/features/tenders/components/VendorPicker';
import {
  useBidSummary,
  useCancelTender,
  useCloseBidding,
  useDeleteTender,
  useInviteVendors,
  usePublishTender,
  useSuggestedVendors,
  useTender,
  useTenderInvitations,
  useTenderQuotations,
} from '@/features/tenders/api';
import { useOrgSettings } from '@/features/organization/api';

/** `/tenders/:id` — overview · items · invited vendors · bids · documents · history. */
export function TenderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('overview');

  const tender = useTender(id);
  const invitations = useTenderInvitations(id);
  const settings = useOrgSettings();

  const status = tender.data?.status;
  const bidsSealed = !tender.data?.bidOpenedAt;

  const summary = useBidSummary(id, status === 'PUBLISHED');
  const quotations = useTenderQuotations(id, !bidsSealed && can(P.QUOTATION_VIEW_ALL));

  const publish = usePublishTender();
  const cancel = useCancelTender();
  const closeBidding = useCloseBidding();
  const remove = useDeleteTender();
  const invite = useInviteVendors(id);
  const suggestions = useSuggestedVendors(id, false);

  const [confirming, setConfirming] = useState<'cancel' | 'delete' | 'close' | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  if (!can(P.TENDER_VIEW)) return <Forbidden />;

  if (tender.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-80" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!tender.data) {
    return <EmptyState title="Tender not found" message="It may have been deleted while a draft." />;
  }

  const data = tender.data;
  const isDraft = data.status === 'DRAFT';
  const minVendors = settings.data?.minVendorsPerTender ?? 3;
  const invitedIds = (invitations.data ?? []).map((row) => row.vendorId);

  return (
    <>
      <PageHeader
        title={data.title}
        status={data.status}
        backTo="/tenders"
        crumbs={[{ label: 'Tenders', to: '/tenders' }, { label: data.referenceNumber ?? 'Draft' }]}
        meta={
          <>
            <span className="font-mono">{data.referenceNumber ?? 'Not numbered until published'}</span>
            {data.category && <span>{data.category.name}</span>}
            {data.estimatedBudget && (
              <span className="font-mono tabular-nums">
                Budget {formatMoney(data.estimatedBudget)}
              </span>
            )}
            {data.status === 'PUBLISHED' && (
              <Countdown deadline={data.bidSubmissionDeadline} label="Closes" />
            )}
            <span>
              {formatCount(data.quotationCount)} of {formatCount(data.invitationCount)} invited have
              bid
            </span>
          </>
        }
        actions={
          <>
            {isDraft && can(P.TENDER_UPDATE) && (
              <ButtonLink
                to={`/tenders/${data.id}/edit`}
                variant="outline"
                leftIcon={<Pencil className="size-3.5" />}
              >
                Edit
              </ButtonLink>
            )}

            {isDraft && can(P.TENDER_UPDATE) && (
              <Button
                variant="outline"
                leftIcon={<Trash2 className="size-3.5" />}
                onClick={() => setConfirming('delete')}
              >
                Delete
              </Button>
            )}

            {isDraft && can(P.TENDER_PUBLISH) && (
              <Button
                leftIcon={<Send className="size-3.5" />}
                loading={publish.isPending}
                disabled={data.invitationCount < minVendors}
                title={
                  data.invitationCount < minVendors
                    ? `Invite at least ${minVendors} vendors first.`
                    : undefined
                }
                onClick={() =>
                  publish.mutate(data.id, {
                    onSuccess: () => toast.success('Tender published'),
                    onError: (error) => toast.fromError(error),
                  })
                }
              >
                Publish
              </Button>
            )}

            {data.status === 'PUBLISHED' && can(P.TENDER_PUBLISH) && (
              <Button variant="outline" onClick={() => setConfirming('close')}>
                Close bidding now
              </Button>
            )}

            {!bidsSealed && can(P.EVALUATION_RUN) && (
              <ButtonLink
                to={`/tenders/${data.id}/comparison`}
                leftIcon={<GitCompare className="size-3.5" />}
              >
                Compare bids
              </ButtonLink>
            )}

            {['PUBLISHED', 'BIDDING_CLOSED', 'UNDER_EVALUATION'].includes(data.status) &&
              can(P.TENDER_CANCEL) && (
                <Button
                  variant="outline"
                  leftIcon={<Ban className="size-3.5" />}
                  onClick={() => setConfirming('cancel')}
                >
                  Cancel
                </Button>
              )}
          </>
        }
      />

      {data.cancellationReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Cancelled {formatDate(data.cancelledAt)}</p>
            <p className="text-xs text-muted">{data.cancellationReason}</p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="items" count={data.items.length}>
            Items
          </Tab>
          <Tab value="vendors" count={data.invitationCount}>
            Invited vendors
          </Tab>
          {can(P.QUOTATION_VIEW_ALL) && (
            <Tab value="bids" count={data.quotationCount}>
              Bids
            </Tab>
          )}
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="overview">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <Card>
              <CardHeader title="Description" />
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
                <CardHeader title="Key dates" />
                <CardBody>
                  <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                    <Field label="Bids close">{formatDateTime(data.bidSubmissionDeadline)}</Field>
                    <Field label="Delivery by">{formatDateTime(data.deliveryDeadline)}</Field>
                    <Field label="Published">{formatDateTime(data.publishedAt)}</Field>
                    <Field label="Bids opened">{formatDateTime(data.bidOpenedAt)}</Field>
                  </FieldGrid>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Delivery and evaluation" />
                <CardBody>
                  <FieldGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
                    <Field label="Location">{data.deliveryLocation}</Field>
                    <Field label="Place of supply">
                      <span className="font-mono">{data.deliveryStateCode}</span>
                    </Field>
                    <Field label="Method">
                      {data.evaluationMethod === 'WEIGHTED_SCORE' ? 'Weighted score' : 'Lowest price'}
                    </Field>
                  </FieldGrid>

                  {data.criteria.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-border pt-3">
                      {data.criteria.map((criterion) => (
                        <li key={criterion.key} className="flex justify-between text-xs">
                          <span>{criterion.label}</span>
                          <span className="font-mono tabular-nums text-muted">
                            {criterion.weight}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Engagement" />
                <CardBody>
                  <FieldGrid className="grid-cols-3 sm:grid-cols-3 lg:grid-cols-3">
                    <Field label="Invited" numeric>
                      {formatCount(data.invitationCount)}
                    </Field>
                    <Field label="Viewed" numeric>
                      {formatCount(data.viewedCount)}
                    </Field>
                    <Field label="Bids" numeric>
                      {formatCount(data.quotationCount)}
                    </Field>
                  </FieldGrid>
                </CardBody>
              </Card>
            </div>
          </div>
        </TabPanel>

        <TabPanel value="items">
          <Card>
            <CardHeader
              title="Line items"
              description="The estimated rate is internal and is never sent to a vendor."
            />
            <Table>
              <THead>
                <tr>
                  <TH>#</TH>
                  <TH>Description</TH>
                  <TH>HSN</TH>
                  <TH numeric>Quantity</TH>
                  <TH numeric>GST</TH>
                  <TH numeric>Est. rate</TH>
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
                    <TD numeric>
                      {item.estimatedUnitPrice ? formatMoney(item.estimatedUnitPrice) : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </TabPanel>

        <TabPanel value="vendors">
          <Card>
            <CardHeader
              title="Invited vendors"
              description="Only these vendors can see the tender or bid on it."
              actions={
                can(P.TENDER_PUBLISH) &&
                ['DRAFT', 'PUBLISHED'].includes(data.status) && (
                  <Button
                    size="sm"
                    leftIcon={<UserPlus className="size-3.5" />}
                    onClick={() => {
                      setPicked(invitedIds);
                      setInviteOpen(true);
                      void suggestions.refetch();
                    }}
                  >
                    Invite vendors
                  </Button>
                )
              }
            />

            {invitations.isLoading ? (
              <CardBody>
                <Skeleton className="h-24 w-full" />
              </CardBody>
            ) : (invitations.data ?? []).length === 0 ? (
              <EmptyState
                title="No vendors invited yet"
                message={`A tender needs at least ${minVendors} invitations before it can be published.`}
                action={
                  can(P.TENDER_PUBLISH) ? (
                    <Button size="sm" onClick={() => setInviteOpen(true)}>
                      Invite vendors
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Vendor</TH>
                    <TH>Invited</TH>
                    <TH>Viewed</TH>
                    <TH>Responded</TH>
                    <TH>Status</TH>
                  </tr>
                </THead>
                <TBody>
                  {(invitations.data ?? []).map((row) => (
                    <TR key={row.id}>
                      <TD>{row.vendor.companyName}</TD>
                      <TD className="text-xs text-muted">{formatDateTime(row.invitedAt)}</TD>
                      <TD className="text-xs text-muted">
                        {row.viewedAt ? formatDateTime(row.viewedAt) : 'not yet'}
                      </TD>
                      <TD className="text-xs text-muted">
                        {row.respondedAt ? formatDateTime(row.respondedAt) : '—'}
                      </TD>
                      <TD>
                        {row.declinedReason ? (
                          <span className="text-xs text-danger" title={row.declinedReason}>
                            declined
                          </span>
                        ) : (
                          <StatusBadge status={row.vendor.status} />
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </TabPanel>

        {can(P.QUOTATION_VIEW_ALL) && (
          <TabPanel value="bids">
            <BidsPanel
              tenderId={data.id}
              summary={summary.data}
              quotations={quotations.data}
              isLoading={summary.isLoading || quotations.isLoading}
              sealed={bidsSealed}
              canCompare={can(P.EVALUATION_RUN)}
            />
          </TabPanel>
        )}

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="TENDER"
            ownerId={id}
            uploadType="TENDER_ATTACHMENT"
            description="Drawings, specifications and anything else vendors need."
          />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Tender" entityId={id} />
        </TabPanel>
      </Tabs>

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite vendors"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={invite.isPending}
              disabled={picked.filter((vendorId) => !invitedIds.includes(vendorId)).length === 0}
              onClick={() => {
                const toInvite = picked.filter((vendorId) => !invitedIds.includes(vendorId));
                invite.mutate(toInvite, {
                  onSuccess: () => {
                    toast.success(
                      `${toInvite.length} vendor${toInvite.length === 1 ? '' : 's'} invited`,
                      data.status === 'PUBLISHED' ? 'They have been notified.' : undefined,
                    );
                    setInviteOpen(false);
                  },
                  onError: (error) => toast.fromError(error),
                });
              }}
            >
              Send invitations
            </Button>
          </>
        }
      >
        <VendorPicker
          selected={picked}
          onChange={setPicked}
          suggestions={suggestions.data}
          isLoadingSuggestions={suggestions.isLoading}
          minimum={minVendors}
        />
      </Dialog>

      <ConfirmDialog
        open={confirming === 'cancel'}
        onClose={() => setConfirming(null)}
        title="Cancel this tender?"
        message="Every invited vendor is notified, and any bid already submitted is closed out. This cannot be undone."
        confirmLabel="Cancel tender"
        requireReason
        reasonMinLength={5}
        loading={cancel.isPending}
        onConfirm={(reason) =>
          cancel.mutate(
            { id: data.id, reason },
            {
              onSuccess: () => {
                toast.success('Tender cancelled');
                setConfirming(null);
              },
              onError: (error) => toast.fromError(error),
            },
          )
        }
      />

      <ConfirmDialog
        open={confirming === 'close'}
        onClose={() => setConfirming(null)}
        title="Close bidding now?"
        message="Bids are opened immediately and no further submissions are accepted — the same thing the deadline does on its own."
        confirmLabel="Close bidding"
        requireReason={false}
        destructive={false}
        loading={closeBidding.isPending}
        onConfirm={() =>
          closeBidding.mutate(data.id, {
            onSuccess: () => {
              toast.success('Bidding closed', 'Bids are now open for evaluation.');
              setConfirming(null);
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />

      <ConfirmDialog
        open={confirming === 'delete'}
        onClose={() => setConfirming(null)}
        title="Delete this draft?"
        message="A draft has no counterparties, so it is deleted outright rather than cancelled. This cannot be undone."
        confirmLabel="Delete draft"
        requireReason={false}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(data.id, {
            onSuccess: () => {
              toast.success('Draft deleted');
              navigate('/tenders');
            },
            onError: (error) => toast.fromError(error),
          })
        }
      />
    </>
  );
}
