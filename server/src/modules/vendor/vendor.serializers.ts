import type { Category, Vendor } from '@prisma/client';
import {
  maskAccount,
  type CategoryDto,
  type DuplicateWarning,
  type VendorAdminDto,
  type VendorPublicDto,
  type VendorSelfDto,
} from '@tb/shared';

/**
 * Three audiences, three serializers (06 §3).
 *
 * Written as three explicit functions rather than one function with flags —
 * a flag defaults to the wrong value exactly once and the bank details are in
 * the directory. The vendor.spec JSON-grep test guards this.
 */

export type VendorWithCategories = Vendor & { categories?: Category[] };

const toCategoryDto = (category: Category): CategoryDto => ({
  id: category.id,
  name: category.name,
  slug: category.slug,
  description: category.description,
});

/** Decimal columns leave as numbers here: rating and rates are metrics, not money. */
const core = (vendor: VendorWithCategories) => ({
  id: vendor.id,
  companyName: vendor.companyName,
  legalName: vendor.legalName,
  email: vendor.email,
  phone: vendor.phone,
  gstin: vendor.gstin,
  pan: vendor.pan,
  addressLine1: vendor.addressLine1,
  addressLine2: vendor.addressLine2,
  city: vendor.city,
  state: vendor.state,
  stateCode: vendor.stateCode,
  pincode: vendor.pincode,
  country: vendor.country,
  status: vendor.status,
  rating: vendor.rating === null ? null : Number(vendor.rating),
  totalOrders: vendor.totalOrders,
  onTimeDeliveryRate: vendor.onTimeDeliveryRate === null ? null : Number(vendor.onTimeDeliveryRate),
  categories: (vendor.categories ?? []).map(toCategoryDto),
  createdAt: vendor.createdAt.toISOString(),
});

/** The vendor's own view: masked bank details, and why their status is what it is. */
export const toVendorSelfDto = (vendor: VendorWithCategories): VendorSelfDto => ({
  ...core(vendor),
  bankName: vendor.bankName,
  bankAccountName: vendor.bankAccountName,
  bankAccountNumber: maskAccount(vendor.bankAccountNumber),
  bankIfsc: vendor.bankIfsc,
  statusReason: vendor.statusReason,
  approvedAt: vendor.approvedAt?.toISOString() ?? null,
});

/**
 * The buyer directory. No bank fields at all — not masked, **absent**. GSTIN and
 * PAN stay: both are public business identifiers printed on every invoice.
 */
export const toVendorPublicDto = (vendor: VendorWithCategories): VendorPublicDto => core(vendor);

/** The platform reviewer: masked bank details plus everything the decision needs. */
export const toVendorAdminDto = (
  vendor: VendorWithCategories,
  extras: {
    missingKyc: { path: string; message: string }[];
    duplicateWarnings: DuplicateWarning[];
    documents: { id: string; type: string; fileName: string; createdAt: Date }[];
    userCount: number;
  },
): VendorAdminDto => ({
  ...core(vendor),
  bankName: vendor.bankName,
  bankAccountName: vendor.bankAccountName,
  bankAccountNumber: maskAccount(vendor.bankAccountNumber),
  bankIfsc: vendor.bankIfsc,
  statusReason: vendor.statusReason,
  approvedAt: vendor.approvedAt?.toISOString() ?? null,
  missingKyc: extras.missingKyc,
  duplicateWarnings: extras.duplicateWarnings,
  documents: extras.documents.map((doc) => ({
    id: doc.id,
    type: doc.type,
    fileName: doc.fileName,
    createdAt: doc.createdAt.toISOString(),
  })),
  userCount: extras.userCount,
});
