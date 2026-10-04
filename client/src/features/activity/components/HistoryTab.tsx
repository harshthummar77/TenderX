import { Card } from '@/components/ui/card';
import { Timeline } from '@/components/Timeline';
import { useEntityActivity } from '@/features/activity/api';

/**
 * The "History" tab, reused on nine detail screens (plan 17 §8).
 *
 * One component rather than nine, because the audit trail is identical whatever
 * it hangs off: `/activity?entityType=&entityId=` already scopes the rows to the
 * caller's tenant and role.
 */
export function HistoryTab({
  entityType,
  entityId,
  emptyMessage,
}: {
  /** The `Audit.entityType` value the server writes: `Tender`, `Invoice`, … */
  entityType: string;
  entityId: string | undefined;
  emptyMessage?: string;
}) {
  const activity = useEntityActivity(entityType, entityId);

  return (
    <Card>
      <div className="p-4">
        <Timeline
          entries={activity.data?.data}
          isLoading={activity.isLoading}
          emptyMessage={emptyMessage ?? 'Actions on this record will appear here.'}
        />
      </div>
    </Card>
  );
}
