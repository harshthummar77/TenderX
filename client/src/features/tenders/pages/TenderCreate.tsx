import { useParams } from 'react-router-dom';
import { PERMISSIONS as P } from '@tb/shared';
import { useAuth } from '@/hooks/useAuth';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/data/EmptyState';
import { Forbidden } from '@/components/Forbidden';
import { TenderWizard } from '@/features/tenders/components/TenderWizard';
import { useTender } from '@/features/tenders/api';

/** `/tenders/new` */
export function TenderCreatePage() {
  const { can } = useAuth();
  if (!can(P.TENDER_CREATE)) return <Forbidden />;
  return <TenderWizard />;
}

/** `/tenders/:id/edit` — the same wizard, loaded with an existing draft. */
export function TenderEditPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const tender = useTender(id);

  if (!can(P.TENDER_UPDATE)) return <Forbidden />;

  if (tender.isLoading) {
    return (
      <>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }

  if (!tender.data) return <EmptyState title="Tender not found" />;

  // Publishing locks the items and deadlines, so there is nothing to edit after
  // it — the server refuses the PATCH and this says so first.
  if (tender.data.status !== 'DRAFT') {
    return (
      <EmptyState
        title="This tender can no longer be edited"
        message={`It is ${tender.data.status.toLowerCase().replace(/_/g, ' ')}. Items and deadlines are fixed once vendors can bid.`}
      />
    );
  }

  return <TenderWizard tender={tender.data} />;
}
