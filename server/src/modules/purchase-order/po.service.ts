import type { Organization, Prisma, Quotation, Tender, Vendor } from '@prisma/client';
import type {
  AmendPoInput,
  CreateDirectPoInput,
  DirectPoItemInput,
  PoQuery,
  TaxRegime,
} from '@tb/shared';
import { writeAudit, type AuditActor } from '../../lib/audit.js';
import { BusinessRule, NotFound } from '../../lib/errors.js';
import { money, round2, toApi, type Decimal } from '../../lib/money.js';
import { emailAfterCommit, notifyMany } from '../../lib/notify.js';
import { nextNumber } from '../../lib/numbering.js';
import { prisma } from '../../lib/prisma.js';
import { scopeToOrg, scopeToParty, scopeToVendor } from '../../lib/scope.js';
import { computeLineTax, regimeForSupply, sumPoTotals, type TaxedLine } from '../../lib/tax.js';
import type { Actor } from '../../middleware/authenticate.js';
import type { RefreshContext } from '../auth/token.service.js';
import { registerAwardHook } from '../approval/approval.service.js';
import { getSettings } from '../organization/organization.service.js';
import { transitionQuotation } from '../quotation/quotation.stateMachine.js';
import { transitionTender } from '../tender/tender.stateMachine.js';
import { buildFulfilment, recomputeFulfilment } from './fulfilment.service.js';
import { isAwaitingResponse, type PoWithItems } from './po.serializers.js';
import { assertPoEditable, transitionPo } from './po.stateMachine.js';

const auditActorOf = (actor: Actor, ctx: RefreshContext = {}): AuditActor => ({
  userId: actor.userId,
  email: actor.email,
  role: actor.role,
  ipAddress: ctx.ipAddress ?? null,
  userAgent: ctx.userAgent ?? null,
});

const withItems = { items: { orderBy: { srNo: 'asc' } } } as const;

/** One address string for the frozen snapshot, built the way a document prints it. */
export function formatAddress(party: {
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  pincode: string;
}): string {
  return [party.addressLine1, party.addressLine2, `${party.city}, ${party.state} ${party.pincode}`]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n');
}

const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * 86_400_000);

/**
 * Narrow any priced line — a stored row or a freshly computed one — to what the
 * totals function needs. Written out rather than cast: a cast here would hide a
 * renamed column and silently total a document with a missing tax head.
 */
const asTaxedLine = (line: {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPercent: Decimal.Value;
  taxableValue: Decimal.Value;
  cgstAmount: Decimal.Value;
  sgstAmount: Decimal.Value;
  igstAmount: Decimal.Value;
}): TaxedLine => ({
  quantity: line.quantity,
  unitPrice: line.unitPrice,
  discountPercent: line.discountPercent,
  taxableValue: line.taxableValue,
  cgstAmount: line.cgstAmount,
  sgstAmount: line.sgstAmount,
  igstAmount: line.igstAmount,
});

/* -------------------------------------------------------------------------- */
/* Generation from an award (10 §2)                                           */
/* -------------------------------------------------------------------------- */

export type TenderWithOrg = Tender & { organization: Organization };
export type QuotationForPo = Quotation & {
  vendor: Vendor;
  items: {
    tenderItemId: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    discountPercent: Prisma.Decimal;
    tenderItem: {
      description: string;
      hsnCode: string | null;
      unit: string;
      taxRatePercent: Prisma.Decimal;
    };
  }[];
};

/**
 * Turn an approved award into a purchase order.
 *
 * Called from inside plan 09's approval transaction, so a tender is never
 * `AWARDED` without an order — and if this throws, the award rolls back.
 *
 * **Everything about the two parties is snapshotted onto the row.** A purchase
 * order is a contract: if the vendor moves office next month, this order must
 * still show the address it was issued to, and above all the state code that
 * decided its tax regime. Re-deriving tax from live party rows would silently
 * change historical documents — the single most important modelling decision in
 * this module.
 */
