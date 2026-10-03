import { Link, useLocation } from 'react-router-dom';
import { Lock, SearchX } from 'lucide-react';
import { ROLE_LABELS } from '@tb/shared';
import { useAuth } from '@/hooks/useAuth';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Rendered IN PLACE of a page the role cannot reach — never as a redirect
 * (plan 16 §3). The URL stays, the sidebar stays, and the user can see where they
 * are and go somewhere else. Redirecting a permission failure throws away the URL
 * and leaves the user wondering what happened.
 *
 * This is also where separation of duties becomes visible rather than mysterious:
 * an officer who clicks an admin's link is told the approval is someone else's
 * job (04 §7).
 */
export function Forbidden({ message }: { message?: string }) {
  const { role, user } = useAuth();
  const location = useLocation();

  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-danger/10 text-danger">
          <Lock className="size-5" />
        </div>

        <h1 className="text-base font-semibold text-text">You do not have access to this page</h1>

        <p className="mt-2 max-w-sm text-sm text-muted">
          {message ??
            `Your role${role ? ` (${ROLE_LABELS[role]})` : ''} cannot open this screen. If you need it, ask an
             administrator at your organization — some actions are deliberately reserved for a second person.`}
        </p>

        <p className="mt-3 font-mono text-xs text-muted">{location.pathname}</p>

        <div className="mt-5 flex items-center gap-2">
          <ButtonLink to="/dashboard" variant="outline" size="sm">
            Go to dashboard
          </ButtonLink>
          {user && (
            <Link to="/settings" className="text-xs text-primary hover:underline">
              View my access
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

/** 404, inside the shell when signed in and standalone when not. */
export function NotFound() {
  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-subtle text-muted">
          <SearchX className="size-5" />
        </div>
        <h1 className="text-base font-semibold text-text">That page does not exist</h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          The link may be out of date, or the record may have been removed.
        </p>
        <ButtonLink to="/dashboard" variant="outline" size="sm" className="mt-5">
          Go to dashboard
        </ButtonLink>
      </div>
    </Card>
  );
}
