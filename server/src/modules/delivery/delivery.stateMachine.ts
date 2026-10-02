import type { Delivery, Prisma } from '@prisma/client';
import type { DeliveryStatus } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule } from '../../lib/errors.js';

/**
 * The delivery state machine (plan 11 §2).
 *
 *   DISPATCHED ──► IN_TRANSIT ──► DELIVERED
 *        │              │
 *        └──────────────┴──► CANCELLED
 *
 * **A delivery is a claim, not a fact.** It is the vendor saying what they put
 * on a lorry, and it changes nothing on the purchase order line — only a
 * confirmed GRN moves `receivedQuantity`. That asymmetry is the whole control:
 * the buyer decides what actually arrived.
 *
 * `DELIVERED` is therefore not something the vendor announces either. It is set
 * by `maybeMarkDelivered` when every line on the challan has been fully
 * receipted by the buyer.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Statuses that still hold quantity against the order line (plan 11 §2, check 6). */
export const OPEN_DELIVERY_STATUSES: DeliveryStatus[] = [
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
];

export function assertDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!DELIVERY_TRANSITIONS[from].includes(to)) {
    throw BusinessRule('delivery.invalid_transition', `Cannot move a delivery from ${from} to ${to}`);
  }
}

/**
 * A delivery may be corrected or withdrawn only while the buyer has not
 * receipted any of it. Once a GRN exists against it, the challan is evidence of
 * what was claimed and must not be rewritten.
 */
export function assertDeliveryEditable(
  delivery: Pick<Delivery, 'status'>,
  grnCount: number,
): void {
  /*
   * Receipt is checked first on purpose. A fully-receipted challan is also
   * DELIVERED, and "already received" tells the vendor why it is frozen, where
   * "not editable" only restates the status they can already see.
   */
  if (grnCount > 0) {
    throw BusinessRule(
      'delivery.already_received',
      'This delivery has already been receipted and can no longer be changed',
    );
  }
  if (delivery.status === 'CANCELLED' || delivery.status === 'DELIVERED') {
    throw BusinessRule(
      'delivery.not_editable',
      `A ${delivery.status} delivery can no longer be changed`,
    );
  }
}

export interface DeliveryTransitionMeta {
  data?: Prisma.DeliveryUpdateInput;
  summary?: string;
  action?: string;
  severity?: 'INFO' | 'NOTABLE' | 'SECURITY';
  reason?: string | null;
}

/** The only way a delivery's `status` changes. */
export async function transitionDelivery(
  tx: Prisma.TransactionClient,
  delivery: Delivery & { purchaseOrder?: { organizationId: string } | null },
  to: DeliveryStatus,
  actor: AuditActor,
  meta: DeliveryTransitionMeta = {},
): Promise<Delivery> {
  assertDeliveryTransition(delivery.status, to);

  const updated = await tx.delivery.update({
    where: { id: delivery.id },
    data: { status: to, ...(meta.data ?? {}) },
  });

  await writeAudit(tx, {
    action: meta.action ?? `delivery.${to.toLowerCase()}`,
    entityType: 'Delivery',
    entityId: delivery.id,
    summary:
      meta.summary ??
      `${actor.email ?? 'system'} moved delivery ${delivery.challanNumber} to ${to}`,
    severity: meta.severity ?? 'INFO',
    organizationId: delivery.purchaseOrder?.organizationId ?? null,
    vendorId: delivery.vendorId,
    actor,
    before: { status: delivery.status },
    after: { status: to, ...(meta.reason ? { reason: meta.reason } : {}) },
  });

  return updated;
}
