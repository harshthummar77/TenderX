import { useCallback } from 'react';
import type { MeDto, Permission, Role } from '@tb/shared';
import { clearQueryCache } from '@/lib/queryClient';
import { logout as endSession, logoutEverywhere } from '@/lib/session';
import {
  selectCan,
  selectPartyName,
  selectStatus,
  selectUser,
  useAuthStore,
  type AuthStatus,
} from '@/stores/authStore';

export interface UseAuth {
  user: MeDto | null;
  role: Role | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** The organization or vendor the user acts for — what the topbar shows. */
  partyName: string | null;
  /**
   * `can(P.PAYMENT_RECORD) && <Button>Record payment</Button>`.
   *
   * Hiding the button is convenience. The 403 is the security (04 §7) — the
   * server answers the same whether or not the UI drew it.
   */
  can: (permission: Permission) => boolean;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
}

/** The one hook components use to read the session. */
export function useAuth(): UseAuth {
  const user = useAuthStore(selectUser);
  const status = useAuthStore(selectStatus);
  const can = useAuthStore(selectCan);
  const partyName = useAuthStore(selectPartyName);

  // Dropping the cache on the way out matters on a shared demo machine: the next
  // sign-in must not paint the previous user's tenders for a frame.
  const logout = useCallback(async () => {
    await endSession();
    clearQueryCache();
  }, []);

  const logoutAll = useCallback(async () => {
    await logoutEverywhere();
    clearQueryCache();
  }, []);

  return {
    user,
    role: user?.role ?? null,
    status,
    isAuthenticated: status === 'authenticated',
    isLoading: status === 'loading',
    partyName,
    can,
    logout,
    logoutEverywhere: logoutAll,
  };
}
