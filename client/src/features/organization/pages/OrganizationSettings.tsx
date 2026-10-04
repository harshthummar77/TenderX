import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import {
  INDIAN_STATES,
  updateOrgSchema,
  updateSettingsSchema,
  type UpdateOrgInput,
  type UpdateSettingsInput,
} from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { useAuth } from '@/hooks/useAuth';
import { useQueryTab } from '@/hooks/useQueryTab';
import { PERMISSIONS as P } from '@tb/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { Completion } from '@/components/data/Completion';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FileUpload } from '@/components/form/FileUpload';
import { FormField, FormGrid } from '@/components/form/FormField';
import { PageHeader } from '@/components/layout/PageHeader';
import { Forbidden } from '@/components/Forbidden';
import { FormError } from '@/features/auth/components/AuthLayout';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import {
  useMyOrganization,
  useOrgSettings,
  useUpdateOrganization,
  useUpdateOrgSettings,
} from '@/features/organization/api';

const STATE_OPTIONS = INDIAN_STATES.map((state) => ({
  value: state.code,
  label: `${state.name} (${state.code})`,
}));

/**
 * `/settings/organization` — profile, KYC documents and the settings that drive
 * the rest of the system (match tolerance, approval threshold, number prefixes).
 */
export function OrganizationSettingsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useQueryTab('profile');
  const organization = useMyOrganization();

  if (!can(P.ORG_VIEW)) return <Forbidden />;

  const canEdit = can(P.ORG_UPDATE);

  return (
    <>
      <PageHeader
        title="Organization"
        description="Your company's record, documents and procurement settings."
        status={organization.data?.status}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="profile">Profile</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="settings">Settings</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        <TabPanel value="profile">
          {organization.isLoading && <Skeleton className="h-64 w-full" />}
          {organization.data && <ProfileForm organization={organization.data} canEdit={canEdit} />}
        </TabPanel>

        <TabPanel value="documents">
          <Card>
            <CardHeader
              title="KYC documents"
              description="GST certificate and PAN. A platform administrator checks these before approving the organization."
            />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              {organization.data ? (
                <>
                  <div>
                    <p className="mb-2 text-xs font-medium">GST certificate</p>
                    <FileUpload
                      ownerType="ORGANIZATION"
                      ownerId={organization.data.id}
                      type="ORG_GST_CERTIFICATE"
                      disabled={!can(P.DOCUMENT_UPLOAD)}
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-medium">PAN card</p>
                    <FileUpload
                      ownerType="ORGANIZATION"
                      ownerId={organization.data.id}
                      type="ORG_PAN"
                      disabled={!can(P.DOCUMENT_UPLOAD)}
                    />
                  </div>
                </>
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="settings">
          <SettingsForm canEdit={canEdit} />
        </TabPanel>

        <TabPanel value="history">
          <HistoryTab entityType="Organization" entityId={organization.data?.id} />
        </TabPanel>
      </Tabs>
    </>
  );
}

function ProfileForm({
  organization,
  canEdit,
}: {
  organization: NonNullable<ReturnType<typeof useMyOrganization>['data']>;
  canEdit: boolean;
}) {
  const update = useUpdateOrganization();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<UpdateOrgInput>({
    resolver: zodResolver(updateOrgSchema),
    defaultValues: {
      name: organization.name,
      legalName: organization.legalName ?? '',
      email: organization.email,
      phone: organization.phone ?? '',
      gstin: organization.gstin ?? '',
      pan: organization.pan ?? '',
      addressLine1: organization.addressLine1,
      addressLine2: organization.addressLine2 ?? '',
      city: organization.city,
      state: organization.state,
      stateCode: organization.stateCode,
      pincode: organization.pincode,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    // Empty strings are not valid GSTINs or phone numbers; null clears a field.
    update.mutate(
      {
        ...values,
        legalName: values.legalName || null,
        phone: values.phone || null,
        gstin: values.gstin || null,
        pan: values.pan || null,
        addressLine2: values.addressLine2 || null,
      },
      {
        onSuccess: () => toast.success('Organization updated'),
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
        },
      },
    );
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <Card>
        <CardHeader title="Profile" />
        <CardBody>
          <FormError message={formError} />

          <form onSubmit={onSubmit} noValidate>
            <FormGrid>
              <FormField label="Name" name="name" required>
                <Input disabled={!canEdit} {...form.register('name')} />
              </FormField>
              <FormField label="Legal name" name="legalName">
                <Input disabled={!canEdit} {...form.register('legalName')} />
              </FormField>
              <FormField label="Email" name="email" required>
                <Input type="email" disabled={!canEdit} {...form.register('email')} />
              </FormField>
              <FormField label="Phone" name="phone">
                <Input inputMode="tel" maxLength={10} disabled={!canEdit} {...form.register('phone')} />
              </FormField>
              <FormField label="GSTIN" name="gstin">
                <Input
                  maxLength={15}
                  disabled={!canEdit}
                  className="font-mono uppercase"
                  {...form.register('gstin')}
                />
              </FormField>
              <FormField label="PAN" name="pan">
                <Input
                  maxLength={10}
                  disabled={!canEdit}
                  className="font-mono uppercase"
                  {...form.register('pan')}
                />
              </FormField>

              <FormField label="Address line 1" name="addressLine1" required className="sm:col-span-2">
                <Input disabled={!canEdit} {...form.register('addressLine1')} />
              </FormField>
              <FormField label="Address line 2" name="addressLine2" className="sm:col-span-2">
                <Input disabled={!canEdit} {...form.register('addressLine2')} />
              </FormField>
              <FormField label="City" name="city" required>
                <Input disabled={!canEdit} {...form.register('city')} />
              </FormField>
              <FormField label="Pincode" name="pincode" required>
                <Input inputMode="numeric" maxLength={6} disabled={!canEdit} {...form.register('pincode')} />
              </FormField>

              <FormField
                label={
                  organization.stateCodeEditable ? (
                    'State'
                  ) : (
                    <Tooltip content="Frozen once a purchase order exists — it fixes the tax regime on every document already issued.">
                      <span className="inline-flex items-center gap-1">
                        State <Lock aria-hidden className="size-3" />
                      </span>
                    </Tooltip>
                  )
                }
                name="stateCode"
                required
                hint="Drives CGST/SGST versus IGST."
              >
                <Select
                  options={STATE_OPTIONS}
                  disabled={!canEdit || !organization.stateCodeEditable}
                  value={form.watch('stateCode') ?? ''}
                  onChange={(event) => {
                    const code = event.target.value;
                    const state = INDIAN_STATES.find((item) => item.code === code);
                    form.setValue('stateCode', code, { shouldValidate: true });
                    form.setValue('state', state?.name ?? '', { shouldValidate: true });
                  }}
                />
              </FormField>
            </FormGrid>

            {canEdit && (
              <div className="mt-4 flex justify-end">
                <Button type="submit" loading={update.isPending}>
                  Save changes
                </Button>
              </div>
            )}
          </form>
        </CardBody>
      </Card>

      <Card className="h-fit">
        <CardHeader title="Completeness" />
        <CardBody>
          <Completion
            score={organization.completion.score}
            checks={organization.completion.checks}
          />
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs text-muted">Status</p>
            <div className="mt-1">
              <StatusBadge status={organization.status} size="md" />
            </div>
            {organization.status === 'PENDING_APPROVAL' && (
              <p className="mt-2 text-xs text-muted">
                A platform administrator approves new organizations. You can finish your profile and
                add documents while you wait — tenders unlock on approval.
              </p>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function SettingsForm({ canEdit }: { canEdit: boolean }) {
  const settings = useOrgSettings();
  const update = useUpdateOrgSettings();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<UpdateSettingsInput>({
    resolver: zodResolver(updateSettingsSchema),
    values: settings.data
      ? {
          matchTolerancePercent: settings.data.matchTolerancePercent,
          approvalThresholdAmount: settings.data.approvalThresholdAmount,
          allowOfficerApproval: settings.data.allowOfficerApproval,
          requireGrnBeforeInvoice: settings.data.requireGrnBeforeInvoice,
          minVendorsPerTender: settings.data.minVendorsPerTender,
          defaultPaymentTermDays: settings.data.defaultPaymentTermDays,
          expectedResponseDays: settings.data.expectedResponseDays,
          defaultTaxRatePercent: settings.data.defaultTaxRatePercent,
          numberPrefixes: settings.data.numberPrefixes,
        }
      : undefined,
  });

  if (settings.isLoading) return <Skeleton className="h-64 w-full" />;

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    update.mutate(values, {
      onSuccess: () => toast.success('Settings saved'),
      onError: (error) => {
        if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
      },
    });
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-2" noValidate>
      <Card>
        <CardHeader title="Controls" description="These drive matching, approval and fulfilment." />
        <CardBody>
          <FormError message={formError} />

          <FormGrid>
            <FormField
              label="Match tolerance %"
              name="matchTolerancePercent"
              hint="Price variance allowed before the three-way match fails."
            >
              <Input
                type="number"
                step="0.1"
                min={0}
                max={10}
                disabled={!canEdit}
                {...form.register('matchTolerancePercent', { valueAsNumber: true })}
              />
            </FormField>

            <FormField
              label="Approval threshold ₹"
              name="approvalThresholdAmount"
              hint="Above this, an award, invoice or payment needs an admin's sign-off."
            >
              <Input
                type="number"
                min={0}
                disabled={!canEdit}
                {...form.register('approvalThresholdAmount', { valueAsNumber: true })}
              />
            </FormField>

            <FormField
              label="Minimum vendors per tender"
              name="minVendorsPerTender"
              hint="A tender cannot be published with fewer invitations."
            >
              <Input
                type="number"
                min={1}
                disabled={!canEdit}
                {...form.register('minVendorsPerTender', { valueAsNumber: true })}
              />
            </FormField>

            <FormField label="Default payment terms (days)" name="defaultPaymentTermDays">
              <Input
                type="number"
                min={0}
                disabled={!canEdit}
                {...form.register('defaultPaymentTermDays', { valueAsNumber: true })}
              />
            </FormField>

            <FormField
              label="PO response window (days)"
              name="expectedResponseDays"
              hint="After this, a pending order is flagged — never auto-cancelled."
            >
              <Input
                type="number"
                min={1}
                max={60}
                disabled={!canEdit}
                {...form.register('expectedResponseDays', { valueAsNumber: true })}
              />
            </FormField>

            <FormField label="Default GST rate %" name="defaultTaxRatePercent">
              <Input
                type="number"
                min={0}
                max={28}
                disabled={!canEdit}
                {...form.register('defaultTaxRatePercent', { valueAsNumber: true })}
              />
            </FormField>
          </FormGrid>

          <div className="mt-4 space-y-2 border-t border-border pt-4">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!canEdit}
                className="mt-0.5 accent-primary"
                {...form.register('requireGrnBeforeInvoice')}
              />
              <span>
                Require a goods receipt before an invoice
                <span className="block text-xs text-muted">
                  Recommended. Without it a vendor can bill for goods nobody has checked in.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!canEdit}
                className="mt-0.5 accent-primary"
                {...form.register('allowOfficerApproval')}
              />
              <span>
                Let below-threshold awards clear without a second person
                <span className="block text-xs text-muted">
                  Off by default, deliberately: the point of the approval step is that somebody
                  other than the requester signs off.
                </span>
              </span>
            </label>
          </div>
        </CardBody>
      </Card>

      <Card className="h-fit">
        <CardHeader
          title="Document prefixes"
          description="Used in every generated number: PO/2025-26/000042."
        />
        <CardBody>
          <FormGrid>
            {(
              [
                ['TENDER', 'Tender'],
                ['QUOTATION', 'Quotation'],
                ['PURCHASE_ORDER', 'Purchase order'],
                ['GRN', 'Goods receipt'],
                ['INVOICE', 'Invoice'],
                ['PAYMENT', 'Payment'],
              ] as const
            ).map(([key, label]) => (
              <FormField key={key} label={label} name={`numberPrefixes.${key}`}>
                <Input
                  maxLength={8}
                  disabled={!canEdit}
                  className="font-mono uppercase"
                  {...form.register(`numberPrefixes.${key}`)}
                />
              </FormField>
            ))}
          </FormGrid>

          {canEdit && (
            <div className="mt-4 flex justify-end">
              <Button type="submit" loading={update.isPending}>
                Save settings
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </form>
  );
}
