/**
 * Demo seed (plan 20 §1).
 *
 * Produces a dataset that looks like a live system but is fully deterministic:
 * fixed UUIDs for every entity, upserts for the base cast, and skip-if-present
 * for the downstream chain, so `npm run db:seed` is safe to re-run and never
 * doubles the data.
 *
 *   npm run db:seed              # idempotent; adds anything missing
 *   npm run db:seed -- --reset   # TRUNCATE every table first, then seed
 *
 * **--reset is for the dev branch only.** It drops every row in the schema; the
 * guard refuses to run against production, see `assertNotProd()`.
 *
 * This file does NOT go through the audit chain: a seed is not an application
 * action, and seed-only rows would otherwise occupy sequence numbers that would
 * confuse chain verification during a demo. The first real screen interaction
 * writes the first chain link.
 */
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Decimal } from 'decimal.js';

const prisma = new PrismaClient();
const RESET = process.argv.includes('--reset');

const PASSWORD = 'Demo@12345';
const BCRYPT_COST = 12;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(now.getTime() + n * 86_400_000);
const minutesAhead = (n: number) => new Date(now.getTime() + n * 60_000);

/** Fixed UUIDv7-shaped ids; readable, so a repeat run makes it obvious nothing drifted. */
const ID = {
  org: {
    meridian:  '01999000-0000-7000-a000-000000000001',
    northline: '01999000-0000-7000-a000-000000000002',
  },
  user: {
    platform: '01999000-0000-7000-b000-000000000001',
    priya:    '01999000-0000-7000-b000-000000000002', // Meridian admin
    rahul:    '01999000-0000-7000-b000-000000000003', // Meridian officer
    arjun:    '01999000-0000-7000-b000-000000000004', // Northline admin
    acme:     '01999000-0000-7000-b000-000000000005',
    beta:     '01999000-0000-7000-b000-000000000006',
    gamma:    '01999000-0000-7000-b000-000000000007',
    delta:    '01999000-0000-7000-b000-000000000008',
    zeta:     '01999000-0000-7000-b000-000000000009',
    eta:      '01999000-0000-7000-b000-00000000000a',
  },
  vendor: {
    acme:  '01999000-0000-7000-c000-000000000001',
    beta:  '01999000-0000-7000-c000-000000000002',
    gamma: '01999000-0000-7000-c000-000000000003',
    delta: '01999000-0000-7000-c000-000000000004',
    zeta:  '01999000-0000-7000-c000-000000000005',
    eta:   '01999000-0000-7000-c000-000000000006',
  },
  category: {
    networking: '01999000-0000-7000-d000-000000000001',
    electrical: '01999000-0000-7000-d000-000000000002',
    itHardware: '01999000-0000-7000-d000-000000000003',
    furniture:  '01999000-0000-7000-d000-000000000004',
    stationery: '01999000-0000-7000-d000-000000000005',
    logistics:  '01999000-0000-7000-d000-000000000006',
  },
  tender: {
    closedStory: '01999000-0000-7000-e000-000000000001', // finished story
    demoClosed:  '01999000-0000-7000-e000-000000000002', // BIDDING_CLOSED, 4 bids
    liveShort:   '01999000-0000-7000-e000-000000000003', // PUBLISHED, closes in 25 min
    liveLong:    '01999000-0000-7000-e000-000000000004', // PUBLISHED, closes in 36 h
    draft:       '01999000-0000-7000-e000-000000000005',
  },
} as const;

/** GSTIN check digit — mirrors shared/src/gstin.ts, duplicated to keep this file free of @tb/shared. */
const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinChecksum(fourteen: string): string {
  let factor = 1;
  let sum = 0;
  for (const char of fourteen) {
    const code = GSTIN_CHARSET.indexOf(char);
    const digit = code * factor;
    sum += Math.floor(digit / GSTIN_CHARSET.length) + (digit % GSTIN_CHARSET.length);
    factor = factor === 2 ? 1 : 2;
  }
  const remainder = (GSTIN_CHARSET.length - (sum % GSTIN_CHARSET.length)) % GSTIN_CHARSET.length;
  return GSTIN_CHARSET[remainder]!;
}
const gstin = (stateCode: string, pan: string, entityCode = '1Z'): string => {
  const base = stateCode + pan + entityCode;
  return base + gstinChecksum(base);
};

function assertNotProd(): void {
  if (!RESET) return;
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production' || /\.prod\./.test(url) || /\/main[?]/.test(url)) {
    throw new Error('refusing to --reset: NODE_ENV or DATABASE_URL suggests production');
  }
}

