import { Construction } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/data/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';

/**
 * A route that exists so the shell is navigable before plan 17 fills it in.
 *
 * Every sidebar link, dashboard tile and notification link the API emits points
 * at a real path from day one, which is what lets the plan 16 acceptance checks
 * (permission-filtered navigation, `<Forbidden />` rendered in place, no 404s on
 * a notification click) be verified against the finished shell rather than
 * waiting for twenty screens.
 */
export function Placeholder({ title, plan = 17 }: { title: string; plan?: number }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          icon={<Construction className="size-5" />}
          title={`${title} is built in plan ${plan}`}
          message="The shell, API client, auth lifecycle and base components are in place; this screen is assembled from them next."
        />
      </Card>
    </>
  );
}
