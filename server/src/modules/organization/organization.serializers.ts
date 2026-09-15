import type { Organization, User } from '@prisma/client';
import {
  isValidGstin,
  type CompletionCheck,
  type CompletionDto,
  type MemberDto,
  type OrganizationDto,
  type PlatformOrgListItem,
} from '@tb/shared';

/**
 * Profile completion. The checklist is returned, not just the number: the UI
 * renders it with a link per row, which is far more useful than a bare
 * percentage, and the platform admin sees readiness at a glance.
 */
export function completionOf(org: Organization, hasGstCertificate: boolean): CompletionDto {
  const hasFullAddress = Boolean(
    org.addressLine1 && org.city && org.state && /^\d{2}$/.test(org.stateCode) && org.pincode,
  );

  const checks: CompletionCheck[] = [
    {
      key: 'basic',
      label: 'Company name and email',
      done: Boolean(org.name && org.email),
      weight: 15,
    },
    {
      key: 'gstin',
      label: 'GSTIN verified',
      done: Boolean(org.gstin && isValidGstin(org.gstin)),
      weight: 25,
    },
    { key: 'pan', label: 'PAN', done: Boolean(org.pan), weight: 15 },
    { key: 'address', label: 'Registered address', done: hasFullAddress, weight: 20 },
    {
      key: 'documents',
      label: 'GST certificate uploaded',
      done: hasGstCertificate,
      weight: 25,
    },
  ];

  const score = checks.reduce((total, check) => total + (check.done ? check.weight : 0), 0);
  return { score, checks };
}

export const toOrgDto = (
  org: Organization,
  options: { hasGstCertificate: boolean; stateCodeEditable: boolean },
): OrganizationDto => ({
  id: org.id,
  name: org.name,
  legalName: org.legalName,
  email: org.email,
  phone: org.phone,
  gstin: org.gstin,
  pan: org.pan,
  addressLine1: org.addressLine1,
  addressLine2: org.addressLine2,
  city: org.city,
  state: org.state,
  stateCode: org.stateCode,
  pincode: org.pincode,
  country: org.country,
  status: org.status,
  logoUrl: org.logoUrl,
  approvedAt: org.approvedAt?.toISOString() ?? null,
  createdAt: org.createdAt.toISOString(),
  stateCodeEditable: options.stateCodeEditable,
  completion: completionOf(org, options.hasGstCertificate),
});

export const toMemberDto = (user: User): MemberDto => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  phone: user.phone,
  role: user.role,
  status: user.status,
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});

export const toPlatformOrgListItem = (
  org: Organization & { _count?: { users: number; tenders: number } },
  hasGstCertificate: boolean,
): PlatformOrgListItem => ({
  id: org.id,
  name: org.name,
  gstin: org.gstin,
  city: org.city,
  state: org.state,
  status: org.status,
  userCount: org._count?.users ?? 0,
  tenderCount: org._count?.tenders ?? 0,
  completionScore: completionOf(org, hasGstCertificate).score,
  createdAt: org.createdAt.toISOString(),
});
