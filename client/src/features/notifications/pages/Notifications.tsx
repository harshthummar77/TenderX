import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Mail, MailX } from 'lucide-react';
import type {
  NotificationDto,
  NotificationPreferenceDto,
  Paginated,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { apiGet, apiGetPage, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative, humanize } from '@/lib/format';
import { usePagination } from '@/hooks/usePagination';
import { useQueryTab } from '@/hooks/useQueryTab';
import { qk } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/data/EmptyState';
import { FilterBar } from '@/components/data/FilterBar';
import { PageHeader } from '@/components/layout/PageHeader';

/**
 * `/notifications` — the full list behind the topbar bell (plan 14 §B).
 *
 * Every notification belongs to exactly one user and every query is scoped to
 * them server-side, so there is no permission check here: there is no cross-user
 * read to protect, and a guard would imply there was one.
 */
export function NotificationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pagination = usePagination({ sort: '-createdAt' });
  const [tab, setTab] = useQueryTab('inbox');

  const notifications = useQuery<Paginated<NotificationDto>>({
    queryKey: qk.notifications.list(pagination.params),
    queryFn: () => apiGetPage<NotificationDto>('/notifications', { params: pagination.params }),
  });

  const preferences = useQuery({
    queryKey: qk.notifications.preferences,
    queryFn: () => apiGet<NotificationPreferenceDto[]>('/me/notification-preferences'),
    enabled: tab === 'preferences',
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.notifications.all });

  const markRead = useMutation({
    mutationFn: (id: string) => apiPost(`/notifications/${id}/read`, {}),
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => apiPost('/notifications/read-all', {}),
    onSuccess: () => {
      invalidate();
      toast.success('All notifications marked read');
    },
    onError: (error) => toast.fromError(error),
  });

  const rows = notifications.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Everything the system has told you, newest first."
        actions={
          <Button
            variant="outline"
            leftIcon={<CheckCheck className="size-3.5" />}
            loading={markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            Mark all read
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="inbox">Inbox</Tab>
          <Tab value="preferences">What gets emailed</Tab>
        </TabList>

        <TabPanel value="inbox">
          <FilterBar
            onClear={pagination.reset}
            activeCount={pagination.getFilter('unread') ? 1 : 0}
          >
            <Select
              aria-label="Read state"
              className="h-9 w-40"
              placeholder="All"
              value={pagination.getFilter('unread') ?? ''}
              options={[
                { value: 'true', label: 'Unread only' },
                { value: 'false', label: 'Read only' },
              ]}
              onChange={(event) => pagination.setFilter('unread', event.target.value || undefined)}
            />
          </FilterBar>

          <Card>
            {notifications.isLoading ? (
              <CardBody>
                <Skeleton className="h-48 w-full" />
              </CardBody>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Bell className="size-5" />}
                title="Nothing here"
                message="Invitations, approvals, deliveries and payments all show up here as they happen."
              />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((notification) => (
                  <li key={notification.id}>
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-subtle',
                        !notification.readAt && 'bg-primary/5',
                      )}
                      onClick={() => {
                        if (!notification.readAt) markRead.mutate(notification.id);
                        if (notification.link) navigate(notification.link);
                      }}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          notification.readAt ? 'bg-transparent' : 'bg-primary',
                        )}
                      />

                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-2">
                          <span className="text-sm font-medium">{notification.title}</span>
                          <span className="text-xs text-muted">
                            {humanize(notification.type)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">{notification.body}</span>
                        <span className="mt-1 block text-xs text-muted">
                          {formatRelative(notification.createdAt)}
                        </span>
                      </span>

                      <span className="shrink-0">
                        {notification.emailError ? (
                          <Tooltip content={`Email failed: ${notification.emailError}`}>
                            <MailX aria-hidden className="size-3.5 text-danger" />
                          </Tooltip>
                        ) : notification.emailSentAt ? (
                          <Tooltip
                            content={`Emailed ${formatDateTime(notification.emailSentAt)}`}
                          >
                            <Mail aria-hidden className="size-3.5 text-muted" />
                          </Tooltip>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {(notifications.data?.meta.pages ?? 1) > 1 && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page <= 1}
                onClick={() => pagination.setPage(pagination.page - 1)}
              >
                Previous
              </Button>
              <span className="font-mono text-xs tabular-nums text-muted">
                {pagination.page} / {notifications.data?.meta.pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page >= (notifications.data?.meta.pages ?? 1)}
                onClick={() => pagination.setPage(pagination.page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </TabPanel>

        <TabPanel value="preferences">
          <Card>
            <CardHeader
              title="Which events email you"
              description="Everything is in-app. Only the events below also send mail — the policy is set centrally rather than per user."
            />
            {preferences.isLoading ? (
              <CardBody>
                <Skeleton className="h-48 w-full" />
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {(preferences.data ?? []).map((preference) => (
                  <li
                    key={preference.type}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm">{preference.label}</span>
                      <span className="block font-mono text-xs text-muted">{preference.type}</span>
                    </span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1.5 text-xs',
                        preference.email ? 'text-success' : 'text-muted',
                      )}
                    >
                      {preference.email ? (
                        <>
                          <Mail aria-hidden className="size-3.5" />
                          in-app and email
                        </>
                      ) : (
                        <>
                          <Bell aria-hidden className="size-3.5" />
                          in-app only
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabPanel>
      </Tabs>
    </>
  );
}
