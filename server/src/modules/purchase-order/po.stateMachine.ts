import type { Prisma, PurchaseOrder } from '@prisma/client';
import type { PoStatus } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule } from '../../lib/errors.js';

/**
 * The purchase-order state machine (10 §1).
 *
 *   DRAFT ──issue──► ISSUED ──accept──► ACCEPTED ──► CLOSED
 *                      │                    │
 *                      │ reject             └──cancel──► CANCELLED
 *                      ▼
 *                   REJECTED ──(amend & reissue, or cancel & re-award)
 *
 * **`status` and `fulfilmentStatus` are different things and are never
 * conflated** (defect C2 corrected). `status` is where the contract stands
 * between the two parties and only moves through this file. `fulfilmentStatus`
 * is derived from goods actually received and is maintained by plan 11 through
 * `recomputeFulfilment` — no user ever sets it.
 *
 * `REJECTED → ISSUED` is deliberate: a vendor who rejects an order over a date
 * or a quantity should be able to receive a corrected one without the buyer
 * cancelling and re-awarding the whole tender.
 */
export const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['CLOSED', 'CANCELLED'],
  REJECTED: ['ISSUED', 'CANCELLED'],
  CANCELLED: [],
  CLOSED: [],
};

export function assertPoTransition(from: PoStatus, to: PoStatus): void {
  if (!PO_TRANSITIONS[from].includes(to)) {
    throw BusinessRule('po.invalid_transition', `Cannot move a purchase order from ${from} to ${to}`);
  }
}

/**
 * Only a DRAFT or a REJECTED order may be edited. An ISSUED order is an offer
 * the vendor is reading, and an ACCEPTED one is a contract.
 */
export function assertPoEditable(po: Pick<PurchaseOrder, 'status'>): void {
  if (po.status !== 'DRAFT' && po.status !== 'REJECTED') {
    throw BusinessRule('po.not_editable', `A ${po.status} purchase order can no longer be amended`);
  }
}

export interface PoTransitionMeta {
  data?: Prisma.PurchaseOrderUpdateInput;
  summary?: string;
  action?: string;
  severity?: 'INFO' | 'NOTABLE' | 'SECURITY';
  reason?: string | null;
  after?: Record<string, unknown>;
}

/** The only way a purchase order's `status` changes. Status write + audit, one transaction. */
export async function transitionPo(
  tx: Prisma.TransactionClient,
  po: PurchaseOrder,
  to: PoStatus,
  actor: AuditActor,
  meta: PoTransitionMeta = {},
): Promise<PurchaseOrder> {
  assertPoTransition(po.status, to);

  const updated = await tx.purchaseOrder.update({
    where: { id: po.id },
    data: { status: to, ...(meta.data ?? {}) },
  });

  await writeAudit(tx, {
    action: meta.action ?? `po.${to.toLowerCase()}`,
    entityType: 'PurchaseOrder',
    entityId: po.id,
    summary: meta.summary ?? `${actor.email ?? 'system'} moved ${po.poNumber} to ${to}`,
    severity: meta.severity ?? 'NOTABLE',
    organizationId: po.organizationId,
    vendorId: po.vendorId,
    actor,
    before: { status: po.status },
    after: {
      status: to,
      ...(meta.reason ? { reason: meta.reason } : {}),
      ...(meta.after ?? {}),
    },
  });

  return updated;
}
