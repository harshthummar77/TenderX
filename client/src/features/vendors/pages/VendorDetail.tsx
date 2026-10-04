import { useNavigate, useParams } from 'react-router-dom';
import { Star } from 'lucide-react';
import { PERMISSIONS as P } from '@tb/shared';
import { formatCount, formatDate, formatPercent } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { usePagination } from '@/hooks/usePagination';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/data/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { DocumentsTab } from '@/features/documents/components/DocumentsTab';
import { poColumns } from '@/features/purchaseOrders/components/poColumns';
import { usePurchaseOrders } from '@/features/purchaseOrders/api';
import { Scorecard } from '@/features/vendors/components/Scorecard';
import { useVendor, useVendorScorecard } from '@/features/vendors/api';

/** `/vendors/:id` — profile · orders · performance · documents · history. */
export function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('profile');

  const vendor = useVendor(id);
  const scorecard = useVendorScorecard(tab === 'performance' ? id : undefined);
  const pagination = usePagination();
  const orders = usePurchaseOrders('buyer', { ...pagination.params, vendorId: id ?? '' });

  if (vendor.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (!vendor.data) {
    return <EmptyState title="Vendor not found" message="It may have been removed." />;
  }

  const data = vendor.data;

  return (
    <>
      <PageHeader
        title={data.companyName}
        status={data.status}
        backTo="/vendors"
        crumbs={[
          { label: 'Vendors', to: '/vendors' },
          { label: data.companyName },
        ]}
        meta={
          <>
            <span className="font-mono">{data.gstin ?? 'No GSTIN on file'}</span>
            <span>
              {data.city}, {data.state}
            </span>
            {data.rating === null ? (
              <span>no rating yet</span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Star aria-hidden className="size-3 fill-warning text-warning" />
                <span className="font-mono tabular-nums">{data.rating.toFixed(1)}</span>
              </span>
            )}
            <span>{formatCount(data.totalOrders)} orders</span>
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="profile">Profile</Tab>
          {can(P.PO_VIEW) && <Tab value="orders">Orders</Tab>}
          <Tab value="performance">Performance</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="profile">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Company" />
              <CardBody>
                <FieldGrid className="grid-cols-2 sm:grid-cols-2">
                  <Field label="Legal name">{data.legalName ?? '—'}</Field>
                  <Field label="Email">{data.email}</Field>
                  <Field label="Phone">{data.phone}</Field>
                  <Field label="GSTIN">
                    <span className="font-mono">{data.gstin ?? '—'}</span>
                  </Field>
                  <Field label="PAN">
                    <span className="font-mono">{data.pan ?? '—'}</span>
                  </Field>
                  <Field label="Registered since">{formatDate(data.createdAt)}</Field>
                  <Field label="Address" className="col-span-2">
                    {data.addressLine1}
                    {data.addressLine2 && `, ${data.addressLine2}`}
                    <br />
                    {data.city}, {data.state} {data.pincode}
                  </Field>
                </FieldGrid>
              </CardBody>
            </Card>

            <Card className="h-fit">
              <CardHeader title="Categories" description="What this vendor supplies." />
              <CardBody>
                {data.categories.length === 0 ? (
                  <p className="text-xs text-muted">
                    No categories yet — this vendor will not appear in category-matched suggestions.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {data.categories.map((category) => (
                      <Badge key={category.id} tone="neutral" size="md">
                        {category.name}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
                  <Field label="On-time delivery" numeric>
                    {data.onTimeDeliveryRate === null
                      ? 'no data'
                      : formatPercent(data.onTimeDeliveryRate, 0)}
                  </Field>
                  <Field label="Total orders" numeric>
                    {formatCount(data.totalOrders)}
                  </Field>
                </div>
              </CardBody>
            </Card>
          </div>
        </TabPanel>

        {can(P.PO_VIEW) && (
          <TabPanel value="orders">
            <DataTable
              columns={poColumns({ side: 'buyer', showParty: false })}
              data={orders.data?.data}
              isLoading={orders.isLoading}
              error={orders.error}
              onRetry={() => orders.refetch()}
              page={pagination.page}
              limit={pagination.limit}
              total={orders.data?.meta.total}
              onPageChange={pagination.setPage}
              onLimitChange={pagination.setLimit}
              columnVisibility={false}
              onRowClick={(row) => navigate(`/purchase-orders/${row.id}`)}
              emptyState={
                <EmptyState
                  title="No orders yet"
                  message="Purchase orders issued to this vendor will appear here."
                />
              }
            />
          </TabPanel>
        )}

        <TabPanel value="performance">
          <Scorecard scorecard={scorecard.data} isLoading={scorecard.isLoading} />
        </TabPanel>

        <TabPanel value="documents">
          <DocumentsTab
            ownerType="VENDOR"
            ownerId={id}
            description="Registration and KYC documents this vendor has provided."
            canUpload={false}
          />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Vendor" entityId={id} />
        </TabPanel>
      </Tabs>
    </>
  );
}
