import type { VendorStatus } from '@tb/shared';
import { BusinessRule } from '../../lib/errors.js';

/**
 * The vendor lifecycle. No service writes `status` directly — every change goes
 * through `assertTransition` (00 §6, invariant 1).
 *
 *   PENDING_APPROVAL -approve-> APPROVED -suspend-> SUSPENDED -reinstate-> APPROVED
 *          |                        |
 *          +-reject-> REJECTED      +-blacklist-> BLACKLISTED   (terminal)
 */
export type VendorAction = 'approve' | 'reject' | 'suspend' | 'reinstate' | 'blacklist';

export const VENDOR_TRANSITIONS: Record<VendorAction, { from: VendorStatus[]; to: VendorStatus }> = {
  approve: { from: ['PENDING_APPROVAL', 'REJECTED'], to: 'APPROVED' },
  reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
  suspend: { from: ['APPROVED'], to: 'SUSPENDED' },
  reinstate: { from: ['SUSPENDED'], to: 'APPROVED' },
  /** Terminal by design: there is no transition out of BLACKLISTED. */
  blacklist: { from: ['PENDING_APPROVAL', 'APPROVED', 'SUSPENDED', 'REJECTED'], to: 'BLACKLISTED' },
};

export function assertTransition(current: VendorStatus, action: VendorAction): VendorStatus {
  const transition = VENDOR_TRANSITIONS[action];
  if (!transition.from.includes(current)) {
    throw BusinessRule(
      'vendor.invalid_transition',
      `A ${current} vendor cannot be ${action === 'reinstate' ? 'reinstated' : `${action}d`}`,
    );
  }
  return transition.to;
}

/* -------------------------------------------------------------------------- */
/* Capability by status — this table IS the module (06 §1)                    */
/* -------------------------------------------------------------------------- */

/** New business: being invited to a tender, and submitting a quotation. */
export const canDoNewBusiness = (status: VendorStatus): boolean => status === 'APPROVED';

/**
 * Honouring obligations that already exist: accepting a PO issued before the
 * suspension, delivering against it, invoicing for goods already delivered.
 *
 * Suspension stops new business; it does not repudiate existing obligations. A
 * suspended vendor that already delivered goods must still be able to invoice
 * and be paid, or the system steals from suppliers. Only a rejected vendor —
 * one that was never onboarded — is shut out entirely.
 */
export const canHonourExistingObligations = (status: VendorStatus): boolean =>
  status !== 'REJECTED';

/** Blacklisting blocks acceptance and delivery, but never invoicing or payment. */
export const canAcceptOrDeliver = (status: VendorStatus): boolean =>
  status === 'APPROVED' || status === 'SUSPENDED';