export async function generatePoFromAward(
  tx: Prisma.TransactionClient,
  tender: TenderWithOrg,
  quotation: QuotationForPo,
  actor: AuditActor,
): Promise<PoWithItems> {
  const org = tender.organization;
  const vendor = quotation.vendor;
  const settings = getSettings(org);

  // Place of supply is where the goods land, not where the buyer sits (§3 rule 3).
  const placeOfSupply = tender.deliveryStateCode;
  const regime = regimeForSupply(vendor, placeOfSupply);

  const items = quotation.items.map((qi, index) => {
    const gross = round2(money(qi.unitPrice).mul(qi.quantity));
    const discount = round2(gross.mul(money(qi.discountPercent)).div(100));
    const taxableValue = round2(gross.minus(discount));
    const tax = computeLineTax(taxableValue, qi.tenderItem.taxRatePercent, regime);

    return {
      srNo: index + 1,
      tenderItemId: qi.tenderItemId,
      description: qi.tenderItem.description,
      hsnCode: qi.tenderItem.hsnCode,
      unit: qi.tenderItem.unit,
      quantity: qi.quantity,
      unitPrice: qi.unitPrice,
      discountPercent: qi.discountPercent,
      taxableValue: taxableValue.toFixed(2),
      taxRatePercent: qi.tenderItem.taxRatePercent,
      cgstAmount: tax.cgstAmount.toFixed(2),
      sgstAmount: tax.sgstAmount.toFixed(2),
      igstAmount: tax.igstAmount.toFixed(2),
      lineTotal: round2(
        taxableValue.plus(tax.cgstAmount).plus(tax.sgstAmount).plus(tax.igstAmount),
      ).toFixed(2),
    };
  });

  const totals = sumPoTotals(items.map(asTaxedLine), quotation.freightAmount);

  const poNumber = await nextNumber(tx, org.id, 'PURCHASE_ORDER', {
    prefix: settings.numberPrefixes.PURCHASE_ORDER,
  });

  const po = await tx.purchaseOrder.create({
    data: {
      organizationId: org.id,
      vendorId: vendor.id,
      tenderId: tender.id,
      quotationId: quotation.id,
      poNumber,
      status: 'DRAFT',

      // --- frozen party snapshot, taken now and never re-read ---
      buyerName: org.name,
      buyerGstin: org.gstin,
      buyerAddress: formatAddress(org),
      buyerStateCode: org.stateCode,
      vendorName: vendor.companyName,
      vendorGstin: vendor.gstin,
      vendorAddress: formatAddress(vendor),
      vendorStateCode: vendor.stateCode,

      placeOfSupplyStateCode: placeOfSupply,
      taxRegime: regime,

      subtotal: totals.subtotal.toFixed(2),
      discountAmount: totals.discountAmount.toFixed(2),
      taxableAmount: totals.taxableAmount.toFixed(2),
      cgstAmount: totals.cgstAmount.toFixed(2),
      sgstAmount: totals.sgstAmount.toFixed(2),
      igstAmount: totals.igstAmount.toFixed(2),
      freightAmount: totals.freightAmount.toFixed(2),
      roundOff: totals.roundOff.toFixed(2),
      totalAmount: totals.totalAmount.toFixed(2),

      expectedDeliveryDate: addDays(new Date(), quotation.deliveryDays),
      deliveryAddress: tender.deliveryLocation,
      paymentTerms:
        quotation.paymentTerms ?? `${settings.defaultPaymentTermDays} days from invoice`,
      termsAndConditions: tender.termsAndConditions,
      createdById: actor.userId ?? org.id,
      items: { create: items },
    },
    include: withItems,
  });

  await writeAudit(tx, {
    action: 'po.generated',
    entityType: 'PurchaseOrder',
    entityId: po.id,
    severity: 'NOTABLE',
    summary: `${poNumber} generated for ${vendor.companyName} from ${tender.referenceNumber || tender.title} (${toApi(po.totalAmount)})`,
    organizationId: org.id,
    vendorId: vendor.id,
    actor,
    after: {
      poNumber,
      taxRegime: regime,
      placeOfSupplyStateCode: placeOfSupply,
      totalAmount: toApi(po.totalAmount),
      items: items.length,
    },
  });

  return po;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A purchase order carries both party ids, so each side reads it through their
 * own — `scopeToParty` picks whichever the actor has. There is no code path that
 * loads one by id alone.
 */
export async function loadPo(actor: Actor, id: string): Promise<PoWithItems> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id, ...scopeToParty(actor) },
    include: withItems,
  });
  if (!po) throw NotFound('Purchase order');
  return po;
}

