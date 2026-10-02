import type { Prisma, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import type {
  CreateGrnInput,
  GrnItemInput,
  GrnQuery,
  GrnStatus,
  ReceivableDto,
  ReceivableLineDto,
} from '@tb/shared';
import { GRN_REJECTION_REASON_MIN_LENGTH } from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { money, qtyToApi, round2, sum, toApi, ZERO, type Decimal } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { nextNumber } from '../../lib/numbering.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg, scopeToParty } from '../../lib/scope.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { dispatchedByItem, maybeMarkDelivered } from '../delivery/delivery.service.js';
import { OPEN_DELIVERY_STATUSES } from '../delivery/delivery.stateMachine.js';
import { getSettings } from '../organization/organization.service.js';
import { recomputeFulfilment } from '../purchase-order/fulfilment.service.js';
import type { GrnWithRelations } from './grn.serializers.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

const withRelations = {
  items: { include: { purchaseOrderItem: true } },
  purchaseOrder: { select: { id: true, poNumber: true } },
  delivery: { select: { id: true, challanNumber: true } },
} as const;

/* -------------------------------------------------------------------------- */
/* Derived status (plan 11 §3)                                                */
/* -------------------------------------------------------------------------- */

/**
 * **Never chosen by the user.** A payload that could set this could label a
 * fully-rejected receipt `ACCEPTED`, and the invoice match in plan 12 would then
 * pay for goods that were refused.
 */
export function deriveGrnStatus(
  items: { acceptedQuantity: Decimal.Value; rejectedQuantity: Decimal.Value }[],
): GrnStatus {
  if (items.every((item) => money(item.rejectedQuantity).isZero())) return 'ACCEPTED';
  if (items.every((item) => money(item.acceptedQuantity).isZero())) return 'REJECTED';
  return 'PARTIALLY_ACCEPTED';
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Both parties see a receipt: the buyer wrote it, the vendor must act on it. */
export async function loadGrn(actor: Actor, id: string): Promise<GrnWithRelations> {
  const scope = scopeToParty(actor);
  const grn = await prisma.grn.findFirst({
    where: {
      id,
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      ...(scope.vendorId ? { purchaseOrder: { vendorId: scope.vendorId } } : {}),
    },
    include: withRelations,
  });
  if (!grn) throw NotFound('Goods receipt');
  return grn;
}

export async function listGrns(actor: Actor, query: GrnQuery) {
  const scope = scopeToParty(actor);
  const where: Prisma.GrnWhereInput = {
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scope.vendorId ? { purchaseOrder: { vendorId: scope.vendorId } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.grn.findMany({
      where,
      include: withRelations,
      orderBy: { receivedAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.grn.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

/** Org-scoped, and receivable only against an accepted order. */
async function loadReceivablePo(
  actor: Actor,
  purchaseOrderId: string,
): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, ...scopeToOrg(actor) },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });
  if (!po) throw NotFound('Purchase order');

  if (po.status !== 'ACCEPTED') {
    throw BusinessRule(
      'grn.po_not_accepted',
      `Goods can only be received against an ACCEPTED order; this one is ${po.status}`,
    );
  }
  return po;
}

/**
 * The prefilled capture screen (plan 11 §3).
 *
 * `suggestedReceive` is what the open challans say is on its way, capped at what
 * is still pending — an officer holding a delivery note should not have to type
 * an item list, and should not be nudged into over-receiving either.
 */
export async function getReceivable(actor: Actor, purchaseOrderId: string): Promise<ReceivableDto> {
  const po = await loadReceivablePo(actor, purchaseOrderId);

  const openDeliveries = await prisma.delivery.findMany({
    where: { purchaseOrderId, status: { in: OPEN_DELIVERY_STATUSES } },
    include: { items: true },
    orderBy: { dispatchedAt: 'asc' },
  });

  const dispatched = await dispatchedByItem(prisma, purchaseOrderId);

  const lines: ReceivableLineDto[] = po.items.map((item) => {
    const ordered = money(item.quantity);
    const received = money(item.receivedQuantity);
    const pendingRaw = ordered.minus(received);
    const pending = pendingRaw.isNegative() ? ZERO : pendingRaw;

    // Already-receipted quantity is excluded, so a second GRN against the same
    // challan suggests only what is genuinely left.
    const claimed = (dispatched.get(item.id) ?? ZERO).minus(received);
    const inTransit = claimed.isNegative() ? ZERO : claimed;
    const suggested = inTransit.greaterThan(pending) ? pending : inTransit;

    return {
      purchaseOrderItemId: item.id,
      srNo: item.srNo,
      description: item.description,
      unit: item.unit,
      ordered: qtyToApi(ordered),
      alreadyReceived: qtyToApi(received),
      pending: qtyToApi(pending),
      suggestedReceive: qtyToApi(suggested),
    };
  });

  return {
    purchaseOrder: {
      id: po.id,
      poNumber: po.poNumber,
      vendorName: po.vendorName,
      status: po.status,
      fulfilmentStatus: po.fulfilmentStatus,
    },
    openDeliveries: openDeliveries.map((delivery) => ({
      id: delivery.id,
      challanNumber: delivery.challanNumber,
      status: delivery.status,
      dispatchedAt: delivery.dispatchedAt.toISOString(),
      expectedAt: delivery.expectedAt?.toISOString() ?? null,
      items: delivery.items.map((item) => ({
        purchaseOrderItemId: item.purchaseOrderItemId,
        quantity: qtyToApi(item.quantity),
      })),
    })),
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* Guards (plan 11 §3)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Guard 2 — `accepted + rejected === received`, exactly.
 *
 * Checked here with decimal arithmetic, and again by the
 * `grn_quantity_reconciles` CHECK constraint in the database (02 §8). Belt and
 * braces on purpose: this is the invariant that makes "payment only after
 * delivery confirmation" mean something, and a receipt whose numbers do not add
 * up would let quantity appear or vanish.
 */
function assertReconciles(items: GrnItemInput[]): void {
  for (const item of items) {
    const received = money(item.receivedQuantity);
    const accepted = money(item.acceptedQuantity);
    const rejected = money(item.rejectedQuantity);

    if (!accepted.plus(rejected).equals(received)) {
      throw BusinessRule(
        'grn.quantity_mismatch',
        `Accepted ${qtyToApi(accepted)} plus rejected ${qtyToApi(rejected)} must equal received ${qtyToApi(received)}`,
      );
    }
  }
}

/** Guard 3 — refusing goods without saying why gives the vendor nothing to fix. */
function assertRejectionsExplained(items: GrnItemInput[]): void {
  for (const item of items) {
    if (!money(item.rejectedQuantity).greaterThan(0)) continue;

    const reason = (item.rejectionReason ?? '').trim();
    if (reason.length < GRN_REJECTION_REASON_MIN_LENGTH) {
      throw BusinessRule(
        'grn.rejection_reason_required',
        `Rejecting goods needs a reason of at least ${GRN_REJECTION_REASON_MIN_LENGTH} characters`,
      );
    }
  }
}

/** Guard 5 — not in the future, and not before the order was issued. */
function assertReceivedDate(receivedAt: Date, po: PurchaseOrder): void {
  if (receivedAt.getTime() > Date.now() + 60_000) {
    throw BusinessRule('grn.invalid_date', 'The receipt date cannot be in the future');
  }
  if (po.issuedAt && receivedAt.getTime() < po.issuedAt.getTime()) {
    throw BusinessRule(
      'grn.invalid_date',
      'Goods cannot be received before the purchase order was issued',
    );
  }
}

/** Guard 6 — the challan belongs to this order and has something left on it. */
async function assertDeliveryUsable(
  tx: Prisma.TransactionClient,
  deliveryId: string,
  purchaseOrderId: string,
): Promise<void> {
  const delivery = await tx.delivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.purchaseOrderId !== purchaseOrderId) {
    throw BusinessRule('grn.delivery_mismatch', 'That delivery does not belong to this order');
  }
  if (delivery.status === 'CANCELLED') {
    throw BusinessRule('grn.delivery_mismatch', 'That delivery was cancelled');
  }
  if (delivery.status === 'DELIVERED') {
    throw BusinessRule(
      'grn.delivery_mismatch',
      'That delivery has already been fully receipted',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The confirm transaction (plan 11 §4)                                       */
/* -------------------------------------------------------------------------- */

interface LockedLine {
  id: string;
  srNo: number;
  quantity: Decimal;
  receivedQuantity: Decimal;
}

/**
 * Record a goods receipt.
 *
 * The concurrency-sensitive part of the module. Two officers receipting the same
 * delivery at the same moment must not double-count, so the order lines are
 * locked with `FOR UPDATE` **before** the cumulative check, and the check reads
 * the locked values rather than anything fetched earlier. The second transaction
 * waits at the lock, then sees the first one's committed quantity and is refused.
 */
export async function createGrn(
  actor: Actor,
  purchaseOrderId: string,
  input: CreateGrnInput,
  ctx: RefreshContext,
) {
  const po = await loadReceivablePo(actor, purchaseOrderId);
  const receivedAt = new Date(input.receivedAt);

  assertReconciles(input.items);
  assertRejectionsExplained(input.items);
  assertReceivedDate(receivedAt, po);

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: po.organizationId },
  });
  const settings = getSettings(organization);
  const auditActor = auditActorOf(actor, ctx);

  const result = await prisma.$transaction(async (tx) => {
    if (input.deliveryId) {
      await assertDeliveryUsable(tx, input.deliveryId, purchaseOrderId);
    }

    // 1. Lock the order lines. A concurrent receipt on the same lines waits here.
    const ids = input.items.map((item) => item.purchaseOrderItemId);
    const locked = await tx.$queryRaw<LockedLine[]>`
      SELECT id, "srNo", quantity, "receivedQuantity"
      FROM purchase_order_items
      WHERE id = ANY(${ids}::uuid[]) AND "purchaseOrderId" = ${purchaseOrderId}::uuid
      FOR UPDATE`;

    if (locked.length !== ids.length) {
      throw BusinessRule(
        'grn.invalid_item',
        'One or more lines do not belong to this purchase order',
      );
    }

    // 2. Guard 4, cumulative, against the LOCKED values.
    for (const line of input.items) {
      const poItem = locked.find((row) => row.id === line.purchaseOrderItemId)!;
      const alreadyReceived = money(poItem.receivedQuantity);
      const total = alreadyReceived.plus(money(line.receivedQuantity));

      if (total.greaterThan(money(poItem.quantity))) {
        throw BusinessRule(
          'grn.exceeds_ordered',
          `Line ${poItem.srNo}: receiving ${qtyToApi(line.receivedQuantity)} on top of ${qtyToApi(alreadyReceived)} exceeds the ordered ${qtyToApi(poItem.quantity)}`,
        );
      }
    }

    // 3. The receipt itself, with its status derived from the quantities.
    const grnNumber = await nextNumber(tx, po.organizationId, 'GRN', {
      prefix: settings.numberPrefixes.GRN,
    });

    const grn = await tx.grn.create({
      data: {
        organizationId: po.organizationId,
        purchaseOrderId,
        deliveryId: input.deliveryId ?? null,
        grnNumber,
        status: deriveGrnStatus(input.items),
        receivedById: actor.userId,
        receivedAt,
        remarks: input.remarks ?? null,
        items: {
          create: input.items.map((item) => ({
            purchaseOrderItemId: item.purchaseOrderItemId,
            receivedQuantity: item.receivedQuantity,
            acceptedQuantity: item.acceptedQuantity,
            rejectedQuantity: item.rejectedQuantity,
            rejectionReason: item.rejectionReason ?? null,
          })),
        },
      },
      include: withRelations,
    });

    // 4. Move the running totals. Rejected units are deliberately NOT added to
    //    acceptedQuantity: they are not received goods and cannot be invoiced.
    for (const line of input.items) {
      await tx.purchaseOrderItem.update({
        where: { id: line.purchaseOrderItemId },
        data: {
          receivedQuantity: { increment: line.receivedQuantity },
          acceptedQuantity: { increment: line.acceptedQuantity },
        },
      });
    }

    // 5. Recompute the order's derived fulfilment. It never touches `status`:
    //    fulfilment and contract lifecycle are separate axes, and the order only
    //    reaches CLOSED when plan 13 confirms it is paid too.
    const updatedPo = await recomputeFulfilment(tx, purchaseOrderId);

    // 6. A challan that has now been fully receipted is DELIVERED.
    if (input.deliveryId) {
      await maybeMarkDelivered(tx, input.deliveryId, auditActor);
    }

    const rejected = input.items.filter((item) => money(item.rejectedQuantity).greaterThan(0));

    await writeAudit(tx, {
      action: 'grn.recorded',
      entityType: 'Grn',
      entityId: grn.id,
      severity: 'NOTABLE',
      summary: `${actor.email} recorded ${grnNumber} against ${po.poNumber} (${grn.status})`,
      organizationId: po.organizationId,
      vendorId: po.vendorId,
      actor: auditActor,
      after: {
        grnNumber,
        status: grn.status,
        received: qtyToApi(sum(input.items.map((item) => money(item.receivedQuantity)))),
        accepted: qtyToApi(sum(input.items.map((item) => money(item.acceptedQuantity)))),
        rejected: qtyToApi(sum(input.items.map((item) => money(item.rejectedQuantity)))),
        fulfilmentStatus: updatedPo.fulfilmentStatus,
      },
    });

    /* ----------------------------------------------------------- notifications */

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: po.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });
    const admins = await tx.user.findMany({
      where: { organizationId: po.organizationId, status: 'ACTIVE', role: 'ORG_ADMIN' },
      select: { id: true, email: true },
    });

    const accepted = qtyToApi(sum(input.items.map((item) => money(item.acceptedQuantity))));
    const refused = qtyToApi(sum(input.items.map((item) => money(item.rejectedQuantity))));

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'GRN_RECORDED',
        title: `Goods receipt ${grnNumber}`,
        body: `${po.buyerName} recorded ${grnNumber} against ${po.poNumber}: ${accepted} accepted, ${refused} rejected.`,
        entityType: 'Grn',
        entityId: grn.id,
        link: `/vendor/grns/${grn.id}`,
      },
    );

    // A rejection is the one event here that always reaches a human inbox.
    if (rejected.length > 0) {
      const reasons = rejected
        .map((item) => {
          const poItem = locked.find((row) => row.id === item.purchaseOrderItemId)!;
          return `line ${poItem.srNo}: ${qtyToApi(item.rejectedQuantity)} — ${item.rejectionReason}`;
        })
        .join('; ');

      await notifyMany(
        tx,
        [...vendorUsers, ...admins].map((u) => u.id),
        {
          type: 'GRN_REJECTION',
          title: `Goods rejected on ${grnNumber}`,
          body: `${po.poNumber}: ${reasons}`,
          entityType: 'Grn',
          entityId: grn.id,
          link: `/grns/${grn.id}`,
        },
      );
    }

    // The order is fully received. `PO_FULFILLED` is not a NotificationType, so
    // this rides on GRN_RECORDED with its own title rather than inventing one.
    if (updatedPo.fulfilmentStatus === 'FULFILLED') {
      await notifyMany(
        tx,
        [...vendorUsers, ...admins].map((u) => u.id),
        {
          type: 'GRN_RECORDED',
          title: `${po.poNumber} fully received`,
          body: `Every line on ${po.poNumber} has now been received.`,
          entityType: 'PurchaseOrder',
          entityId: po.id,
          link: `/purchase-orders/${po.id}/fulfilment`,
        },
      );
    }

    return { grn, vendorUsers, admins, rejected, reasonsFor: locked };
  });

  if (result.rejected.length > 0) {
    emailAfterCommit(
      [...result.vendorUsers, ...result.admins],
      `Goods rejected on ${result.grn.grnNumber}`,
      `Some goods against ${po.poNumber} were rejected. See the receipt for the reasons.`,
    );
  }

  return loadGrn(actor, result.grn.id);
}

/* -------------------------------------------------------------------------- */
/* Short close (plan 11 §5)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write off the undelivered remainder of an order.
 *
 * Reached when a vendor cannot replace rejected or short-supplied goods. It is a
 * financial decision — contracted goods are being given up — so it needs
 * `PO_ISSUE` (an `ORG_ADMIN`), a real reason, and a NOTABLE audit row carrying
 * the written-off quantity and its value.
 *
 * `SHORT_CLOSED` is deliberately not derivable from quantities, which is why
 * `recomputeFulfilment` leaves it alone once set: no accumulation of receipts
 * should ever undo a decision somebody signed.
 */
export async function shortClosePo(
  actor: Actor,
  purchaseOrderId: string,
  reason: string,
  ctx: RefreshContext,
) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, ...scopeToOrg(actor) },
    include: { items: true },
  });
  if (!po) throw NotFound('Purchase order');

  if (po.status !== 'ACCEPTED') {
    throw BusinessRule(
      'po.invalid_transition',
      `Only an ACCEPTED order can be short-closed; this one is ${po.status}`,
    );
  }
  if (po.fulfilmentStatus === 'SHORT_CLOSED') {
    throw BusinessRule('po.already_short_closed', 'This order has already been short-closed');
  }
  if (po.fulfilmentStatus === 'FULFILLED') {
    throw BusinessRule(
      'po.nothing_outstanding',
      'Every line has been received; there is nothing to write off',
    );
  }

  // What is being given up, by quantity and by value.
  let writtenOffQuantity = ZERO;
  let writtenOffValue = ZERO;

  for (const item of po.items) {
    const ordered = money(item.quantity);
    const received = money(item.receivedQuantity);
    const shortfall = ordered.minus(received);
    if (!shortfall.greaterThan(0)) continue;

    writtenOffQuantity = writtenOffQuantity.plus(shortfall);
    // Apportion the line total by the share never delivered.
    if (ordered.greaterThan(0)) {
      writtenOffValue = writtenOffValue.plus(
        money(item.lineTotal).mul(shortfall).div(ordered),
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { fulfilmentStatus: 'SHORT_CLOSED' },
    });

    await writeAudit(tx, {
      action: 'po.short_closed',
      entityType: 'PurchaseOrder',
      entityId: purchaseOrderId,
      severity: 'NOTABLE',
      summary: `${actor.email} short-closed ${po.poNumber}, writing off ${qtyToApi(writtenOffQuantity)} unit(s) worth ${toApi(round2(writtenOffValue))}: ${reason}`,
      organizationId: po.organizationId,
      vendorId: po.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { fulfilmentStatus: po.fulfilmentStatus },
      after: {
        fulfilmentStatus: 'SHORT_CLOSED',
        writtenOffQuantity: qtyToApi(writtenOffQuantity),
        writtenOffValue: toApi(round2(writtenOffValue)),
        reason,
      },
    });

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: po.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'GRN_RECORDED',
        title: `${po.poNumber} short-closed`,
        body: `${po.buyerName} short-closed ${po.poNumber}, writing off ${qtyToApi(writtenOffQuantity)} undelivered unit(s): ${reason}`,
        entityType: 'PurchaseOrder',
        entityId: po.id,
        link: `/vendor/purchase-orders/${po.id}`,
      },
    );
  });

  return prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: { items: { orderBy: { srNo: 'asc' } } },
  });
}
