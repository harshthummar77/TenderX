import type { Delivery, DeliveryItem, Prisma, PurchaseOrderItem } from '@prisma/client';
import type { CreateDeliveryInput, DeliveryQuery, UpdateDeliveryInput } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { money, qtyToApi, sum, ZERO, type Decimal } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToParty, scopeToVendor } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import {
  assertDeliveryEditable,
  OPEN_DELIVERY_STATUSES,
  transitionDelivery,
} from './delivery.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

export type DeliveryWithRelations = Delivery & {
  items: (DeliveryItem & { purchaseOrderItem?: PurchaseOrderItem | null })[];
  purchaseOrder?: { id: string; poNumber: string; organizationId: string; vendorName: string } | null;
};

const withRelations = {
  items: { include: { purchaseOrderItem: true } },
  purchaseOrder: {
    select: { id: true, poNumber: true, organizationId: true, vendorName: true },
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Cumulative dispatch accounting (plan 11 §2, check 6)                       */
/* -------------------------------------------------------------------------- */

/**
 * How much of each order line is already claimed by open deliveries.
 *
 * **Cumulative, never per document** — the single most common bug in this
 * domain. Two dispatches of 8 against a 12-unit line must fail on the second
 * even though 8 ≤ 12 on its own.
 *
 * Only open deliveries count. A cancelled one frees its quantity again, which is
 * what makes "cancel and redispatch" work without a special case.
 */
export async function dispatchedByItem(
  client: Prisma.TransactionClient,
  purchaseOrderId: string,
  excludeDeliveryId?: string,
): Promise<Map<string, Decimal>> {
  const rows = await client.deliveryItem.findMany({
    where: {
      delivery: {
        purchaseOrderId,
        status: { in: OPEN_DELIVERY_STATUSES },
        ...(excludeDeliveryId ? { id: { not: excludeDeliveryId } } : {}),
      },
    },
    select: { purchaseOrderItemId: true, quantity: true },
  });

  const byItem = new Map<string, Decimal>();
  for (const row of rows) {
    const current = byItem.get(row.purchaseOrderItemId) ?? ZERO;
    byItem.set(row.purchaseOrderItemId, current.plus(money(row.quantity)));
  }
  return byItem;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Visible to both parties: the vendor raised it, the buyer receipts it. */
export async function loadDelivery(actor: Actor, id: string): Promise<DeliveryWithRelations> {
  const scope = scopeToParty(actor);
  const delivery = await prisma.delivery.findFirst({
    where: {
      id,
      ...(scope.vendorId ? { vendorId: scope.vendorId } : {}),
      ...(scope.organizationId
        ? { purchaseOrder: { organizationId: scope.organizationId } }
        : {}),
    },
    include: withRelations,
  });
  if (!delivery) throw NotFound('Delivery');
  return delivery;
}

export async function listOwnDeliveries(actor: Actor, query: DeliveryQuery) {
  const where: Prisma.DeliveryWhereInput = {
    ...scopeToVendor(actor),
    ...(query.status ? { status: query.status } : {}),
    ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.delivery.findMany({
      where,
      include: withRelations,
      orderBy: { dispatchedAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.delivery.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

/** True once every line on the challan has been fully receipted. */
export async function isFullyReceipted(
  client: Prisma.TransactionClient,
  deliveryId: string,
): Promise<boolean> {
  const delivery = await client.delivery.findUnique({
    where: { id: deliveryId },
    include: { items: true },
  });
  if (!delivery) return false;

  const receipts = await client.grnItem.findMany({
    where: { grn: { deliveryId } },
    select: { purchaseOrderItemId: true, receivedQuantity: true },
  });

  const receivedByItem = new Map<string, Decimal>();
  for (const row of receipts) {
    const current = receivedByItem.get(row.purchaseOrderItemId) ?? ZERO;
    receivedByItem.set(row.purchaseOrderItemId, current.plus(money(row.receivedQuantity)));
  }

  return delivery.items.every((item) =>
    (receivedByItem.get(item.purchaseOrderItemId) ?? ZERO).greaterThanOrEqualTo(
      money(item.quantity),
    ),
  );
}

/**
 * Mark a challan DELIVERED once the buyer has receipted all of it.
 *
 * The vendor never sets this. "Delivered" means the goods were actually taken in
 * by the buyer, which only the buyer can assert.
 */
export async function maybeMarkDelivered(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  actor: AuditActor,
): Promise<void> {
  const delivery = await tx.delivery.findUnique({
    where: { id: deliveryId },
    include: { purchaseOrder: { select: { organizationId: true } } },
  });
  if (!delivery || delivery.status === 'DELIVERED' || delivery.status === 'CANCELLED') return;

  if (!(await isFullyReceipted(tx, deliveryId))) return;

  await transitionDelivery(tx, delivery, 'DELIVERED', actor, {
    action: 'delivery.delivered',
    summary: `Delivery ${delivery.challanNumber} was fully receipted`,
    data: { deliveredAt: new Date() },
  });
}

/* -------------------------------------------------------------------------- */
/* Create (plan 11 §2)                                                        */
/* -------------------------------------------------------------------------- */

/** Guards 1–3: the order is this vendor's, accepted, and they may still ship. */
async function loadDeliverablePo(actor: Actor, purchaseOrderId: string) {
  if (!actor.vendorId) throw NotFound('Purchase order');

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, vendorId: actor.vendorId },
    include: { items: true },
  });
  if (!po) throw NotFound('Purchase order');

  if (po.status !== 'ACCEPTED') {
    throw BusinessRule(
      'delivery.po_not_accepted',
      `Goods can only be dispatched against an ACCEPTED order; this one is ${po.status}`,
    );
  }

  const vendor = await prisma.vendor.findUniqueOrThrow({
    where: { id: po.vendorId },
    select: { status: true, companyName: true },
  });
  if (vendor.status === 'BLACKLISTED' || vendor.status === 'REJECTED') {
    throw BusinessRule(
      'delivery.vendor_not_permitted',
      `A ${vendor.status} vendor cannot dispatch goods`,
    );
  }

  return { po, vendor };
}

interface LineInput {
  purchaseOrderItemId: string;
  quantity: string;
}

/** Guards 4–6: real lines, belonging to this order, within what is still open. */
async function assertDispatchable(
  client: Prisma.TransactionClient,
  po: { id: string; items: PurchaseOrderItem[] },
  items: LineInput[],
  excludeDeliveryId?: string,
): Promise<void> {
  const positive = items.filter((item) => money(item.quantity).greaterThan(0));
  if (positive.length === 0) {
    throw BusinessRule('delivery.no_items', 'A delivery needs at least one line with a quantity');
  }

  const byId = new Map(po.items.map((item) => [item.id, item]));
  const alreadyDispatched = await dispatchedByItem(client, po.id, excludeDeliveryId);

  for (const line of items) {
    const poItem = byId.get(line.purchaseOrderItemId);
    if (!poItem) {
      throw BusinessRule(
        'delivery.invalid_item',
        `Line ${line.purchaseOrderItemId} is not part of this purchase order`,
      );
    }

    const open = alreadyDispatched.get(line.purchaseOrderItemId) ?? ZERO;
    const total = open.plus(money(line.quantity));
    if (total.greaterThan(money(poItem.quantity))) {
      throw BusinessRule(
        'delivery.exceeds_ordered',
        `Line ${poItem.srNo}: dispatching ${qtyToApi(line.quantity)} on top of ${qtyToApi(open)} exceeds the ordered ${qtyToApi(poItem.quantity)}`,
      );
    }
  }
}

/** Guard 7 — a challan cannot be dated in the future. */
function assertDispatchDate(dispatchedAt: Date): void {
  if (dispatchedAt.getTime() > Date.now() + 60_000) {
    throw BusinessRule('delivery.invalid_date', 'The dispatch date cannot be in the future');
  }
}

export async function createDelivery(
  actor: Actor,
  purchaseOrderId: string,
  input: CreateDeliveryInput,
  ctx: RefreshContext,
) {
  const { po, vendor } = await loadDeliverablePo(actor, purchaseOrderId);
  const dispatchedAt = new Date(input.dispatchedAt);
  assertDispatchDate(dispatchedAt);

  const created = await prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction so two dispatches racing on one line
    // cannot both pass: the quantity read here is the quantity committed.
    await assertDispatchable(tx, po, input.items);

    const delivery = await tx.delivery.create({
      data: {
        purchaseOrderId,
        vendorId: po.vendorId,
        challanNumber: input.challanNumber,
        dispatchedAt,
        expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
        carrierName: input.carrierName ?? null,
        trackingReference: input.trackingReference ?? null,
        notes: input.notes ?? null,
        status: 'DISPATCHED',
        items: {
          create: input.items.map((item) => ({
            purchaseOrderItemId: item.purchaseOrderItemId,
            quantity: item.quantity,
          })),
        },
      },
      include: withRelations,
    });

    await writeAudit(tx, {
      action: 'delivery.dispatched',
      entityType: 'Delivery',
      entityId: delivery.id,
      summary: `${vendor.companyName} dispatched ${input.items.length} line(s) against ${po.poNumber} on challan ${input.challanNumber}`,
      organizationId: po.organizationId,
      vendorId: po.vendorId,
      actor: auditActorOf(actor, ctx),
      after: {
        challanNumber: input.challanNumber,
        items: input.items.length,
        quantity: qtyToApi(sum(input.items.map((item) => money(item.quantity)))),
      },
    });

    const officers = await tx.user.findMany({
      where: {
        organizationId: po.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      officers.map((u) => u.id),
      {
        type: 'DELIVERY_DISPATCHED',
        title: `Goods dispatched against ${po.poNumber}`,
        body: `${vendor.companyName} dispatched ${input.items.length} line(s) on challan ${input.challanNumber}${input.expectedAt ? `, expected ${input.expectedAt.slice(0, 10)}` : ''}.`,
        entityType: 'PurchaseOrder',
        entityId: po.id,
        link: `/purchase-orders/${po.id}/receivable`,
      },
    );

    return { delivery, officers };
  });

  emailAfterCommit(
    created.officers,
    `Goods dispatched against ${po.poNumber}`,
    `Challan ${input.challanNumber} from ${vendor.companyName}.`,
  );

  return loadDelivery(actor, created.delivery.id);
}

/* -------------------------------------------------------------------------- */
/* Update and cancel — both only before receipt                               */
/* -------------------------------------------------------------------------- */

export async function updateDelivery(
  actor: Actor,
  id: string,
  input: UpdateDeliveryInput,
  ctx: RefreshContext,
) {
  const delivery = await loadDelivery(actor, id);
  const grnCount = await prisma.grn.count({ where: { deliveryId: id } });
  assertDeliveryEditable(delivery, grnCount);

  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: delivery.purchaseOrderId },
    include: { items: true },
  });

  if (input.dispatchedAt) assertDispatchDate(new Date(input.dispatchedAt));

  await prisma.$transaction(async (tx) => {
    if (input.items) {
      // Its own quantity is excluded from the cumulative check, or editing a
      // delivery down to the same total would collide with itself.
      await assertDispatchable(tx, po, input.items, id);
      await tx.deliveryItem.deleteMany({ where: { deliveryId: id } });
    }

    await tx.delivery.update({
      where: { id },
      data: {
        ...(input.challanNumber !== undefined ? { challanNumber: input.challanNumber } : {}),
        ...(input.dispatchedAt ? { dispatchedAt: new Date(input.dispatchedAt) } : {}),
        ...(input.expectedAt !== undefined
          ? { expectedAt: input.expectedAt ? new Date(input.expectedAt) : null }
          : {}),
        ...(input.carrierName !== undefined ? { carrierName: input.carrierName } : {}),
        ...(input.trackingReference !== undefined
          ? { trackingReference: input.trackingReference }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.items
          ? {
              items: {
                create: input.items.map((item) => ({
                  purchaseOrderItemId: item.purchaseOrderItemId,
                  quantity: item.quantity,
                })),
              },
            }
          : {}),
      },
    });

    await writeAudit(tx, {
      action: 'delivery.updated',
      entityType: 'Delivery',
      entityId: id,
      severity: 'INFO',
      summary: `${actor.email} corrected challan ${delivery.challanNumber}`,
      organizationId: po.organizationId,
      vendorId: delivery.vendorId,
      actor: auditActorOf(actor, ctx),
      after: { fields: Object.keys(input) },
    });
  });

  return loadDelivery(actor, id);
}

/**
 * Cancelling frees the claimed quantity, so the vendor can redispatch. That is
 * why the cumulative check counts only open deliveries.
 */
export async function cancelDelivery(
  actor: Actor,
  id: string,
  reason: string,
  ctx: RefreshContext,
) {
  const delivery = await loadDelivery(actor, id);
  const grnCount = await prisma.grn.count({ where: { deliveryId: id } });
  assertDeliveryEditable(delivery, grnCount);

  await prisma.$transaction(async (tx) => {
    const row = await tx.delivery.findUniqueOrThrow({
      where: { id },
      include: { purchaseOrder: { select: { organizationId: true } } },
    });

    await transitionDelivery(tx, row, 'CANCELLED', auditActorOf(actor, ctx), {
      action: 'delivery.cancelled',
      severity: 'NOTABLE',
      summary: `${actor.email} cancelled challan ${delivery.challanNumber}: ${reason}`,
      reason,
    });
  });

  return loadDelivery(actor, id);
}
