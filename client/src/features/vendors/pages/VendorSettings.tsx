import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldCheck } from 'lucide-react';
import {
  INDIAN_STATES,
  updateVendorSchema,
  type UpdateVendorInput,
  type VendorSelfDto,
} from '@tb/shared';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { useQueryTab } from '@/hooks/useQueryTab';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, FieldGrid } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { FileUpload } from '@/components/form/FileUpload';
import { FormField, FormGrid } from '@/components/form/FormField';
import { PageHeader } from '@/components/layout/PageHeader';
import { FormError } from '@/features/auth/components/AuthLayout';
import { HistoryTab } from '@/features/activity/components/HistoryTab';
import { Scorecard } from '@/features/vendors/components/Scorecard';
import {
  useCategories,
  useMyScorecard,
  useMyVendor,
  useUpdateMyCategories,
  useUpdateMyVendor,
} from '@/features/vendors/api';

const STATE_OPTIONS = INDIAN_STATES.map((state) => ({
  value: state.code,
  label: `${state.name} (${state.code})`,
}));

/**
 * `/settings/vendor` — the vendor's own record: profile, bank details,
 * categories and KYC documents.
 *
 * Bank details come back masked (`XXXXXX4821`) and are posted whole, so the raw
 * account number never round-trips through the browser unless the vendor is
 * deliberately replacing it.
 */
