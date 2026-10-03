/**
 * Query key factories (plan 16 §6).
 *
 * Nothing in the app ever writes a key literal. Every list key starts with its
 * module's `all`, so `invalidateQueries({ queryKey: qk.tenders.all })` reliably
 * refreshes every tender list, detail and comparison view at once — cache
 * invalidation stops being guesswork, and a renamed filter cannot silently
 * orphan a cached list.
 */

type Filters = Readonly<Record<string, unknown>> | undefined;

export const qk = {
  auth: {
    me: ['auth', 'me'] as const,
  },

  organizations: {
    all: ['organizations'] as const,
    list: (f?: Filters) => ['organizations', 'list', f ?? {}] as const,
    detail: (id: string) => ['organizations', 'detail', id] as const,
    members: (id: string) => ['organizations', 'detail', id, 'members'] as const,
    settings: ['organizations', 'settings'] as const,
  },

  invitations: {
    all: ['invitations'] as const,
    list: () => ['invitations', 'list'] as const,
    preview: (token: string) => ['invitations', 'preview', token] as const,
  },

  vendors: {
    all: ['vendors'] as const,
    list: (f?: Filters) => ['vendors', 'list', f ?? {}] as const,
    detail: (id: string) => ['vendors', 'detail', id] as const,
    scorecard: (id: string) => ['vendors', 'detail', id, 'scorecard'] as const,
    me: ['vendors', 'me'] as const,
  },

  categories: {
    all: ['categories'] as const,
    list: () => ['categories', 'list'] as const,
  },

  tenders: {
    all: ['tenders'] as const,
    list: (f?: Filters) => ['tenders', 'list', f ?? {}] as const,
    detail: (id: string) => ['tenders', 'detail', id] as const,
    items: (id: string) => ['tenders', 'detail', id, 'items'] as const,
    invitations: (id: string) => ['tenders', 'detail', id, 'invitations'] as const,
    quotations: (id: string) => ['tenders', 'detail', id, 'quotations'] as const,
    comparison: (id: string) => ['tenders', 'detail', id, 'comparison'] as const,
    scores: (id: string) => ['tenders', 'detail', id, 'scores'] as const,
  },

  quotations: {
    all: ['quotations'] as const,
    list: (f?: Filters) => ['quotations', 'list', f ?? {}] as const,
    detail: (id: string) => ['quotations', 'detail', id] as const,
  },

  approvals: {
    all: ['approvals'] as const,
    list: (f?: Filters) => ['approvals', 'list', f ?? {}] as const,
    detail: (id: string) => ['approvals', 'detail', id] as const,
  },

  purchaseOrders: {
    all: ['purchaseOrders'] as const,
    list: (f?: Filters) => ['purchaseOrders', 'list', f ?? {}] as const,
    detail: (id: string) => ['purchaseOrders', 'detail', id] as const,
    fulfilment: (id: string) => ['purchaseOrders', 'detail', id, 'fulfilment'] as const,
    receivable: (id: string) => ['purchaseOrders', 'detail', id, 'receivable'] as const,
  },

  deliveries: {
    all: ['deliveries'] as const,
    list: (f?: Filters) => ['deliveries', 'list', f ?? {}] as const,
    detail: (id: string) => ['deliveries', 'detail', id] as const,
  },

  grns: {
    all: ['grns'] as const,
    list: (f?: Filters) => ['grns', 'list', f ?? {}] as const,
    detail: (id: string) => ['grns', 'detail', id] as const,
  },

  invoices: {
    all: ['invoices'] as const,
    list: (f?: Filters) => ['invoices', 'list', f ?? {}] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
    match: (id: string) => ['invoices', 'detail', id, 'match'] as const,
    ageing: (f?: Filters) => ['invoices', 'ageing', f ?? {}] as const,
  },

  payments: {
    all: ['payments'] as const,
    list: (f?: Filters) => ['payments', 'list', f ?? {}] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
    payable: (f?: Filters) => ['payments', 'payable', f ?? {}] as const,
  },

  documents: {
    all: ['documents'] as const,
    list: (ownerType: string, ownerId: string) =>
      ['documents', 'list', ownerType, ownerId] as const,
  },

  notifications: {
    all: ['notifications'] as const,
    list: (f?: Filters) => ['notifications', 'list', f ?? {}] as const,
    unreadCount: ['notifications', 'unreadCount'] as const,
    preferences: ['notifications', 'preferences'] as const,
  },

  activity: {
    all: ['activity'] as const,
    list: (f?: Filters) => ['activity', 'list', f ?? {}] as const,
    /** The "History" tab on every detail screen. */
    forEntity: (entityType: string, entityId: string) =>
      ['activity', 'entity', entityType, entityId] as const,
    mine: (f?: Filters) => ['activity', 'mine', f ?? {}] as const,
    verify: ['activity', 'verify'] as const,
  },

  dashboard: (role: string) => ['dashboard', role] as const,

  reports: {
    all: ['reports'] as const,
    spend: (f?: Filters) => ['reports', 'spend', f ?? {}] as const,
    tenders: (f?: Filters) => ['reports', 'tenders', f ?? {}] as const,
    vendorPerformance: (f?: Filters) => ['reports', 'vendorPerformance', f ?? {}] as const,
    matchExceptions: (f?: Filters) => ['reports', 'matchExceptions', f ?? {}] as const,
  },
} as const;
