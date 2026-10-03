import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  INDIAN_STATES,
  PASSWORD_MIN_LENGTH,
  registerOrganizationSchema,
  registerVendorSchema,
  type RegisterOrganizationInput,
  type RegisterVendorInput,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { applyFieldErrors, formErrorMessage } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormField, FormGrid } from '@/components/form/FormField';
import { AuthLayout, FormError } from '@/features/auth/components/AuthLayout';
import { useRegisterOrganization, useRegisterVendor } from '@/features/auth/api';

/**
 * Self-registration for both party types.
 *
 * Neither path grants access to anything: an organization lands in
 * PENDING_APPROVAL for a platform admin, a vendor in PENDING_APPROVAL for the
 * buyer (plans 05 and 06). The account exists, signed in, and sees a "waiting for
 * approval" dashboard — which is honest, and better than a dead login.
 */

const STATE_OPTIONS = INDIAN_STATES.map((state) => ({
  value: state.code,
  label: `${state.name} (${state.code})`,
}));

/**
 * The address block, shared by both registrations.
 *
 * `useFormContext<any>` on purpose: the two forms have different shapes
 * (`organization.*` / `vendor.*`) and threading a generic prefix through RHF's
 * `Path<T>` types buys nothing here — the paths are validated by the Zod schema
 * on submit and by the server after that.
 */
function AddressFields({ prefix }: { prefix: 'organization' | 'vendor' }) {
  const form = useFormContext<any>();

  return (
    <>
      <FormField label="Address line 1" name={`${prefix}.addressLine1`} required className="sm:col-span-2">
        <Input {...form.register(`${prefix}.addressLine1`)} />
      </FormField>

      <FormField label="Address line 2" name={`${prefix}.addressLine2`} className="sm:col-span-2">
        <Input {...form.register(`${prefix}.addressLine2`)} />
      </FormField>

      <FormField label="City" name={`${prefix}.city`} required>
        <Input {...form.register(`${prefix}.city`)} />
      </FormField>

      <FormField
        label="State"
        name={`${prefix}.stateCode`}
        required
        hint="The GST state code decides CGST/SGST versus IGST on every document."
      >
        <Select
          placeholder="Select a state"
          options={STATE_OPTIONS}
          value={form.watch(`${prefix}.stateCode`) ?? ''}
          onChange={(event) => {
            const code = event.target.value;
            const state = INDIAN_STATES.find((item) => item.code === code);
            // Both fields are stored: the code drives tax, the name prints on documents.
            form.setValue(`${prefix}.stateCode`, code, { shouldValidate: true });
            form.setValue(`${prefix}.state`, state?.name ?? '', { shouldValidate: true });
          }}
        />
      </FormField>

      <FormField label="Pincode" name={`${prefix}.pincode`} required>
        <Input inputMode="numeric" maxLength={6} {...form.register(`${prefix}.pincode`)} />
      </FormField>
    </>
  );
}