export async function responseWindowFor(organizationId: string): Promise<number> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  return getSettings(org).expectedResponseDays;
}

export async function listPos(actor: Actor, query: PoQuery, side: 'buyer' | 'vendor') {
  const where: Prisma.PurchaseOrderWhereInput = {
    ...(side === 'buyer' ? scopeToOrg(actor) : scopeToVendor(actor)),
    ...(query.status ? { status: query.status } : {}),
    ...(query.fulfilmentStatus ? { fulfilmentStatus: query.fulfilmentStatus } : {}),
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.tenderId ? { tenderId: query.tenderId } : {}),
    ...(query.q
      ? {
          OR: [
            { poNumber: { contains: query.q, mode: 'insensitive' } },
            { vendorName: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
    // A vendor has no business seeing an order that was never issued to them.
    ...(side === 'vendor' ? { status: { not: 'DRAFT' } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: withItems,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);

  return { rows, total, page: query.page, limit: query.limit };
}

export async function getFulfilment(actor: Actor, id: string) {
  return buildFulfilment(await loadPo(actor, id));
}

/* -------------------------------------------------------------------------- */
/* Issue (10 §5)                                                              */
/* -------------------------------------------------------------------------- */

/** A blacklisted or rejected vendor cannot be sent new work. */
function assertVendorIssuable(vendor: Pick<Vendor, 'status' | 'companyName'>): void {
  if (vendor.status === 'BLACKLISTED' || vendor.status === 'REJECTED') {
    throw BusinessRule(
      'po.vendor_not_permitted',
      `${vendor.companyName} is ${vendor.status} and cannot be issued a purchase order`,
    );
  }
}

/** Every line must be orderable: a positive quantity and a non-negative taxable value. */
function assertLinesIssuable(items: { srNo: number; quantity: Decimal; taxableValue: Decimal }[]): void {
  if (items.length === 0) {
    throw BusinessRule('po.no_items', 'A purchase order needs at least one line');
  }
  for (const item of items) {
    if (!money(item.quantity).greaterThan(0)) {
      throw BusinessRule('po.invalid_quantity', `Line ${item.srNo} has no quantity`);
    }
    if (money(item.taxableValue).isNegative()) {
      throw BusinessRule('po.invalid_amount', `Line ${item.srNo} has a negative taxable value`);
    }
  }
}

export async function issuePo(actor: Actor, id: string, ctx: RefreshContext) {
  await loadPo(actor, id);

  const issued = await prisma.$transaction(async (tx) => {
    /*
     * Two concurrent issue calls would both read DRAFT and both transition. The
     * row lock makes the second wait, then fail `po.invalid_transition` — one
     * order goes out, not two with two numbers on the vendor's desk.
     */
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;

    const po = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });

    const vendor = await tx.vendor.findUniqueOrThrow({
      where: { id: po.vendorId },
      select: { id: true, status: true, companyName: true },
    });
    assertVendorIssuable(vendor);
    assertLinesIssuable(po.items);

    const now = new Date();
    const result = await transitionPo(tx, po, 'ISSUED', auditActorOf(actor, ctx), {
      action: 'po.issued',
      summary: `${actor.email} issued ${po.poNumber} to ${vendor.companyName} for ${toApi(po.totalAmount)}`,
      data: { issuedAt: now, rejectedAt: null, rejectionReason: null },
      after: { totalAmount: toApi(po.totalAmount), issuedAt: now.toISOString() },
    });

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: po.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    // The amount is included on purpose: the seal is over, and the vendor
    // quoted this figure themselves.
    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'PO_ISSUED',
        title: `Purchase order ${po.poNumber}`,
        body: `${po.buyerName} issued ${po.poNumber} for ${toApi(po.totalAmount)}. Please accept or reject it.`,
        entityType: 'PurchaseOrder',
        entityId: po.id,
        link: `/vendor/purchase-orders/${po.id}`,
      },
    );

    return { po: result, vendorUsers };
  });

  emailAfterCommit(
    issued.vendorUsers,
    `Purchase order ${issued.po.poNumber}`,
    `A purchase order for ${toApi(issued.po.totalAmount)} has been issued to you.`,
  );

  return loadPo(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Vendor response (10 §5)                                                    */
/* -------------------------------------------------------------------------- */

export async function acceptPo(actor: Actor, id: string, note: string | undefined, ctx: RefreshContext) {
  const loaded = await loadPo(actor, id);

  const accepted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;

    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    if (po.status !== 'ISSUED') {
      throw BusinessRule('po.invalid_transition', `A ${po.status} purchase order cannot be accepted`);
    }

    const result = await transitionPo(tx, po, 'ACCEPTED', auditActorOf(actor, ctx), {
      action: 'po.accepted',
      summary: `${loaded.vendorName} accepted ${po.poNumber}${note ? `: ${note}` : ''}`,
      data: { acceptedAt: new Date() },
      after: { totalAmount: toApi(po.totalAmount), ...(note ? { note } : {}) },
    });

    const buyers = await tx.user.findMany({
      where: {
        organizationId: po.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      buyers.map((u) => u.id),
      {
        type: 'PO_ACCEPTED',
        title: `Purchase order ${po.poNumber} accepted`,
        body: `${po.vendorName} accepted ${po.poNumber}. Delivery is expected by ${po.expectedDeliveryDate.toISOString().slice(0, 10)}.`,
        entityType: 'PurchaseOrder',
        entityId: po.id,
        link: `/purchase-orders/${po.id}`,
      },
    );

    return { po: result, buyers };
  });

  emailAfterCommit(
    accepted.buyers,
    `Purchase order ${accepted.po.poNumber} accepted`,
    `${accepted.po.vendorName} accepted the order.`,
  );

  return loadPo(actor, id);
}

/**
 * Rejection needs a reason. It is not a dead end: the buyer may amend and
 * reissue the same order, or cancel it and re-award the tender to the runner-up.
 */
export async function rejectPo(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  const loaded = await loadPo(actor, id);

  const rejected = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;

    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    if (po.status !== 'ISSUED') {
      throw BusinessRule('po.invalid_transition', `A ${po.status} purchase order cannot be rejected`);
    }

    const result = await transitionPo(tx, po, 'REJECTED', auditActorOf(actor, ctx), {
      action: 'po.rejected',
      severity: 'NOTABLE',
      summary: `${loaded.vendorName} rejected ${po.poNumber}: ${reason}`,
      data: { rejectedAt: new Date(), rejectionReason: reason },
      reason,
    });

    const buyers = await tx.user.findMany({
      where: {
        organizationId: po.organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] },
      },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      buyers.map((u) => u.id),
      {
        type: 'PO_REJECTED',
        title: `Purchase order ${po.poNumber} rejected`,
        body: `${po.vendorName} rejected ${po.poNumber}: ${reason}`,
        entityType: 'PurchaseOrder',
        entityId: po.id,
        link: `/purchase-orders/${po.id}`,
      },
    );

    return { po: result, buyers };
  });

  emailAfterCommit(
    rejected.buyers,
    `Purchase order ${rejected.po.poNumber} rejected`,
    `Reason: ${reason}`,
  );

  return loadPo(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Amend and reissue (10 §5)                                                  */
/* -------------------------------------------------------------------------- */

/** Re-tax and re-total a replacement line set under the order's frozen regime. */
function priceDirectItems(items: DirectPoItemInput[], regime: TaxRegime, freight: Decimal.Value) {
  const priced = items.map((item) => {
    const gross = round2(money(item.unitPrice).mul(item.quantity));
    const discount = round2(gross.mul(money(item.discountPercent)).div(100));
    const taxableValue = round2(gross.minus(discount));
    const tax = computeLineTax(taxableValue, item.taxRatePercent, regime);

    return {
      srNo: item.srNo,
      tenderItemId: null,
      description: item.description,
      hsnCode: item.hsnCode ?? null,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      taxableValue: taxableValue.toFixed(2),
      taxRatePercent: item.taxRatePercent,
      cgstAmount: tax.cgstAmount.toFixed(2),
      sgstAmount: tax.sgstAmount.toFixed(2),
      igstAmount: tax.igstAmount.toFixed(2),
      lineTotal: round2(
        taxableValue.plus(tax.cgstAmount).plus(tax.sgstAmount).plus(tax.igstAmount),
      ).toFixed(2),
    };
  });

  const totals = sumPoTotals(priced.map(asTaxedLine), freight);
  return { priced, totals };
}

const totalsData = (totals: ReturnType<typeof sumPoTotals>) => ({
  subtotal: totals.subtotal.toFixed(2),
  discountAmount: totals.discountAmount.toFixed(2),
  taxableAmount: totals.taxableAmount.toFixed(2),
  cgstAmount: totals.cgstAmount.toFixed(2),
  sgstAmount: totals.sgstAmount.toFixed(2),
  igstAmount: totals.igstAmount.toFixed(2),
  freightAmount: totals.freightAmount.toFixed(2),
  roundOff: totals.roundOff.toFixed(2),
  totalAmount: totals.totalAmount.toFixed(2),
});

/**
 * Amend a DRAFT or REJECTED order.
 *
 * The tax regime is **not** recomputed: it was frozen when the order was
 * created, from the party state codes as they stood then. Amending a quantity
 * must not quietly re-decide whether the supply is inter-state.
 */
export async function amendPo(actor: Actor, id: string, input: AmendPoInput, ctx: RefreshContext) {
  const po = await loadPo(actor, id);
  assertPoEditable(po);

  await prisma.$transaction(async (tx) => {
    const freight = input.freightAmount ?? po.freightAmount;
    let data: Prisma.PurchaseOrderUpdateInput = {
      ...(input.expectedDeliveryDate
        ? { expectedDeliveryDate: new Date(input.expectedDeliveryDate) }
        : {}),
      ...(input.deliveryAddress !== undefined ? { deliveryAddress: input.deliveryAddress } : {}),
      ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
      ...(input.termsAndConditions !== undefined
        ? { termsAndConditions: input.termsAndConditions }
        : {}),
    };

    if (input.items) {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      const { priced, totals } = priceDirectItems(input.items, po.taxRegime, freight);
      data = { ...data, ...totalsData(totals), items: { create: priced } };
    } else if (input.freightAmount !== undefined) {
      // Freight moved but the lines did not: re-total off the stored lines.
      data = { ...data, ...totalsData(sumPoTotals(po.items.map(asTaxedLine), freight)) };
    }

    await tx.purchaseOrder.update({ where: { id }, data });

    await writeAudit(tx, {
      action: 'po.amended',
      entityType: 'PurchaseOrder',
      entityId: id,
      severity: 'NOTABLE',
      summary: `${actor.email} amended ${po.poNumber} while ${po.status}`,
      organizationId: po.organizationId,
      vendorId: po.vendorId,
      actor: auditActorOf(actor, ctx),
      before: { status: po.status, totalAmount: toApi(po.totalAmount) },
      after: { fields: Object.keys(input) },
    });
  });

  return loadPo(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Cancel (10 §5)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Cancelling releases the `one_active_po_per_quotation` partial index, which is
 * what lets the buyer return the tender to `UNDER_EVALUATION` and award the
 * runner-up. That is the real-world path when a vendor backs out.
 */
export async function cancelPo(actor: Actor, id: string, reason: string, ctx: RefreshContext) {
  await loadPo(actor, id);

  const cancelled = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;

    const po = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });

    // Goods already in the building cannot be un-ordered by cancelling paperwork.
    const received = po.items.some((item) => money(item.receivedQuantity).greaterThan(0));
    if (received) {
      throw BusinessRule(
        'po.already_received',
        'Goods have already been received against this order; short-close it instead',
      );
    }

    const result = await transitionPo(tx, po, 'CANCELLED', auditActorOf(actor, ctx), {
      action: 'po.cancelled',
      severity: 'SECURITY',
      summary: `${actor.email} cancelled ${po.poNumber}: ${reason}`,
      data: { cancelledAt: new Date(), cancellationReason: reason },
      reason,
    });

    // Cancelling a tender-linked order frees the tender to be re-awarded.
    if (po.tenderId) {
      await reopenTenderForReaward(
        tx,
        po.tenderId,
        po.quotationId,
        reason,
        auditActorOf(actor, ctx),
      );
    }

    const vendorUsers = await tx.user.findMany({
      where: { vendorId: po.vendorId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });

    await notifyMany(
      tx,
      vendorUsers.map((u) => u.id),
      {
        type: 'PO_REJECTED',
        title: `Purchase order ${po.poNumber} cancelled`,
        body: `${po.buyerName} cancelled ${po.poNumber}: ${reason}`,
        entityType: 'PurchaseOrder',
        entityId: po.id,
        link: `/vendor/purchase-orders/${po.id}`,
      },
    );

    return { po: result, vendorUsers };
  });

  emailAfterCommit(
    cancelled.vendorUsers,
    `Purchase order ${cancelled.po.poNumber} cancelled`,
    `Reason: ${reason}`,
  );

  return loadPo(actor, id);
}

/* -------------------------------------------------------------------------- */
/* Re-award after a cancellation (10 §5)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Return a tender to evaluation so the runner-up can be awarded.
 *
 * This is the real-world path when a winning vendor backs out: the buyer cancels
 * the order, and cancelling releases the `one_active_po_per_quotation` partial
 * index so a replacement order can later be raised against a different bid.
 *
 * Three state changes, each deliberate:
 *   - the tender goes back to UNDER_EVALUATION with its award cleared;
 *   - the bid that backed out is REJECTED rather than returned to the pool — it
 *     won once and walked away, and it must not be able to win again;
 *   - every other bid returns from LOST to SUBMITTED, so the next scoring run
 *     normalises over the real remaining field rather than a field of one.
 */
async function reopenTenderForReaward(
  tx: Prisma.TransactionClient,
  tenderId: string,
  cancelledQuotationId: string | null,
  reason: string,
  actor: AuditActor,
): Promise<void> {
  const tender = await tx.tender.findUnique({ where: { id: tenderId } });
  if (!tender || tender.status !== 'AWARDED') return;

  if (cancelledQuotationId) {
    const winner = await tx.quotation.findUnique({ where: { id: cancelledQuotationId } });
    if (winner && winner.status === 'AWARDED') {
      await transitionQuotation(tx, winner, 'REJECTED', actor, {
        action: 'quotation.award_withdrawn',
        organizationId: tender.organizationId,
        summary: `Bid ${winner.referenceNumber || winner.id} lost its award after the purchase order was cancelled: ${reason}`,
        reason,
      });
    }
  }

  const others = await tx.quotation.findMany({
    where: { tenderId, isLatest: true, status: 'LOST' },
  });
  for (const bid of others) {
    await transitionQuotation(tx, bid, 'SUBMITTED', actor, {
      action: 'quotation.returned_to_pool',
      organizationId: tender.organizationId,
      severity: 'INFO',
      summary: `Bid ${bid.referenceNumber || bid.id} returned to the pool for re-award`,
    });
  }

  await transitionTender(tx, tender, 'UNDER_EVALUATION', actor, {
    action: 'tender.reopened_for_reaward',
    severity: 'SECURITY',
    summary: `${actor.email ?? 'system'} reopened ${tender.referenceNumber || tender.title} for re-award: ${reason}`,
    reason,
    data: {
      awardedQuotationId: null,
      awardedAt: null,
      recommendedQuotationId: null,
      recommendationNote: null,
      recommendedById: null,
      recommendedAt: null,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Plan 09 award seam                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fill in plan 09's `registerAwardHook` seam.
 *
 * It runs inside the approval transaction, so an award and its purchase order
 * are one unit: if generation throws, the award rolls back and no tender is ever
 * left marked AWARDED with no order behind it (09 §7).
 *
 * The hook re-reads what it needs rather than trusting what it was handed: the
 * approval path passes a plain tender and quotation, and generation needs the
 * organization, the vendor, and every line's tender item.
 */
export function installAwardHook(): void {
  registerAwardHook(async (tx, { tender, quotation, actor }) => {
    const full = await tx.tender.findUniqueOrThrow({
      where: { id: tender.id },
      include: { organization: true },
    });
    const priced = await tx.quotation.findUniqueOrThrow({
      where: { id: quotation.id },
      include: { vendor: true, items: { include: { tenderItem: true } } },
    });

    await generatePoFromAward(tx, full, priced, actor);
  });
}

/* -------------------------------------------------------------------------- */
/* Direct purchase orders (10 §7)                                             */
/* -------------------------------------------------------------------------- */

/**
 * A purchase order with no tender behind it, for repeat or low-value buying.
 *
 * Guards: the vendor is APPROVED, and the amount is either under the approval
 * threshold or already covered by an approved `Approval`. The justification is
 * the only record of why this purchase skipped a tender, so it goes in the audit
 * row rather than a column nobody reads.
 */
export async function createDirectPo(actor: Actor, input: CreateDirectPoInput, ctx: RefreshContext) {
  if (!actor.organizationId) throw NotFound('Organization');

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.organizationId },
  });
  const settings = getSettings(org);

  const vendor = await prisma.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw NotFound('Vendor');
  if (vendor.status !== 'APPROVED') {
    throw BusinessRule(
      'po.vendor_not_approved',
      `${vendor.companyName} is ${vendor.status}; only an approved vendor can be issued an order`,
    );
  }

  const regime = regimeForSupply(vendor, input.placeOfSupplyStateCode);
  const { priced, totals } = priceDirectItems(input.items, regime, input.freightAmount);

  /*
   * A direct order is only allowed below the approval threshold.
   *
   * Plan 10 §7 also permits one backed by an existing `Approval`, but
   * `ApprovalEntity` has no value for a direct purchase order — only
   * TENDER_AWARD, INVOICE and PAYMENT — so there is no honest row to look for.
   * Inventing one (a TENDER_AWARD approval whose entityId is a vendor) would put
   * a lie in the approval table to pass a guard. Above the threshold the buyer
   * runs a tender, which is the control the threshold exists to enforce.
   */
  if (totals.totalAmount.greaterThanOrEqualTo(settings.approvalThresholdAmount)) {
    throw BusinessRule(
      'po.approval_required',
      `A direct order of ${toApi(totals.totalAmount)} is at or above the approval threshold of ${settings.approvalThresholdAmount}; raise a tender instead`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const poNumber = await nextNumber(tx, org.id, 'PURCHASE_ORDER', {
      prefix: settings.numberPrefixes.PURCHASE_ORDER,
    });

    const po = await tx.purchaseOrder.create({
      data: {
        organizationId: org.id,
        vendorId: vendor.id,
        tenderId: null,
        quotationId: null,
        poNumber,
        status: 'DRAFT',

        buyerName: org.name,
        buyerGstin: org.gstin,
        buyerAddress: formatAddress(org),
        buyerStateCode: org.stateCode,
        vendorName: vendor.companyName,
        vendorGstin: vendor.gstin,
        vendorAddress: formatAddress(vendor),
        vendorStateCode: vendor.stateCode,

        placeOfSupplyStateCode: input.placeOfSupplyStateCode,
        taxRegime: regime,
        ...totalsData(totals),

        expectedDeliveryDate: new Date(input.expectedDeliveryDate),
        deliveryAddress: input.deliveryAddress,
        paymentTerms:
          input.paymentTerms ?? `${settings.defaultPaymentTermDays} days from invoice`,
        termsAndConditions: input.termsAndConditions ?? null,
        createdById: actor.userId,
        items: { create: priced },
      },
      include: withItems,
    });

    await writeAudit(tx, {
      action: 'po.direct_created',
      entityType: 'PurchaseOrder',
      entityId: po.id,
      // SECURITY: a purchase that skipped the tender process is exactly what an
      // auditor should be able to find in one query.
      severity: 'SECURITY',
      summary: `${actor.email} created direct order ${poNumber} for ${vendor.companyName} (${toApi(po.totalAmount)}) without a tender`,
      organizationId: org.id,
      vendorId: vendor.id,
      actor: auditActorOf(actor, ctx),
      after: {
        poNumber,
        totalAmount: toApi(po.totalAmount),
        taxRegime: regime,
        justification: input.justification,
      },
    });

    return po;
  });

  return created;
}

/* -------------------------------------------------------------------------- */
/* Awaiting-response sweep (10 §5)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Flag orders the vendor has not answered inside the response window.
 *
 * **It never cancels anything.** Silently cancelling a contract because a
 * supplier was slow to click a button is wrong; both sides are reminded once and
 * the buyer decides. Deduped on the notification rows, so a vendor gets one
 * nudge per order rather than one per fifteen minutes.
 */
export async function remindAwaitingResponse(): Promise<number> {
  const issued = await prisma.purchaseOrder.findMany({
    where: { status: 'ISSUED', issuedAt: { not: null } },
    include: { organization: true },
  });

  let reminded = 0;

  for (const po of issued) {
    const window = getSettings(po.organization).expectedResponseDays;
    if (!isAwaitingResponse(po, window)) continue;

    const recipients = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { vendorId: po.vendorId },
          { organizationId: po.organizationId, role: { in: ['ORG_ADMIN', 'ORG_OFFICER'] } },
        ],
      },
      select: { id: true, email: true },
    });

    for (const user of recipients) {
      const already = await prisma.notification.count({
        where: { userId: user.id, type: 'PO_ISSUED', entityId: po.id, title: { contains: 'awaiting' } },
      });
      if (already > 0) continue;

      await prisma.$transaction(async (tx) => {
        await notifyMany(tx, [user.id], {
          type: 'PO_ISSUED',
          title: `Purchase order ${po.poNumber} awaiting response`,
          body: `${po.poNumber} has been open for more than ${window} day(s) without a response from ${po.vendorName}.`,
          entityType: 'PurchaseOrder',
          entityId: po.id,
          link: `/purchase-orders/${po.id}`,
        });
      });
      reminded += 1;
    }
  }

  return reminded;
}

export { recomputeFulfilment };
