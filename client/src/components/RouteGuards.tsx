import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@tb/shared';
import { useAuth } from '@/hooks/useAuth';
import { Forbidden } from '@/components/Forbidden';
import { FullPageSpinner } from '@/components/ui/spinner';

/**
 * Route guards (plan 16 §3). **They render, they do not redirect** — except for
 * the one case where a redirect is the right answer: an anonymous visitor has
 * nothing to be shown, so they go to /login carrying the path they wanted.
 */

/**
 * `status === 'loading'` cannot normally be seen here — `App` holds the routes
 * back until the boot refresh settles — but the spinner is kept as a belt-and-braces
 * guard against a login flash if that order is ever changed.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/**
 * **A permission failure renders in place.** The URL does not change and the
 * sidebar stays — redirecting would throw away the URL and leave the user with no
 * idea what happened. "You do not have access to this page" with the navigation
 * still there is correct (§3).
 */
export function RequirePermission({
  perm,
  children,
}: {
  perm: Permission | Permission[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  const needed = Array.isArray(perm) ? perm : [perm];
  // Any-of, not all-of: a screen reachable by two different roles asks for either.
  return needed.some((permission) => can(permission)) ? <>{children}</> : <Forbidden />;
}

/** An already-signed-in user has no use for the login page. */
export function RequireAnonymous({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