function AdminFields() {
  const form = useFormContext<any>();

  return (
    <>
      <FormField label="Your full name" name="admin.fullName" required>
        <Input autoComplete="name" {...form.register('admin.fullName')} />
      </FormField>

      <FormField label="Your email" name="admin.email" required>
        <Input type="email" autoComplete="username" {...form.register('admin.email')} />
      </FormField>

      <FormField
        label="Password"
        name="admin.password"
        required
        hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a digit.`}
      >
        <Input type="password" autoComplete="new-password" {...form.register('admin.password')} />
      </FormField>

      <FormField label="Your phone" name="admin.phone" hint="10-digit Indian mobile.">
        <Input inputMode="tel" maxLength={10} {...form.register('admin.phone')} />
      </FormField>
    </>
  );
}

function OrganizationForm() {
  const navigate = useNavigate();
  const register = useRegisterOrganization();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<RegisterOrganizationInput>({
    resolver: zodResolver(registerOrganizationSchema),
    defaultValues: {
      organization: {
        name: '',
        legalName: '',
        email: '',
        phone: '',
        gstin: '',
        pan: '',
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        stateCode: '',
        pincode: '',
        country: 'IN',
      },
      admin: { fullName: '', email: '', password: '', phone: '' },
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    // The schema treats these as optional, and "" is not a valid GSTIN or phone.
    const cleaned: RegisterOrganizationInput = {
      ...values,
      organization: {
        ...values.organization,
        legalName: values.organization.legalName || undefined,
        phone: values.organization.phone || undefined,
        gstin: values.organization.gstin || undefined,
        pan: values.organization.pan || undefined,
        addressLine2: values.organization.addressLine2 || undefined,
      },
      admin: { ...values.admin, phone: values.admin.phone || undefined },
    };

    register.mutate(cleaned, {
      onSuccess: () => navigate('/dashboard', { replace: true }),
      onError: (error) => {
        if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
      },
    });
  });

  return (
    <FormProvider {...form}>
      <FormError message={formError} />
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <section>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">
            Organization
          </h2>
          <FormGrid>
            <FormField label="Organization name" name="organization.name" required>
              <Input {...form.register('organization.name')} />
            </FormField>
            <FormField label="Legal name" name="organization.legalName">
              <Input {...form.register('organization.legalName')} />
            </FormField>
            <FormField label="Organization email" name="organization.email" required>
              <Input type="email" {...form.register('organization.email')} />
            </FormField>
            <FormField label="Organization phone" name="organization.phone">
              <Input inputMode="tel" maxLength={10} {...form.register('organization.phone')} />
            </FormField>
            <FormField label="GSTIN" name="organization.gstin" hint="Checked for structure and check digit.">
              <Input maxLength={15} className="font-mono uppercase" {...form.register('organization.gstin')} />
            </FormField>
            <FormField label="PAN" name="organization.pan">
              <Input maxLength={10} className="font-mono uppercase" {...form.register('organization.pan')} />
            </FormField>
            <AddressFields prefix="organization" />
          </FormGrid>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">
            Your admin account
          </h2>
          <FormGrid>
            <AdminFields />
          </FormGrid>
        </section>

        <Button type="submit" className="w-full" loading={register.isPending}>
          Create organization
        </Button>
        <p className="text-center text-xs text-muted">
          A platform administrator approves new organizations before tenders can be published.
        </p>
      </form>
    </FormProvider>
  );
}

function VendorForm() {
  const navigate = useNavigate();
  const register = useRegisterVendor();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<RegisterVendorInput>({
    resolver: zodResolver(registerVendorSchema),
    defaultValues: {
      vendor: {
        companyName: '',
        legalName: '',
        email: '',
        phone: '',
        gstin: '',
        pan: '',
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        stateCode: '',
        pincode: '',
        country: 'IN',
      },
      admin: { fullName: '', email: '', password: '', phone: '' },
      categoryIds: [],
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFormError(null);
    const cleaned: RegisterVendorInput = {
      ...values,
      vendor: {
        ...values.vendor,
        legalName: values.vendor.legalName || undefined,
        gstin: values.vendor.gstin || undefined,
        pan: values.vendor.pan || undefined,
        addressLine2: values.vendor.addressLine2 || undefined,
      },
      admin: { ...values.admin, phone: values.admin.phone || undefined },
    };

    register.mutate(cleaned, {
      onSuccess: () => navigate('/dashboard', { replace: true }),
      onError: (error) => {
        if (!applyFieldErrors(error, form.setError)) setFormError(formErrorMessage(error));
      },
    });
  });

  return (
    <FormProvider {...form}>
      <FormError message={formError} />
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <section>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">Company</h2>
          <FormGrid>
            <FormField label="Company name" name="vendor.companyName" required>
              <Input {...form.register('vendor.companyName')} />
            </FormField>
            <FormField label="Legal name" name="vendor.legalName">
              <Input {...form.register('vendor.legalName')} />
            </FormField>
            <FormField label="Company email" name="vendor.email" required>
              <Input type="email" {...form.register('vendor.email')} />
            </FormField>
            <FormField label="Company phone" name="vendor.phone" required>
              <Input inputMode="tel" maxLength={10} {...form.register('vendor.phone')} />
            </FormField>
            <FormField label="GSTIN" name="vendor.gstin" hint="Required before you can be awarded a tender.">
              <Input maxLength={15} className="font-mono uppercase" {...form.register('vendor.gstin')} />
            </FormField>
            <FormField label="PAN" name="vendor.pan">
              <Input maxLength={10} className="font-mono uppercase" {...form.register('vendor.pan')} />
            </FormField>
            <AddressFields prefix="vendor" />
          </FormGrid>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-muted uppercase">
            Your account
          </h2>
          <FormGrid>
            <AdminFields />
          </FormGrid>
        </section>

        <Button type="submit" className="w-full" loading={register.isPending}>
          Register as a vendor
        </Button>
        <p className="text-center text-xs text-muted">
          A buyer approves your profile before you can bid. You can add documents while you wait.
        </p>
      </form>
    </FormProvider>
  );
}

export function RegisterPage() {
  const [mode, setMode] = useState<'organization' | 'vendor'>('organization');

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Register the party you act for. Staff logins are created by invitation instead."
      wide
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <div
        role="tablist"
        aria-label="Account type"
        className="mb-5 inline-flex rounded-md border border-border p-0.5"
      >
        {(
          [
            ['organization', 'Buying organization'],
            ['vendor', 'Supplier / vendor'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-colors',
              mode === value ? 'bg-primary text-on-primary' : 'text-muted hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'organization' ? <OrganizationForm /> : <VendorForm />}
    </AuthLayout>
  );
}
