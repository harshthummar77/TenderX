import type { Prisma, Quotation, QuotationItem } from '@prisma/client';
import { canonicalJson } from '../../lib/canonicalJson.js';
import { sha256 } from '../../lib/crypto.js';
import { qtyToApi, toApi, type Decimal } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { NotFound } from '../../lib/errors.js';

/**
 * The seal (08 §1).
 *
 * A hash proves a bid exists and is fixed **without revealing anything about
 * it**, which is why the buyer may see it while the tender is still sealed. The
 * vendor gets the same string as a submission receipt.
 *
 * After opening, `verifySeal` recomputes the hash from the stored rows. Editing
 * a `unitPrice` in Prisma Studio — or anywhere else — makes it disagree.
 */

/** Until `bidOpenedAt` is set and in the past, nothing money-shaped leaves the buyer API. */
export const isSealed = (tender: { bidOpenedAt: Date | null }, now: Date = new Date()): boolean =>
  !tender.bidOpenedAt || tender.bidOpenedAt > now;

export interface SealItemInput {
  tenderItemId: string;
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
}

export interface SealInput {
  tenderId: string;
  vendorId: string;
  submittedAt: Date;
  items: SealItemInput[];
  grandTotal: Decimal.Value;
}

/**
 * Every value is normalised through the API formatters before hashing.
 *
 * That matters more than it looks: decimal.js drops trailing zeros, so a
 * quantity read back from Postgres as `12.000` stringifies to `12`, and a hash
 * taken over the raw `toString()` would fail verification on a bid nobody
 * touched. `qtyToApi`/`toApi` are fixed-width, so the hash depends on the value.
 *
 * Items are sorted by `tenderItemId`: Postgres makes no promise about row order,
 * and the seal must not depend on one.
 */
export function computeSealHash(input: SealInput): string {
  return sha256(
    canonicalJson({
      tenderId: input.tenderId,
      vendorId: input.vendorId,
      submittedAt: input.submittedAt.toISOString(),
      items: [...input.items]
        .sort((a, b) => (a.tenderItemId < b.tenderItemId ? -1 : a.tenderItemId > b.tenderItemId ? 1 : 0))
        .map((item) => ({
          tenderItemId: item.tenderItemId,
          quantity: qtyToApi(item.quantity),
          unitPrice: toApi(item.unitPrice),
        })),
      grandTotal: toApi(input.grandTotal),
    }),
  );
}

/** The hash a stored quotation *should* carry, recomputed from its own rows. */
export const sealHashOf = (
  quotation: Pick<Quotation, 'tenderId' | 'vendorId' | 'grandTotal'> & { submittedAt: Date },
  items: Pick<QuotationItem, 'tenderItemId' | 'quantity' | 'unitPrice'>[],
): string =>
  computeSealHash({
    tenderId: quotation.tenderId,
    vendorId: quotation.vendorId,
    submittedAt: quotation.submittedAt,
    grandTotal: quotation.grandTotal,
    items,
  });

export interface SealVerificationResult {
  valid: boolean;
  sealHash: string | null;
  computedHash: string;
  submittedAt: string | null;
}

/**
 * Recompute and compare. A quotation that was never submitted has nothing to
 * verify, so it is `valid: false` rather than an error — the officer asked a
 * legitimate question and gets a legitimate "no".
 */
export async function verifySeal(
  quotationId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<SealVerificationResult> {
  const quotation = await client.quotation.findUnique({
    where: { id: quotationId },
    include: { items: true },
  });
  if (!quotation) throw NotFound('Quotation');

  if (!quotation.submittedAt) {
    return { valid: false, sealHash: quotation.sealHash, computedHash: '', submittedAt: null };
  }

  const computedHash = sealHashOf(
    { ...quotation, submittedAt: quotation.submittedAt },
    quotation.items,
  );

  return {
    valid: quotation.sealHash === computedHash,
    sealHash: quotation.sealHash,
    computedHash,
    submittedAt: quotation.submittedAt.toISOString(),
  };
}
