import type { Organization, User, Vendor } from '@prisma/client';
import type { MeDto, PartySummary, SessionDto } from '@tb/shared';

export type UserWithParties = User & {
  organization?: Organization | null;
  vendor?: Vendor | null;
};

const orgSummary = (org: Organization | null | undefined): PartySummary | null =>
  org ? { id: org.id, name: org.name, status: org.status } : null;

const vendorSummary = (vendor: Vendor | null | undefined): PartySummary | null =>
  vendor ? { id: vendor.id, name: vendor.companyName, status: vendor.status } : null;

/** The only shape a user ever leaves the server in. No hashes, no tokens. */
export const toMeDto = (user: UserWithParties): MeDto => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  phone: user.phone,
  role: user.role,
  status: user.status,
  organization: orgSummary(user.organization),
  vendor: vendorSummary(user.vendor),
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
});

export const toSessionDto = (
  user: UserWithParties,
  accessToken: string,
  expiresIn: number,
): SessionDto => ({
  accessToken,
  expiresIn,
  user: toMeDto(user),
});
