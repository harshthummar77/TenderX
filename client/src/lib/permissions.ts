import { can as canFor, hasPermission, PERMISSIONS, type Permission, type Role } from '@tb/shared';

/**
 * The client half of the permission matrix — the same `@tb/shared` file the
 * server enforces with, so the two can never drift.
 *
 *   const { can } = useAuth();
 *   {can(P.PAYMENT_RECORD) && <Button>Record payment</Button>}
 *
 * The hidden button is convenience, not security: the server answers 403
 * whether or not the UI drew it, and plan 18 has a test that calls each hidden
 * action directly with an officer's token to prove it.
 *
 * Plan 16 builds the Zustand auth store and the `useAuth` hook that wraps this.
 */
export const P = PERMISSIONS;
export type { Permission, Role };

/** Build a `can(permission)` predicate for the signed-in role. */
export const permissionsFor = (role: Role | null | undefined) => canFor(role);

export { hasPermission };
