import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, LogOut, Menu, UserCog } from 'lucide-react';
import {
  ROLE_LABELS,
  type NotificationDto,
  type Paginated,
  type UnreadCountDto,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { apiGetPage, apiGet, apiPost } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { formatRelative, initials } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui/dropdown';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

/**
 * The bell. Polls the unread count every 60 s and refetches on focus — the
 * replacement for the SSE stream that was cut (00 §3), and cheap: the endpoint is
 * a single indexed `count`.
 *
 * The list itself is fetched only when the menu opens, so the poll stays a count.
 */
function NotificationBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: count } = useQuery({
    queryKey: qk.notifications.unreadCount,
    queryFn: () => apiGet<UnreadCountDto>('/notifications/unread-count'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const unread = count?.unread ?? 0;

  const markRead = useMutation({
    mutationFn: (id: string) => apiPost(`/notifications/${id}/read`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.notifications.all });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => apiPost('/notifications/read-all', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.notifications.all });
      toast.success('All notifications marked read');
    },
    onError: (error) => toast.fromError(error),
  });

  return (
    <Dropdown
      menuClassName="w-80"
      trigger={({ toggle, open, id }) => (
        <button
          id={id}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          className="relative rounded-md p-2 text-muted transition-colors hover:bg-subtle hover:text-text"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 font-mono text-[10px] leading-4 text-on-primary tabular-nums">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      )}
    >
      {(close) => <NotificationList
        onPick={(notification) => {
          if (!notification.readAt) markRead.mutate(notification.id);
          close();
          if (notification.link) navigate(notification.link);
        }}
        onMarkAll={() => {
          markAllRead.mutate();
          close();
        }}
      />}
    </Dropdown>
  );
}

function NotificationList({
  onPick,
  onMarkAll,
}: {
  onPick: (notification: NotificationDto) => void;
  onMarkAll: () => void;
}) {
  const { data, isLoading } = useQuery<Paginated<NotificationDto>>({
    queryKey: qk.notifications.list({ limit: 8 }),
    queryFn: () => apiGetPage<NotificationDto>('/notifications', { params: { limit: 8 } }),
  });

  const rows = data?.data ?? [];

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5">
        <DropdownLabel>Notifications</DropdownLabel>
        <button
          type="button"
          onClick={onMarkAll}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <CheckCheck className="size-3.5" />
          Mark all read
        </button>
      </div>
      <DropdownSeparator />

      {isLoading && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <p className="px-3 py-6 text-center text-xs text-muted">Nothing new.</p>
      )}

      <ul className="max-h-80 overflow-y-auto">
        {rows.map((notification) => (
          <li key={notification.id}>
            <button
              type="button"
              onClick={() => onPick(notification)}
              className={cn(
                'w-full px-3 py-2 text-left transition-colors hover:bg-subtle',
                !notification.readAt && 'bg-primary/5',
              )}
            >
              <div className="flex items-start gap-2">
                {!notification.readAt && (
                  <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-text">{notification.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{notification.body}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {formatRelative(notification.createdAt)}
                  </p>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Brand, the current party, the bell, the user menu.
 *
 * **The party name is load-bearing.** A demo runs four browser profiles side by
 * side — buyer admin, officer, two vendors — and "Meridian Industries" in the
 * topbar is what makes which window is which readable from the back of the room.
 */
export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const navigate = useNavigate();
  const { user, role, partyName, logout } = useAuth();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        onClick={onOpenSidebar}
        className="lg:hidden"
      >
        <Menu className="size-4" />
      </Button>

      <span className="text-sm font-semibold tracking-tight text-text">TenderBridge</span>

      {partyName && (
        <Badge tone="primary" size="md" className="hidden sm:inline-flex">
          {partyName}
        </Badge>
      )}

      <div className="flex-1" />

      <NotificationBell />

      <Dropdown
        trigger={({ toggle, open, id }) => (
          <button
            id={id}
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-subtle"
          >
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary"
            >
              {initials(user?.fullName)}
            </span>
            <span className="hidden text-sm text-text sm:inline">{user?.fullName}</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium text-text">{user?.fullName}</p>
              <p className="truncate text-xs text-muted">{user?.email}</p>
              {role && <p className="mt-1 text-xs text-muted">{ROLE_LABELS[role]}</p>}
            </div>
            <DropdownSeparator />
            <DropdownItem
              icon={<UserCog className="size-4" />}
              onClick={() => {
                close();
                navigate('/settings');
              }}
            >
              My profile
            </DropdownItem>
            <DropdownItem
              icon={<LogOut className="size-4" />}
              danger
              onClick={() => {
                close();
                void logout();
              }}
            >
              Sign out
            </DropdownItem>
          </>
        )}
      </Dropdown>
    </header>
  );
}
