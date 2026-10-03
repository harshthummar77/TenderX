import { create } from 'zustand';
import { hasPermission, type MeDto, type Permission, type Role } from '@tb/shared';

/**
 * The only client state in the app (plan 16 §1). Everything else is server
 * state and lives in TanStack Query.
 *
 * **The access token is held in memory and nowhere else.** No localStorage, no
 * sessionStorage, no cookie the JS can read. Persistence is the httpOnly
 * refresh cookie the server sets, which script on the page cannot touch — so an
 * XSS payload that runs here gets a token with minutes left on it at worst, and
 * nothing it can replay tomorrow. The cost is one `/auth/refresh` call on boot;
 * see `lib/session.ts`.
 *
 * This file deliberately performs no HTTP. `lib/api.ts` reads the token from
 * here, so if the store called the API back the two would import each other.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  /** In memory only — never persisted. */
  accessToken: string | null;
  user: MeDto | null;
  status: AuthStatus;
  setSession: (accessToken: string, user: MeDto) => void;
  /** After a silent refresh, where the token changes but the user did not. */
  setAccessToken: (accessToken: string) => void;
  /** After PATCH /auth/me, or a fresh GET /auth/me. */
  setUser: (user: MeDto) => void;
  clear: () => void;
  /** Reads ROLE_PERMISSIONS from @tb/shared — the same matrix the server enforces. */
  can: (permission: Permission) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  user: null,
  status: 'loading',

  setSession: (accessToken, user) => set({ accessToken, user, status: 'authenticated' }),

  setAccessToken: (accessToken) => set({ accessToken }),

  setUser: (user) => set({ user }),

  clear: () => set({ accessToken: null, user: null, status: 'anonymous' }),

  can: (permission) => {
    const role = get().user?.role;
    return role ? hasPermission(role, permission) : false;
  },
}));

/* -------------------------------------------------------------------------- */
/* Selectors — components subscribe to one field, not the whole store          */
/* -------------------------------------------------------------------------- */

export const selectUser = (s: AuthState) => s.user;
export const selectStatus = (s: AuthState) => s.status;
export const selectCan = (s: AuthState) => s.can;

/** Which party the signed-in user acts for — the name the topbar shows. */
export const selectPartyName = (s: AuthState): string | null =>
  s.user?.organization?.name ?? s.user?.vendor?.name ?? null;

export const selectRole = (s: AuthState): Role | null => s.user?.role ?? null;

/** Read the token outside React (the request interceptor). */
export const getAccessToken = () => useAuthStore.getState().accessToken;