export function VendorSettingsPage() {
  const [tab, setTab] = useQueryTab('profile');
  const vendor = useMyVendor();
  const scorecard = useMyScorecard();

  return (
    <>
      <PageHeader
        title="My company"
        description="Your profile, bank details and documents."
        status={vendor.data?.status}
      />

      {vendor.data?.status === 'PENDING_APPROVAL' && (
        <Card className="mb-4 border-warning/40 bg-warning/5">
          <CardBody className="flex items-start gap-3 py-3">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-medium">Your profile is under review</p>
              <p className="text-xs text-muted">
                Complete your GSTIN, PAN, bank details and categories to speed it up. You can look
                at tenders now, but bidding unlocks on approval.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {vendor.data?.statusReason && (
        <Card className="mb-4 border-danger/40 bg-danger/5">
          <CardBody className="py-3">
            <p className="text-sm font-medium">Reviewer's note</p>
            <p className="text-xs text-muted">{vendor.data.statusReason}</p>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList>
          <Tab value="profile">Profile</Tab>
          <Tab value="bank">Bank</Tab>
          <Tab value="categories">Categories</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="performance">Performance</Tab>
          <Tab value="history">History</Tab>
        </TabList>

        {vendor.isLoading && <Skeleton className="mt-4 h-64 w-full" />}

        {vendor.data && (
          <>
            <TabPanel value="profile">
              <ProfileForm vendor={vendor.data} />
            </TabPanel>

            <TabPanel value="bank">
              <BankForm vendor={vendor.data} />
            </TabPanel>

            <TabPanel value="categories">
              <CategoriesForm vendor={vendor.data} />
            </TabPanel>

            <TabPanel value="documents">
              <Card>
                <CardHeader
                  title="KYC documents"
                  description="GST certificate, PAN and a cancelled cheque. The buyer's reviewer checks these."
                />
                <CardBody className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="mb-2 text-xs font-medium">GST certificate</p>
                    <FileUpload
                      ownerType="VENDOR"
                      ownerId={vendor.data.id}
                      type="VENDOR_GST_CERTIFICATE"
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-medium">PAN card</p>
                    <FileUpload ownerType="VENDOR" ownerId={vendor.data.id} type="VENDOR_PAN" />
                  </div>
                  <div>
                    <p className="mb-2 text-xs font-medium">Cancelled cheque</p>
                    <FileUpload
                      ownerType="VENDOR"
                      ownerId={vendor.data.id}
                      type="VENDOR_CANCELLED_CHEQUE"
                    />
                  </div>
                </CardBody>
              </Card>
            </TabPanel>

            <TabPanel value="performance">
              <Scorecard scorecard={scorecard.data} isLoading={scorecard.isLoading} />
            </TabPanel>

            <TabPanel value="history">
              <HistoryTab entityType="Vendor" entityId={vendor.data.id} />
            </TabPanel>
          </>
        )}
      </Tabs>
    </>
  );
}

function ProfileForm({ vendor }: { vendor: VendorSelfDto }) {
  const update = useUpdateMyVendor();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<UpdateVendorInput>({
    resolver: zodResolver(updateVendorSchema),
    defaultValues: {
      companyName: vendor.companyName,
      legalName: vendor.legalName ?? '',
      email: vendor.email,
      phone: vendor.phone,
      gstin: vendor.gstin ?? '',
      pan: vendor.pan ?? '',
      addressLine1: vendor.addressLine1,
      addressLine2: vendor.addressLine2 ?? '',
      city: vendor.city,
      state: vendor.state,
      stateCode: vendor.stateCode,
      pincode: vendor.pincode,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    update.mutate(
      {
        ...values,
        legalName: values.legalName || null,
        gstin: values.gstin || null,
        pan: values.pan || null,
        addressLine2: values.addressLine2 || null,
      },
      {
        onSuccess: () => toast.success('Profile updated'),
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
        },
      },
    );
  });

  return (
    <Card>
      <CardHeader title="Company profile" />
      <CardBody>
        <FormError message={formError} />

        <form onSubmit={onSubmit} noValidate>
          <FormGrid>
            <FormField label="Company name" name="companyName" required>
              <Input {...form.register('companyName')} />
            </FormField>
            <FormField label="Legal name" name="legalName">
              <Input {...form.register('legalName')} />
            </FormField>
            <FormField label="Email" name="email" required>
              <Input type="email" {...form.register('email')} />
            </FormField>
            <FormField label="Phone" name="phone" required>
              <Input inputMode="tel" maxLength={10} {...form.register('phone')} />
            </FormField>
            <FormField
              label="GSTIN"
              name="gstin"
              hint="Required before you can be awarded a tender."
            >
              <Input maxLength={15} className="font-mono uppercase" {...form.register('gstin')} />
            </FormField>
            <FormField label="PAN" name="pan">
              <Input maxLength={10} className="font-mono uppercase" {...form.register('pan')} />
            </FormField>

            <FormField label="Address line 1" name="addressLine1" required className="sm:col-span-2">
              <Input {...form.register('addressLine1')} />
            </FormField>
            <FormField label="Address line 2" name="addressLine2" className="sm:col-span-2">
              <Input {...form.register('addressLine2')} />
            </FormField>
            <FormField label="City" name="city" required>
              <Input {...form.register('city')} />
            </FormField>
            <FormField label="Pincode" name="pincode" required>
              <Input inputMode="numeric" maxLength={6} {...form.register('pincode')} />
            </FormField>
            <FormField
              label="State"
              name="stateCode"
              required
              hint="Your place of supply — it decides CGST/SGST versus IGST."
            >
              <Select
                options={STATE_OPTIONS}
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

          <div className="mt-4 flex justify-end">
            <Button type="submit" loading={update.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function BankForm({ vendor }: { vendor: VendorSelfDto }) {
  const update = useUpdateMyVendor();
  const [formError, setFormError] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState(false);

  const form = useForm<UpdateVendorInput>({
    resolver: zodResolver(updateVendorSchema),
    defaultValues: {
      bankName: vendor.bankName ?? '',
      bankAccountName: vendor.bankAccountName ?? '',
      bankAccountNumber: '',
      bankIfsc: vendor.bankIfsc ?? '',
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    update.mutate(
      {
        bankName: values.bankName || null,
        bankAccountName: values.bankAccountName || null,
        bankIfsc: values.bankIfsc || null,
        // Left out entirely unless it is being replaced, so an untouched form
        // cannot blank the account number on file.
        ...(editingAccount && values.bankAccountNumber
          ? { bankAccountNumber: values.bankAccountNumber }
          : {}),
      },
      {
        onSuccess: () => {
          toast.success('Bank details updated');
          setEditingAccount(false);
          form.setValue('bankAccountNumber', '');
        },
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
        },
      },
    );
  });

  return (
    <Card className="max-w-2xl">
      <CardHeader
        title="Bank details"
        description="Where payments are sent. Only the last four digits are ever shown back."
      />
      <CardBody>
        <FormError message={formError} />

        <form onSubmit={onSubmit} noValidate>
          <FormGrid>
            <FormField label="Bank name" name="bankName">
              <Input {...form.register('bankName')} />
            </FormField>
            <FormField label="Account holder" name="bankAccountName">
              <Input {...form.register('bankAccountName')} />
            </FormField>

            <FormField
              label="Account number"
              name="bankAccountNumber"
              hint={
                editingAccount
                  ? '9–18 digits.'
                  : `On file: ${vendor.bankAccountNumber ?? 'none yet'}`
              }
            >
              {editingAccount ? (
                <Input
                  inputMode="numeric"
                  autoFocus
                  className="font-mono"
                  {...form.register('bankAccountNumber')}
                />
              ) : (
                <Button
                  variant="outline"
                  className="w-full justify-start font-mono"
                  onClick={() => setEditingAccount(true)}
                >
                  {vendor.bankAccountNumber ?? 'Add an account number'}
                </Button>
              )}
            </FormField>

            <FormField label="IFSC" name="bankIfsc">
              <Input maxLength={11} className="font-mono uppercase" {...form.register('bankIfsc')} />
            </FormField>
          </FormGrid>

          <div className="mt-4 flex justify-end">
            <Button type="submit" loading={update.isPending}>
              Save bank details
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function CategoriesForm({ vendor }: { vendor: VendorSelfDto }) {
  const categories = useCategories();
  const update = useUpdateMyCategories();
  const [selected, setSelected] = useState<string[]>(vendor.categories.map((c) => c.id));

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <Card className="max-w-3xl">
      <CardHeader
        title="Categories"
        description="What you supply. Buyers filter the directory by these, and the suggestion engine matches tenders against them."
      />
      <CardBody>
        {categories.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <FieldGrid className="mb-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {(categories.data ?? []).map((category) => (
                <label key={category.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-primary"
                    checked={selected.includes(category.id)}
                    onChange={() => toggle(category.id)}
                  />
                  <span>
                    {category.name}
                    {category.description && (
                      <span className="block text-xs text-muted">{category.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </FieldGrid>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <p className="text-xs text-muted">
                {selected.length} selected
                {selected.length > 20 && (
                  <span className="text-danger"> — the limit is 20</span>
                )}
              </p>
              <Button
                loading={update.isPending}
                disabled={selected.length > 20}
                onClick={() =>
                  update.mutate(selected, {
                    onSuccess: () => toast.success('Categories updated'),
                    onError: (error) => toast.fromError(error),
                  })
                }
              >
                Save categories
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
