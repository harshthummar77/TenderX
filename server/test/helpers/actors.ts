import type { Organization, User, Vendor } from '@prisma/client';
import type { Role } from '@tb/shared';
import { prisma } from '../../src/lib/prisma.js';
import { signAccess } from '../../src/modules/auth/token.service.js';

/**
 * Fixtures for the access-control suites: real rows, real signed tokens, no
 * HTTP registration round trip. PLATFORM_ADMIN has no registration endpoint at
 * all (seed script only), so it can only be made this way.
 */

let counter = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

export async function makeOrganization(name: string): Promise<Organization> {
  return prisma.organization.create({
    data: {
      name,
      email: `${unique('org')}@example.test`,
      addressLine1: '1 Ring Road',
      city: 'Ahmedabad',
      state: 'Gujarat',
      stateCode: '24',
      pincode: '380009',
      status: 'ACTIVE',
    },
  });
}

export async function makeVendor(companyName: string): Promise<Vendor> {
  return prisma.vendor.create({
    data: {
      companyName,
      email: `${unique('vendor')}@example.test`,
      phone: '9876500000',
      addressLine1: '9 Industrial Estate',
      city: 'Surat',
      state: 'Gujarat',
      stateCode: '24',
      pincode: '395001',
      status: 'APPROVED',
    },
  });
}

export interface TestActor {
  user: User;
  token: string;
  authHeader: [string, string];
}

export async function makeUser(
  role: Role,
  party: { organizationId?: string; vendorId?: string } = {},
): Promise<TestActor> {
  const user = await prisma.user.create({
    data: {
      email: `${unique(role.toLowerCase())}@example.test`,
      passwordHash: 'not-used-in-these-tests',
      fullName: `${role} user`,
      role,
      status: 'ACTIVE',
      organizationId: party.organizationId ?? null,
      vendorId: party.vendorId ?? null,
    },
  });

  const token = signAccess(user);
  return { user, token, authHeader: ['Authorization', `Bearer ${token}`] };
}

/** The Actor shape the scope helpers take, built from a test user. */
export const actorOf = (user: User) => ({
  userId: user.id,
  email: user.email,
  role: user.role,
  organizationId: user.organizationId,
  vendorId: user.vendorId,
  isPlatformAdmin: user.role === 'PLATFORM_ADMIN',
});

/**
 * One organization with a vendor and one row in each tenant-owned table that
 * later plans expose over HTTP. Both isolation directions are covered: the
 * buyer-owned tender, and the shared PO / invoice / payment that carry both
 * party ids.
 */
export async function seedOrgWithData(name: string) {
  const organization = await makeOrganization(name);
  const vendor = await makeVendor(`${name} Supplier`);
  const admin = await makeUser('ORG_ADMIN', { organizationId: organization.id });
  const officer = await makeUser('ORG_OFFICER', { organizationId: organization.id });
  const vendorUser = await makeUser('VENDOR', { vendorId: vendor.id });

  const tender = await prisma.tender.create({
    data: {
      organizationId: organization.id,
      referenceNumber: unique('TND'),
      title: `${name} tender`,
      description: 'Isolation fixture',
      deliveryLocation: 'Ahmedabad',
      deliveryStateCode: '24',
      deliveryDeadline: new Date(Date.now() + 86_400_000),
      bidSubmissionDeadline: new Date(Date.now() + 43_200_000),
      estimatedBudget: '500000.00',
      createdById: officer.user.id,
      status: 'PUBLISHED',
    },
  });

  const purchaseOrder = await prisma.purchaseOrder.create({
    data: {
      organizationId: organization.id,
      vendorId: vendor.id,
      tenderId: tender.id,
      poNumber: unique('PO'),
      buyerName: organization.name,
      buyerAddress: '1 Ring Road',
      buyerStateCode: '24',
      vendorName: vendor.companyName,
      vendorAddress: '9 Industrial Estate',
      vendorStateCode: '24',
      placeOfSupplyStateCode: '24',
      taxRegime: 'INTRA_STATE',
      expectedDeliveryDate: new Date(Date.now() + 172_800_000),
      deliveryAddress: '1 Ring Road',
      createdById: admin.user.id,
      status: 'ISSUED',
      totalAmount: '118000.00',
    },
  });

  const grn = await prisma.grn.create({
    data: {
      organizationId: organization.id,
      purchaseOrderId: purchaseOrder.id,
      grnNumber: unique('GRN'),
      status: 'ACCEPTED',
      receivedById: officer.user.id,
      receivedAt: new Date(),
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      organizationId: organization.id,
      vendorId: vendor.id,
      purchaseOrderId: purchaseOrder.id,
      vendorInvoiceNumber: unique('VINV'),
      referenceNumber: unique('INV'),
      invoiceDate: new Date(),
      dueDate: new Date(Date.now() + 2_592_000_000),
      totalAmount: '118000.00',
    },
  });

  const payment = await prisma.payment.create({
    data: {
      organizationId: organization.id,
      vendorId: vendor.id,
      invoiceId: invoice.id,
      paymentNumber: unique('PAY'),
      grossAmount: '50000.00',
      netAmount: '49000.00',
      tdsAmount: '1000.00',
      method: 'NEFT',
      paidAt: new Date(),
      recordedById: admin.user.id,
    },
  });

  const document = await prisma.document.create({
    data: {
      ownerType: 'VENDOR',
      ownerId: vendor.id,
      organizationId: organization.id,
      vendorId: vendor.id,
      type: 'VENDOR_GST_CERTIFICATE',
      fileName: 'gst.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: unique('cloudinary'),
      uploadedById: vendorUser.user.id,
    },
  });

  return {
    organization,
    vendor,
    admin,
    officer,
    vendorUser,
    tender,
    purchaseOrder,
    grn,
    invoice,
    payment,
    document,
  };
}

export type SeededOrg = Awaited<ReturnType<typeof seedOrgWithData>>;