async function truncateAll(): Promise<void> {
  // CASCADE walks the FK graph so order does not matter. activity_logs is
  // append-only via two CREATE RULEs, so DELETE goes through RULE TO NOTHING:
  // TRUNCATE sidesteps both and is the only way to reset the chain.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      activity_logs, notifications, documents, payments, invoice_items, invoices,
      grn_items, grns, delivery_items, deliveries, purchase_order_items, purchase_orders,
      approvals, quotation_items, quotations, tender_invitations, tender_items, tenders,
      "_CategoryToVendor", categories, refresh_tokens, invitations, number_sequences,
      users, vendors, organizations
    RESTART IDENTITY CASCADE
  `);
}

const log = (...xs: unknown[]) => console.log('[seed]', ...xs);

/* --------------------------------------------------------------- base cast */

async function seedBaseCast() {
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_COST);

  const meridian = await prisma.organization.upsert({
    where: { id: ID.org.meridian },
    create: {
      id: ID.org.meridian,
      name: 'Meridian Industries Pvt Ltd',
      legalName: 'Meridian Industries Private Limited',
      email: 'contact@meridian.test',
      phone: '02025551001',
      gstin: gstin('24', 'AABCM1234F'),
      pan: 'AABCM1234F',
      addressLine1: 'Plot 12, GIDC Industrial Estate',
      city: 'Vadodara', state: 'Gujarat', stateCode: '24', pincode: '390010',
      status: 'ACTIVE', approvedAt: daysAgo(300),
    },
    update: { status: 'ACTIVE' },
  });

  // Northline: exists only so cross-tenant isolation is visible on screen.
  const northline = await prisma.organization.upsert({
    where: { id: ID.org.northline },
    create: {
      id: ID.org.northline,
      name: 'Northline Logistics Ltd',
      legalName: 'Northline Logistics Limited',
      email: 'contact@northline.test',
      phone: '02225551002',
      gstin: gstin('27', 'AABCN5678G'),
      pan: 'AABCN5678G',
      addressLine1: 'Floor 4, Nirmal Building, Nariman Point',
      city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pincode: '400021',
      status: 'ACTIVE', approvedAt: daysAgo(250),
    },
    update: { status: 'ACTIVE' },
  });

  await prisma.user.upsert({
    where: { id: ID.user.platform },
    create: {
      id: ID.user.platform, email: 'admin@tenderbridge.dev', passwordHash,
      fullName: 'Platform Admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE',
    },
    update: { passwordHash, status: 'ACTIVE' },
  });

  await prisma.user.upsert({
    where: { id: ID.user.priya },
    create: {
      id: ID.user.priya, email: 'admin@meridian.test', passwordHash,
      fullName: 'Priya Nair', role: 'ORG_ADMIN', status: 'ACTIVE',
      organizationId: meridian.id,
    },
    update: { passwordHash, organizationId: meridian.id, status: 'ACTIVE' },
  });
  await prisma.user.upsert({
    where: { id: ID.user.rahul },
    create: {
      id: ID.user.rahul, email: 'officer@meridian.test', passwordHash,
      fullName: 'Rahul Sharma', role: 'ORG_OFFICER', status: 'ACTIVE',
      organizationId: meridian.id,
    },
    update: { passwordHash, organizationId: meridian.id, status: 'ACTIVE' },
  });
  await prisma.user.upsert({
    where: { id: ID.user.arjun },
    create: {
      id: ID.user.arjun, email: 'admin@northline.test', passwordHash,
      fullName: 'Arjun Mehta', role: 'ORG_ADMIN', status: 'ACTIVE',
      organizationId: northline.id,
    },
    update: { passwordHash, organizationId: northline.id, status: 'ACTIVE' },
  });

  return { meridian, northline, passwordHash };
}

async function seedCategories() {
  const defs: Array<[string, string, string]> = [
    [ID.category.networking, 'Networking',  'networking'],
    [ID.category.electrical, 'Electrical',  'electrical'],
    [ID.category.itHardware, 'IT Hardware', 'it-hardware'],
    [ID.category.furniture,  'Furniture',   'furniture'],
    [ID.category.stationery, 'Stationery',  'stationery'],
    [ID.category.logistics,  'Logistics',   'logistics'],
  ];
  for (const [id, name, slug] of defs) {
    await prisma.category.upsert({
      where: { id }, create: { id, name, slug }, update: { name, slug },
    });
  }
}

interface VendorSeed {
  id: string;
  userId: string;
  company: string;
  email: string;
  userEmail: string;
  person: string;
  phone: string;
  pan: string;
  stateCode: string;
  state: string;
  city: string;
  pincode: string;
  address: string;
  status: 'APPROVED' | 'PENDING_APPROVAL' | 'SUSPENDED';
  rating?: number;
  totalOrders?: number;
  onTimeRate?: number;
  categories: string[];
}

async function seedVendors(passwordHash: string) {
  // Mix of states so both GST regimes appear (intra-state → CGST+SGST, inter → IGST).
  // Mix of statuses so Zeta can be approved live on stage and Eta shows that
  // SUSPENDED still permits invoicing goods already delivered.
  const vendors: VendorSeed[] = [
    {
      id: ID.vendor.acme, userId: ID.user.acme,
      company: 'Acme Networks Pvt Ltd', email: 'sales@acme.test',
      userEmail: 'v1@acme.test', person: 'Rahul Agarwal', phone: '9812340001',
      pan: 'AAACM1111A', stateCode: '24', state: 'Gujarat', city: 'Ahmedabad', pincode: '380015',
      address: '14 Sarkhej Bopal, Opp Rajpath Club',
      status: 'APPROVED', rating: 4.2, totalOrders: 14, onTimeRate: 92,
      categories: [ID.category.networking, ID.category.itHardware],
    },
    {
      id: ID.vendor.beta, userId: ID.user.beta,
      company: 'Beta Systems', email: 'sales@beta.test',
      userEmail: 'v2@beta.test', person: 'Sunil Rao', phone: '9812340002',
      pan: 'AAACM2222B', stateCode: '27', state: 'Maharashtra', city: 'Pune', pincode: '411001',
      address: 'Plot 7, MIDC Bhosari',
      status: 'APPROVED', rating: 3.8, totalOrders: 9, onTimeRate: 85,
      categories: [ID.category.electrical, ID.category.itHardware],
    },
    {
      id: ID.vendor.gamma, userId: ID.user.gamma,
      company: 'Gamma Solutions', email: 'sales@gamma.test',
      userEmail: 'v3@gamma.test', person: 'Neha Kulkarni', phone: '9812340003',
      pan: 'AAACM3333C', stateCode: '29', state: 'Karnataka', city: 'Bengaluru', pincode: '560001',
      address: '12 MG Road, Trinity Circle',
      status: 'APPROVED', // no history — exercises the null-rating path
      categories: [ID.category.itHardware, ID.category.networking],
    },
    {
      id: ID.vendor.delta, userId: ID.user.delta,
      company: 'Delta Traders', email: 'sales@delta.test',
      userEmail: 'v4@delta.test', person: 'Vikram Patel', phone: '9812340004',
      pan: 'AAACM4444D', stateCode: '24', state: 'Gujarat', city: 'Surat', pincode: '395003',
      address: 'Ring Road, Ugat Canal',
      status: 'APPROVED', rating: 4.6, totalOrders: 22, onTimeRate: 96,
      categories: [ID.category.furniture, ID.category.stationery],
    },
    {
      id: ID.vendor.zeta, userId: ID.user.zeta,
      company: 'Zeta Enterprises', email: 'sales@zeta.test',
      userEmail: 'v5@zeta.test', person: 'Anita Desai', phone: '9812340005',
      pan: 'AAACM5555E', stateCode: '27', state: 'Maharashtra', city: 'Nashik', pincode: '422001',
      address: 'MIDC Satpur',
      status: 'PENDING_APPROVAL', // approve this one live, on stage
      categories: [ID.category.logistics],
    },
    {
      id: ID.vendor.eta, userId: ID.user.eta,
      company: 'Eta Corp', email: 'sales@eta.test',
      userEmail: 'v6@eta.test', person: 'Prakash Iyer', phone: '9812340006',
      pan: 'AAACM6666F', stateCode: '29', state: 'Karnataka', city: 'Mysuru', pincode: '570001',
      address: 'Hunsur Road',
      status: 'SUSPENDED', // proves suspension still allows invoicing in-flight work
      categories: [ID.category.stationery],
    },
  ];

  for (const v of vendors) {
    await prisma.vendor.upsert({
      where: { id: v.id },
      create: {
        id: v.id, companyName: v.company, legalName: v.company, email: v.email, phone: v.phone,
        gstin: gstin(v.stateCode, v.pan), pan: v.pan,
        addressLine1: v.address, city: v.city, state: v.state, stateCode: v.stateCode, pincode: v.pincode,
        bankName: 'HDFC Bank', bankAccountName: v.company,
        bankAccountNumber: '0000' + v.pan.slice(5), bankIfsc: 'HDFC0000001',
        status: v.status,
        approvedAt: v.status === 'APPROVED' ? daysAgo(200) : null,
        rating: v.rating != null ? new Prisma.Decimal(v.rating.toFixed(2)) : null,
        totalOrders: v.totalOrders ?? 0,
        onTimeDeliveryRate: v.onTimeRate != null ? new Prisma.Decimal(v.onTimeRate.toFixed(2)) : null,
        categories: { connect: v.categories.map((id) => ({ id })) },
      },
      update: {
        status: v.status,
        rating: v.rating != null ? new Prisma.Decimal(v.rating.toFixed(2)) : null,
        totalOrders: v.totalOrders ?? 0,
        onTimeDeliveryRate: v.onTimeRate != null ? new Prisma.Decimal(v.onTimeRate.toFixed(2)) : null,
        categories: { set: v.categories.map((id) => ({ id })) },
      },
    });

    await prisma.user.upsert({
      where: { id: v.userId },
      create: {
        id: v.userId, email: v.userEmail, passwordHash,
        fullName: v.person, role: 'VENDOR',
        status: v.status === 'PENDING_APPROVAL' ? 'INVITED' : v.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
        vendorId: v.id,
      },
      update: {
        passwordHash, vendorId: v.id,
        status: v.status === 'PENDING_APPROVAL' ? 'INVITED' : v.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
      },
    });
  }
}

/* --------------------------------------------------------------- tenders */

function fiscalYear(d: Date): string {
  // Indian fiscal year: Apr 1 - Mar 31.
  const year = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? year : year - 1;
  const endShort = String((start + 1) % 100).padStart(2, '0');
  return `${start}-${endShort}`;
}
const refNum = (prefix: string, seq: number): string =>
  `${prefix}/${fiscalYear(now)}/${String(seq).padStart(6, '0')}`;

async function existsTender(id: string): Promise<boolean> {
  return (await prisma.tender.count({ where: { id } })) > 0;
}

function sealHashOf(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function seedDraftTender(meridianId: string) {
  const id = ID.tender.draft;
  if (await existsTender(id)) return;

  await prisma.tender.create({
    data: {
      id, organizationId: meridianId,
      referenceNumber: `DRAFT/${id.slice(0, 8)}`, // sentinel per lib/numbering
      title: 'Supply of office stationery FY26-27',
      description: 'Annual stationery contract for the Vadodara head office.',
      categoryId: ID.category.stationery,
      estimatedBudget: new Prisma.Decimal('180000.00'),
      deliveryLocation: 'Head Office, Vadodara',
      deliveryStateCode: '24',
      deliveryDeadline: daysAhead(60),
      bidSubmissionDeadline: daysAhead(14),
      status: 'DRAFT',
      evaluationMethod: 'LOWEST_PRICE',
      criteria: [{ key: 'price', label: 'Price', weight: 100, direction: 'lower_is_better' }],
      createdById: ID.user.rahul,
      items: {
        create: [
          { srNo: 1, description: 'A4 paper, 80 gsm, 500 sheets', hsnCode: '48025510', unit: 'REM', quantity: new Prisma.Decimal('250.000'), taxRatePercent: new Prisma.Decimal('12'), estimatedUnitPrice: new Prisma.Decimal('240.00') },
          { srNo: 2, description: 'Blue ballpoint pen', hsnCode: '96081091', unit: 'NOS', quantity: new Prisma.Decimal('1200.000'), taxRatePercent: new Prisma.Decimal('12'), estimatedUnitPrice: new Prisma.Decimal('8.50') },
        ],
      },
    },
  });
  log('created DRAFT tender', id);
}

async function seedLivePublished(meridianId: string, kind: 'liveShort' | 'liveLong', seq: number) {
  const id = ID.tender[kind];
  if (await existsTender(id)) {
    // Update the deadline on every run — a published tender with a stale deadline
    // is useless for a demo (countdown reads zero immediately).
    await prisma.tender.update({
      where: { id },
      data: { bidSubmissionDeadline: kind === 'liveShort' ? minutesAhead(25) : daysAhead(1.5) },
    });
    return;
  }

  await prisma.tender.create({
    data: {
      id, organizationId: meridianId,
      referenceNumber: refNum('TND', seq),
      title: kind === 'liveShort' ? 'Urgent: office network upgrade — 48-port switches'
                                  : 'Supply and installation of UPS systems',
      description: kind === 'liveShort'
        ? 'Replacement of ageing core switches at the Vadodara DC. Short window.'
        : 'Supply, installation and 2 years AMC of 10 kVA online UPS at four sites.',
      categoryId: kind === 'liveShort' ? ID.category.networking : ID.category.electrical,
      estimatedBudget: new Prisma.Decimal(kind === 'liveShort' ? '950000.00' : '480000.00'),
      deliveryLocation: 'Vadodara Data Centre',
      deliveryStateCode: '24',
      deliveryDeadline: daysAhead(45),
      bidSubmissionDeadline: kind === 'liveShort' ? minutesAhead(25) : daysAhead(1.5),
      status: 'PUBLISHED',
      publishedAt: daysAgo(2),
      evaluationMethod: 'WEIGHTED_SCORE',
      criteria: [
        { key: 'price', label: 'Price', weight: 60, direction: 'lower_is_better' },
        { key: 'deliveryDays', label: 'Delivery time', weight: 20, direction: 'lower_is_better' },
        { key: 'vendorRating', label: 'Vendor rating', weight: 20, direction: 'higher_is_better' },
      ],
      termsAndConditions: 'Payment 30 days from invoice. Warranty 3 years on site.',
      createdById: ID.user.rahul,
      items: {
        create: kind === 'liveShort' ? [
          { srNo: 1, description: '48-port managed gigabit switch', hsnCode: '85176290', unit: 'NOS', quantity: new Prisma.Decimal('4.000'), taxRatePercent: new Prisma.Decimal('18'), estimatedUnitPrice: new Prisma.Decimal('185000.00') },
          { srNo: 2, description: 'SFP+ 10G transceiver', hsnCode: '85176290', unit: 'NOS', quantity: new Prisma.Decimal('16.000'), taxRatePercent: new Prisma.Decimal('18'), estimatedUnitPrice: new Prisma.Decimal('8000.00') },
        ] : [
          { srNo: 1, description: '10 kVA online UPS, 30 min backup', hsnCode: '85044040', unit: 'NOS', quantity: new Prisma.Decimal('4.000'), taxRatePercent: new Prisma.Decimal('18'), estimatedUnitPrice: new Prisma.Decimal('95000.00') },
          { srNo: 2, description: '2-year AMC', hsnCode: '998719', unit: 'LOT', quantity: new Prisma.Decimal('1.000'), taxRatePercent: new Prisma.Decimal('18'), estimatedUnitPrice: new Prisma.Decimal('80000.00') },
        ],
      },
      invitations: {
        create: [ID.vendor.acme, ID.vendor.beta, ID.vendor.gamma, ID.vendor.delta].map((vendorId) => ({ vendorId })),
      },
    },
  });
  log(`created PUBLISHED tender (${kind})`, id);
}

interface SealedBidSpec { vendorId: string; prices: [number, number]; deliveryDays: number; freight: number; }

async function seedDemoClosed(meridianId: string, seq: number) {
  const id = ID.tender.demoClosed;
  if (await existsTender(id)) return;

  const items = [
    { srNo: 1, description: '24-port managed gigabit switch', hsnCode: '85176290', unit: 'NOS', quantity: 12, tax: 18, est: 58000 },
    { srNo: 2, description: 'SFP+ 10G transceiver',          hsnCode: '85176290', unit: 'NOS', quantity: 24, tax: 18, est: 8000 },
  ];

  const bids: SealedBidSpec[] = [
    { vendorId: ID.vendor.acme,  prices: [58500, 8200], deliveryDays: 21, freight: 4500 },
    { vendorId: ID.vendor.beta,  prices: [61200, 7900], deliveryDays: 28, freight: 0 },
    { vendorId: ID.vendor.gamma, prices: [57900, 8600], deliveryDays: 18, freight: 6000 },
    { vendorId: ID.vendor.delta, prices: [56800, 8400], deliveryDays: 20, freight: 5000 },
  ];

  await prisma.$transaction(async (tx) => {
    await tx.tender.create({
      data: {
        id, organizationId: meridianId,
        referenceNumber: refNum('TND', seq),
        title: 'Core network refresh — 24-port switches and transceivers',
        description: 'Switch and transceiver refresh for the Vadodara campus network.',
        categoryId: ID.category.networking,
        estimatedBudget: new Prisma.Decimal('850000.00'),
        deliveryLocation: 'Vadodara campus',
        deliveryStateCode: '24',
        deliveryDeadline: daysAhead(30),
        bidSubmissionDeadline: daysAgo(1),
        status: 'BIDDING_CLOSED',
        publishedAt: daysAgo(10),
        closedAt: daysAgo(1),
        evaluationMethod: 'WEIGHTED_SCORE',
        criteria: [
          { key: 'price', label: 'Price', weight: 60, direction: 'lower_is_better' },
          { key: 'deliveryDays', label: 'Delivery time', weight: 20, direction: 'lower_is_better' },
          { key: 'vendorRating', label: 'Vendor rating', weight: 20, direction: 'higher_is_better' },
        ],
        termsAndConditions: 'Payment 30 days from invoice. Warranty 3 years on site.',
        createdById: ID.user.rahul,
        items: {
          create: items.map((i) => ({
            srNo: i.srNo, description: i.description, hsnCode: i.hsnCode, unit: i.unit,
            quantity: new Prisma.Decimal(i.quantity.toFixed(3)),
            taxRatePercent: new Prisma.Decimal(i.tax.toFixed(2)),
            estimatedUnitPrice: new Prisma.Decimal(i.est.toFixed(2)),
          })),
        },
        invitations: { create: bids.map((b) => ({ vendorId: b.vendorId, respondedAt: daysAgo(2) })) },
      },
    });

    const tenderItems = await tx.tenderItem.findMany({ where: { tenderId: id }, orderBy: { srNo: 'asc' } });

    for (let i = 0; i < bids.length; i++) {
      const b = bids[i]!;
      let subtotal = new Decimal(0);
      let taxTotal = new Decimal(0);
      const itemRows = tenderItems.map((ti, idx) => {
        const qty = new Decimal(items[idx]!.quantity);
        const unit = new Decimal(b.prices[idx]!);
        const lineTaxable = qty.mul(unit);
        const taxAmount = lineTaxable.mul(items[idx]!.tax).div(100);
        const lineTotal = lineTaxable.add(taxAmount);
        subtotal = subtotal.add(lineTaxable);
        taxTotal = taxTotal.add(taxAmount);
        return {
          tenderItemId: ti.id,
          quantity: new Prisma.Decimal(qty.toFixed(3)),
          unitPrice: new Prisma.Decimal(unit.toFixed(2)),
          discountPercent: new Prisma.Decimal('0'),
          taxableValue: new Prisma.Decimal(lineTaxable.toFixed(2)),
          taxRatePercent: new Prisma.Decimal(items[idx]!.tax.toFixed(2)),
          taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)),
          lineTotal: new Prisma.Decimal(lineTotal.toFixed(2)),
          deliveryDays: b.deliveryDays,
        };
      });
      const freight = new Decimal(b.freight);
      const grand = subtotal.add(taxTotal).add(freight);

      await tx.quotation.create({
        data: {
          tenderId: id, vendorId: b.vendorId,
          referenceNumber: `QTN/${fiscalYear(now)}/${String(seq * 10 + i + 1).padStart(6, '0')}`,
          status: 'SUBMITTED',
          subtotal:      new Prisma.Decimal(subtotal.toFixed(2)),
          taxableAmount: new Prisma.Decimal(subtotal.toFixed(2)),
          taxAmount:     new Prisma.Decimal(taxTotal.toFixed(2)),
          freightAmount: new Prisma.Decimal(freight.toFixed(2)),
          grandTotal:    new Prisma.Decimal(grand.toFixed(2)),
          deliveryDays: b.deliveryDays, validityDays: 45,
          paymentTerms: '30 days from invoice',
          submittedAt: daysAgo(2),
          sealHash: sealHashOf({ bid: i, prices: b.prices, delivery: b.deliveryDays }),
          items: { create: itemRows },
        },
      });
    }
  });

  log('created BIDDING_CLOSED demo tender with 4 bids', id);
}

/* The finished story: tender → PO → GRN → invoice → payment, CLOSED. */

async function seedClosedStory(meridianId: string, seq: number) {
  const id = ID.tender.closedStory;
  if (await existsTender(id)) return;

  // Both parties in Gujarat (24) → CGST+SGST, not IGST. Clean MATCHED invoice.
  const items = [
    { srNo: 1, description: '24-port managed gigabit switch', hsnCode: '85176290', unit: 'NOS', quantity: 8,   tax: 18, price: 60000 },
    { srNo: 2, description: 'Cat6a patch cord, 2 m',           hsnCode: '85444299', unit: 'NOS', quantity: 100, tax: 18, price: 180   },
  ];

  await prisma.$transaction(async (tx) => {
    await tx.tender.create({
      data: {
        id, organizationId: meridianId,
        referenceNumber: refNum('TND', seq),
        title: 'Branch LAN refresh — Ahmedabad',
        description: 'Replace 10-year-old branch LAN equipment.',
        categoryId: ID.category.networking,
        estimatedBudget: new Prisma.Decimal('520000.00'),
        deliveryLocation: 'Branch office, Ahmedabad',
        deliveryStateCode: '24',
        deliveryDeadline: daysAgo(10),
        bidSubmissionDeadline: daysAgo(90),
        status: 'CLOSED',
        publishedAt: daysAgo(120),
        closedAt: daysAgo(5),
        awardedAt: daysAgo(80),
        evaluationMethod: 'WEIGHTED_SCORE',
        criteria: [
          { key: 'price', label: 'Price', weight: 70, direction: 'lower_is_better' },
          { key: 'deliveryDays', label: 'Delivery time', weight: 30, direction: 'lower_is_better' },
        ],
        createdById: ID.user.rahul,
        items: {
          create: items.map((i) => ({
            srNo: i.srNo, description: i.description, hsnCode: i.hsnCode, unit: i.unit,
            quantity: new Prisma.Decimal(i.quantity.toFixed(3)),
            taxRatePercent: new Prisma.Decimal(i.tax.toFixed(2)),
            estimatedUnitPrice: new Prisma.Decimal(i.price.toFixed(2)),
          })),
        },
      },
    });

    const tenderItems = await tx.tenderItem.findMany({ where: { tenderId: id }, orderBy: { srNo: 'asc' } });

    let subtotal = new Decimal(0);
    let taxTotal = new Decimal(0);
    const qItems = tenderItems.map((ti, idx) => {
      const qty = new Decimal(items[idx]!.quantity);
      const unit = new Decimal(items[idx]!.price);
      const taxable = qty.mul(unit);
      const tax = taxable.mul(items[idx]!.tax).div(100);
      subtotal = subtotal.add(taxable);
      taxTotal = taxTotal.add(tax);
      return {
        tenderItemId: ti.id,
        quantity: new Prisma.Decimal(qty.toFixed(3)),
        unitPrice: new Prisma.Decimal(unit.toFixed(2)),
        discountPercent: new Prisma.Decimal('0'),
        taxableValue: new Prisma.Decimal(taxable.toFixed(2)),
        taxRatePercent: new Prisma.Decimal(items[idx]!.tax.toFixed(2)),
        taxAmount: new Prisma.Decimal(tax.toFixed(2)),
        lineTotal: new Prisma.Decimal(taxable.add(tax).toFixed(2)),
      };
    });
    const grand = subtotal.add(taxTotal);

    const quotation = await tx.quotation.create({
      data: {
        tenderId: id, vendorId: ID.vendor.acme,
        referenceNumber: `QTN/${fiscalYear(now)}/${String(seq * 10 + 1).padStart(6, '0')}`,
        status: 'AWARDED',
        subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
        taxableAmount: new Prisma.Decimal(subtotal.toFixed(2)),
        taxAmount: new Prisma.Decimal(taxTotal.toFixed(2)),
        grandTotal: new Prisma.Decimal(grand.toFixed(2)),
        deliveryDays: 15, validityDays: 60,
        submittedAt: daysAgo(85),
        sealHash: sealHashOf({ story: 'closed', q: 1 }),
        totalScore: new Prisma.Decimal('92.50'), rank: 1,
        evaluatedAt: daysAgo(80),
        items: { create: qItems },
      },
    });

    await tx.tender.update({
      where: { id },
      data: {
        awardedQuotationId: quotation.id,
        recommendedQuotationId: quotation.id,
        recommendedAt: daysAgo(82),
        recommendedById: ID.user.rahul,
        recommendationNote: 'Lowest price, acceptable delivery, prior performance 4.2.',
      },
    });

    const cgstHalf = (dec: Prisma.Decimal) => new Prisma.Decimal(new Decimal(dec.toString()).div(2).toFixed(2));

    const poItems = qItems.map((qi, idx) => ({
      srNo: idx + 1,
      tenderItemId: qi.tenderItemId,
      description: items[idx]!.description,
      hsnCode: items[idx]!.hsnCode,
      unit: items[idx]!.unit,
      quantity: qi.quantity,
      unitPrice: qi.unitPrice,
      discountPercent: new Prisma.Decimal('0'),
      taxableValue: qi.taxableValue,
      taxRatePercent: qi.taxRatePercent,
      cgstAmount: cgstHalf(qi.taxAmount),
      sgstAmount: cgstHalf(qi.taxAmount),
      igstAmount: new Prisma.Decimal('0'),
      lineTotal: qi.lineTotal,
      receivedQuantity: qi.quantity,
      acceptedQuantity: qi.quantity,
      invoicedQuantity: qi.quantity,
    }));
    const cgstTotal = taxTotal.div(2);
    const sgstTotal = taxTotal.div(2);

    const po = await tx.purchaseOrder.create({
      data: {
        organizationId: meridianId, vendorId: ID.vendor.acme, tenderId: id, quotationId: quotation.id,
        poNumber: `PO/${fiscalYear(now)}/${String(seq).padStart(6, '0')}`,
        status: 'CLOSED', fulfilmentStatus: 'FULFILLED',
        buyerName: 'Meridian Industries Pvt Ltd',
        buyerGstin: gstin('24', 'AABCM1234F'),
        buyerAddress: 'Plot 12, GIDC Industrial Estate, Vadodara, Gujarat 390010',
        buyerStateCode: '24',
        vendorName: 'Acme Networks Pvt Ltd',
        vendorGstin: gstin('24', 'AAACM1111A'),
        vendorAddress: '14 Sarkhej Bopal, Ahmedabad, Gujarat 380015',
        vendorStateCode: '24',
        placeOfSupplyStateCode: '24', taxRegime: 'INTRA_STATE',
        subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
        taxableAmount: new Prisma.Decimal(subtotal.toFixed(2)),
        cgstAmount: new Prisma.Decimal(cgstTotal.toFixed(2)),
        sgstAmount: new Prisma.Decimal(sgstTotal.toFixed(2)),
        igstAmount: new Prisma.Decimal('0'),
        totalAmount: new Prisma.Decimal(grand.toFixed(2)),
        expectedDeliveryDate: daysAgo(30),
        deliveryAddress: 'Branch office, Ahmedabad',
        paymentTerms: '30 days from invoice',
        createdById: ID.user.priya,
        issuedAt: daysAgo(75), acceptedAt: daysAgo(74), closedAt: daysAgo(5),
        items: { create: poItems },
      },
      include: { items: true },
    });

    await tx.grn.create({
      data: {
        organizationId: meridianId, purchaseOrderId: po.id,
        grnNumber: `GRN/${fiscalYear(now)}/${String(seq).padStart(6, '0')}`,
        status: 'ACCEPTED',
        receivedById: ID.user.rahul,
        receivedAt: daysAgo(40),
        remarks: 'Full acceptance, no damage.',
        items: {
          create: po.items.map((pi) => ({
            purchaseOrderItemId: pi.id,
            receivedQuantity: pi.quantity,
            acceptedQuantity: pi.quantity,
            rejectedQuantity: new Prisma.Decimal('0'),
          })),
        },
      },
    });

    const invItems = po.items.map((pi) => ({
      purchaseOrderItemId: pi.id,
      description: pi.description, hsnCode: pi.hsnCode, unit: pi.unit,
      quantity: pi.quantity, unitPrice: pi.unitPrice,
      taxableValue: pi.taxableValue, taxRatePercent: pi.taxRatePercent,
      cgstAmount: pi.cgstAmount, sgstAmount: pi.sgstAmount, igstAmount: pi.igstAmount,
      lineTotal: pi.lineTotal,
    }));

    const invoice = await tx.invoice.create({
      data: {
        organizationId: meridianId, vendorId: ID.vendor.acme, purchaseOrderId: po.id,
        vendorInvoiceNumber: 'ACME/2026/0012',
        referenceNumber: `INV/${fiscalYear(now)}/${String(seq).padStart(6, '0')}`,
        invoiceDate: daysAgo(38), dueDate: daysAgo(8),
        subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
        taxableAmount: new Prisma.Decimal(subtotal.toFixed(2)),
        cgstAmount: new Prisma.Decimal(cgstTotal.toFixed(2)),
        sgstAmount: new Prisma.Decimal(sgstTotal.toFixed(2)),
        igstAmount: new Prisma.Decimal('0'),
        totalAmount: new Prisma.Decimal(grand.toFixed(2)),
        amountPaid: new Prisma.Decimal(grand.toFixed(2)),
        status: 'PAID', matchStatus: 'MATCHED',
        matchResult: { allChecksPassed: true, checks: [] },
        matchRunAt: daysAgo(37),
        submittedAt: daysAgo(37),
        approvedById: ID.user.priya, approvedAt: daysAgo(35),
        paidAt: daysAgo(10),
        items: { create: invItems },
      },
    });

    // TDS 194C: 2% of the taxable amount; net is gross minus TDS.
    const tds = new Decimal(subtotal.toFixed(2)).mul(2).div(100);
    const net = new Decimal(grand.toFixed(2)).sub(tds);
    await tx.payment.create({
      data: {
        organizationId: meridianId, vendorId: ID.vendor.acme, invoiceId: invoice.id,
        paymentNumber: `PAY/${fiscalYear(now)}/${String(seq).padStart(6, '0')}`,
        grossAmount: new Prisma.Decimal(grand.toFixed(2)),
        tdsAmount: new Prisma.Decimal(tds.toFixed(2)), tdsSection: '194C',
        retentionAmount: new Prisma.Decimal('0'), otherDeduction: new Prisma.Decimal('0'),
        netAmount: new Prisma.Decimal(net.toFixed(2)),
        method: 'NEFT',
        referenceNumber: 'UTR202610091234',
        paidAt: daysAgo(10), valueDate: daysAgo(10),
        status: 'COMPLETED',
        recordedById: ID.user.priya,
        approvedById: ID.user.priya, approvedAt: daysAgo(11),
      },
    });
  });

  log('created finished story (tender → PO → GRN → invoice → payment)', id);
}

/* --------------------------------------------------------------- entry */

async function main() {
  const t0 = Date.now();
  log('starting; database:', (process.env.DATABASE_URL ?? '').match(/@([^/]+)/)?.[1] ?? 'unknown');

  assertNotProd();
  if (RESET) {
    log('--reset: truncating every table');
    await truncateAll();
  }

  const { meridian, passwordHash } = await seedBaseCast();
  await seedCategories();
  await seedVendors(passwordHash);

  let seq = 1;
  await seedDraftTender(meridian.id);
  await seedClosedStory(meridian.id, seq++);
  await seedDemoClosed(meridian.id, seq++);
  await seedLivePublished(meridian.id, 'liveLong', seq++);
  await seedLivePublished(meridian.id, 'liveShort', seq++);

  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log('login: admin@tenderbridge.dev / Demo@12345 (platform admin)');
  log('       admin@meridian.test   / Demo@12345 (ORG_ADMIN)');
  log('       officer@meridian.test / Demo@12345 (ORG_OFFICER)');
  log('       v1@acme.test          / Demo@12345 (VENDOR)');
}

main()
  .catch((err) => {
    console.error('[seed] FAILED');
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
