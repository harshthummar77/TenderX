import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, Save, Send } from 'lucide-react';
import {
  INDIAN_STATES,
  type CreateTenderInput,
  type Criterion,
  type TenderBuyerDto,
  type TenderItemInput,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { toApiError } from '@/lib/api';
import {
  formatDateTime,
  formatMoney,
  formatQty,
  multiplyQtyRate,
  addMoney,
  toMoneyString,
} from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Field, FieldGrid } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { DatePicker } from '@/components/form/DatePicker';
import { FormField, FormGrid } from '@/components/form/FormField';
import { ItemsEditor, emptyItem, type EditableItem } from '@/components/form/ItemsEditor';
import { MoneyInput } from '@/components/form/MoneyInput';
import { PageHeader } from '@/components/layout/PageHeader';
import { FormError } from '@/features/auth/components/AuthLayout';
import { CriteriaEditor, defaultCriteria } from '@/features/tenders/components/CriteriaEditor';
import { VendorPicker } from '@/features/tenders/components/VendorPicker';
import {
  useCreateTender,
  useInviteVendors,
  usePublishTender,
  useSuggestedVendors,
  useTenderInvitations,
  useUpdateTender,
} from '@/features/tenders/api';
import { useCategories } from '@/features/vendors/api';
import { useOrgSettings } from '@/features/organization/api';

/**
 * The tender creation wizard (plan 17 §3).
 *
 * Four steps plus a review, with all state in one place. The step order follows
 * the API's own constraints rather than a tidy-looking form: steps 1–3 collect
 * everything `createTenderSchema` requires, and only then does the draft exist
 * to hang invitations off — `/tenders/:id/suggested-vendors` needs a tender to
 * suggest for, and the server has no half-valid draft state to save into before
 * that.
 *
 * Which is why the crash protection on steps 1–3 is local: the wizard's own
 * state is mirrored into `localStorage` on every change, so a closed tab costs
 * nothing, and it is cleared the moment the draft reaches the server. From step
 * 4 on, the draft IS on the server and every step change PATCHes it.
 */

const DRAFT_KEY = 'tb.tenderWizard.draft';

const STATE_OPTIONS = INDIAN_STATES.map((state) => ({
  value: state.code,
  label: `${state.name} (${state.code})`,
}));

interface WizardState {
  title: string;
  description: string;
  categoryId: string;
  estimatedBudget: string;
  termsAndConditions: string;
  items: EditableItem[];
  deliveryLocation: string;
  deliveryStateCode: string;
  deliveryDeadline: string | null;
  bidSubmissionDeadline: string | null;
  evaluationMethod: 'LOWEST_PRICE' | 'WEIGHTED_SCORE';
  criteria: Criterion[];
}

const emptyState = (): WizardState => ({
  title: '',
  description: '',
  categoryId: '',
  estimatedBudget: '',
  termsAndConditions: '',
  items: [emptyItem()],
  deliveryLocation: '',
  deliveryStateCode: '',
  deliveryDeadline: null,
  bidSubmissionDeadline: null,
  evaluationMethod: 'LOWEST_PRICE',
  criteria: defaultCriteria(),
});

/** An existing draft, loaded back into wizard shape. */
const fromTender = (tender: TenderBuyerDto): WizardState => ({
  title: tender.title,
  description: tender.description,
  categoryId: tender.category?.id ?? '',
  estimatedBudget: tender.estimatedBudget ?? '',
  termsAndConditions: tender.termsAndConditions ?? '',
  items: tender.items.map((item) => ({
    key: item.id,
    description: item.description,
    hsnSac: item.hsnCode ?? '',
    unit: item.unit,
    quantity: item.quantity,
    rate: item.estimatedUnitPrice ?? '',
    taxRate: Number(item.taxRatePercent),
  })),
  deliveryLocation: tender.deliveryLocation,
  deliveryStateCode: tender.deliveryStateCode,
  deliveryDeadline: tender.deliveryDeadline,
  bidSubmissionDeadline: tender.bidSubmissionDeadline,
  evaluationMethod: tender.evaluationMethod === 'WEIGHTED_SCORE' ? 'WEIGHTED_SCORE' : 'LOWEST_PRICE',
  criteria: tender.criteria.length > 0 ? tender.criteria : defaultCriteria(),
});

/** Wizard rows become the API's item shape; `srNo` is the row order, 1..n. */
const toItems = (items: EditableItem[]): TenderItemInput[] =>
  items.map((item, index) => ({
    srNo: index + 1,
    description: item.description.trim(),
    hsnCode: item.hsnSac.trim() || undefined,
    unit: item.unit as TenderItemInput['unit'],
    quantity: item.quantity,
    taxRatePercent: item.taxRate.toFixed(2),
    // The buyer's internal ceiling. It is never serialised to a vendor (07 §6).
    estimatedUnitPrice: item.rate ? toMoneyString(item.rate) : undefined,
  }));

const STEPS = ['Basics', 'Line items', 'Timeline & evaluation', 'Vendors', 'Review'] as const;

export function TenderWizard({ tender }: { tender?: TenderBuyerDto }) {
  const navigate = useNavigate();
  const isEdit = !!tender;

  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [draftId, setDraftId] = useState<string | undefined>(tender?.id);
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);

  const [state, setState] = useState<WizardState>(() => {
    if (tender) return fromTender(tender);
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) return { ...emptyState(), ...(JSON.parse(saved) as WizardState) };
    } catch {
      // A corrupt or blocked store is not a reason to fail to open the wizard.
    }
    return emptyState();
  });

  const categories = useCategories();
  const settings = useOrgSettings();
  const invitations = useTenderInvitations(draftId);
  const suggestions = useSuggestedVendors(draftId, step === 3);

  const create = useCreateTender();
  const update = useUpdateTender(draftId);
  const invite = useInviteVendors(draftId);
  const publish = usePublishTender();

  const minVendors = settings.data?.minVendorsPerTender ?? 3;
  const alreadyInvited = useMemo(
    () => (invitations.data ?? []).map((row) => row.vendorId),
    [invitations.data],
  );

  // Crash protection for the steps that exist only in the browser.
  useEffect(() => {
    if (isEdit) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
    } catch {
      // Private mode or a blocked store: the wizard still works, it just will
      // not survive a crash.
    }
  }, [state, isEdit]);

  useEffect(() => {
    if (draftId) setSelectedVendors(alreadyInvited);
  }, [draftId, alreadyInvited]);

  const patch = (changes: Partial<WizardState>) => setState((current) => ({ ...current, ...changes }));

  const totals = useMemo(() => {
    let estimate = '0.00';
    for (const item of state.items) {
      if (item.quantity && item.rate) {
        estimate = addMoney(estimate, multiplyQtyRate(item.quantity, item.rate));
      }
    }
    return estimate;
  }, [state.items]);

  /* ----------------------------- validation ------------------------------ */

  const stepErrors = (index: number): string[] => {
    const problems: string[] = [];

    if (index === 0) {
      if (state.title.trim().length < 5) problems.push('Give the tender a title of at least 5 characters.');
      if (state.description.trim().length < 10)
        problems.push('Describe what you are buying in at least 10 characters.');
    }

    if (index === 1) {
      if (state.items.length === 0) problems.push('Add at least one line item.');
      state.items.forEach((item, i) => {
        if (item.description.trim().length < 3)
          problems.push(`Line ${i + 1}: describe the item in at least 3 characters.`);
        if (!item.quantity || Number(item.quantity) <= 0)
          problems.push(`Line ${i + 1}: quantity must be greater than zero.`);
      });
    }

    if (index === 2) {
      if (state.deliveryLocation.trim().length < 3) problems.push('Where should the goods be delivered?');
      if (!state.deliveryStateCode) problems.push('Pick the delivery state — it decides the tax regime.');
      if (!state.bidSubmissionDeadline) problems.push('Set a bid submission deadline.');
      if (!state.deliveryDeadline) problems.push('Set a delivery deadline.');
      if (state.bidSubmissionDeadline && new Date(state.bidSubmissionDeadline).getTime() < Date.now() + 3600_000)
        problems.push('The bid deadline must be at least an hour from now.');
      if (
        state.bidSubmissionDeadline &&
        state.deliveryDeadline &&
        new Date(state.deliveryDeadline) <= new Date(state.bidSubmissionDeadline)
      )
        problems.push('Delivery must be after the bid deadline.');
      if (
        state.evaluationMethod === 'WEIGHTED_SCORE' &&
        state.criteria.reduce((sum, c) => sum + c.weight, 0) !== 100
      )
        problems.push('Criteria weights must total exactly 100.');
    }

    return problems;
  };

  const payload = (): CreateTenderInput =>
    ({
      title: state.title.trim(),
      description: state.description.trim(),
      categoryId: state.categoryId || undefined,
      estimatedBudget: state.estimatedBudget ? toMoneyString(state.estimatedBudget) : undefined,
      deliveryLocation: state.deliveryLocation.trim(),
      deliveryStateCode: state.deliveryStateCode,
      deliveryDeadline: state.deliveryDeadline as string,
      bidSubmissionDeadline: state.bidSubmissionDeadline as string,
      evaluationMethod: state.evaluationMethod,
      criteria: state.evaluationMethod === 'WEIGHTED_SCORE' ? state.criteria : undefined,
      termsAndConditions: state.termsAndConditions.trim() || undefined,
      items: toItems(state.items),
    }) as CreateTenderInput;

  const handleApiError = (error: unknown) => {
    const apiError = toApiError(error);
    setFieldErrors(apiError.fieldErrors);
    setFormError(
      Object.keys(apiError.fieldErrors).length > 0
        ? `${apiError.message} — see the highlighted fields.`
        : apiError.message,
    );
    toast.fromError(error);
  };

  /** Persist steps 1–3: create on first save, PATCH afterwards. */
  const saveDraft = async (): Promise<string | undefined> => {
    setFormError(null);
    setFieldErrors({});

    try {
      if (draftId) {
        await update.mutateAsync(payload());
        return draftId;
      }
      const created = await create.mutateAsync(payload());
      setDraftId(created.id);
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // Nothing to clean up if the store was never available.
      }
      return created.id;
    } catch (error) {
      handleApiError(error);
      return undefined;
    }
  };

  const next = async () => {
    const problems = stepErrors(step);
    if (problems.length > 0) {
      setFormError(problems[0] ?? 'Fix the highlighted fields.');
      return;
    }
    setFormError(null);

    // Leaving step 3 is the moment the tender can first exist server-side.
    if (step === 2) {
      const id = await saveDraft();
      if (!id) return;
      toast.success('Draft saved');
    }

    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const saveAndExit = async () => {
    const problems = [0, 1, 2].flatMap(stepErrors);
    if (problems.length > 0) {
      setFormError(problems[0] ?? 'Fix the highlighted fields.');
      return;
    }
    const id = await saveDraft();
    if (!id) return;
    toast.success('Draft saved');
    navigate(`/tenders/${id}`);
  };

  const onPublish = async () => {
    const id = draftId ?? (await saveDraft());
    if (!id) return;

    if (selectedVendors.length > 0) {
      const toInvite = selectedVendors.filter((vendorId) => !alreadyInvited.includes(vendorId));
      if (toInvite.length > 0) {
        try {
          await invite.mutateAsync(toInvite);
        } catch (error) {
          handleApiError(error);
          return;
        }
      }
    }

    publish.mutate(id, {
      onSuccess: () => {
        toast.success('Tender published', 'Invited vendors have been notified.');
        navigate(`/tenders/${id}`);
      },
      onError: handleApiError,
    });
  };

  const busy = create.isPending || update.isPending || invite.isPending || publish.isPending;

  return (
    <>
      <PageHeader
        title={isEdit ? `Edit ${tender.referenceNumber ?? 'draft'}` : 'New tender'}
        description="Four steps. The draft is saved before vendors are invited, and nothing is visible to them until you publish."
        crumbs={[{ label: 'Tenders', to: '/tenders' }, { label: isEdit ? 'Edit' : 'New' }]}
      />

      <ol className="mb-5 flex flex-wrap items-center gap-1">
        {STEPS.map((label, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={label} className="flex items-center gap-1">
              <button
                type="button"
                // Jumping forward past unfilled steps would submit an invalid payload.
                disabled={index > step}
                onClick={() => setStep(index)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  active && 'bg-primary text-on-primary',
                  !active && done && 'text-primary hover:bg-subtle',
                  !active && !done && 'text-muted',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 items-center justify-center rounded-full border text-[10px]',
                    active ? 'border-on-primary' : done ? 'border-primary' : 'border-border',
                  )}
                >
                  {done ? <Check aria-hidden className="size-2.5" /> : index + 1}
                </span>
                {label}
              </button>
              {index < STEPS.length - 1 && <ChevronRight aria-hidden className="size-3 text-muted" />}
            </li>
          );
        })}
      </ol>

      <FormError message={formError} />

      {step === 0 && (
        <Card>
          <CardHeader title="Basics" description="What you are buying, and roughly what it is worth." />
          <CardBody>
            <FormGrid columns={2}>
              <FormField label="Title" required error={fieldErrors.title} className="sm:col-span-2">
                <Input
                  value={state.title}
                  autoFocus
                  placeholder="Supply of 24-port network switches"
                  onChange={(event) => patch({ title: event.target.value })}
                />
              </FormField>

              <FormField
                label="Description"
                required
                error={fieldErrors.description}
                className="sm:col-span-2"
                hint="Vendors read this first. Say what the job is, not just what the item is."
              >
                <Textarea
                  rows={4}
                  value={state.description}
                  onChange={(event) => patch({ description: event.target.value })}
                />
              </FormField>

              <FormField label="Category" error={fieldErrors.categoryId} hint="Drives vendor suggestions.">
                <Select
                  placeholder="No category"
                  options={(categories.data ?? []).map((category) => ({
                    value: category.id,
                    label: category.name,
                  }))}
                  value={state.categoryId}
                  onChange={(event) => patch({ categoryId: event.target.value })}
                />
              </FormField>

              <FormField
                label="Estimated budget"
                error={fieldErrors.estimatedBudget}
                hint="Internal only — vendors never see it."
              >
                <MoneyInput
                  value={state.estimatedBudget}
                  onChange={(value) => patch({ estimatedBudget: value })}
                />
              </FormField>

              <FormField
                label="Terms and conditions"
                error={fieldErrors.termsAndConditions}
                className="sm:col-span-2"
              >
                <Textarea
                  rows={4}
                  value={state.termsAndConditions}
                  onChange={(event) => patch({ termsAndConditions: event.target.value })}
                  placeholder="Payment terms, warranty, penalties, delivery conditions…"
                />
              </FormField>
            </FormGrid>
          </CardBody>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader
            title="Line items"
            description="Paste a block straight from a spreadsheet — description, HSN, unit, quantity, estimated rate."
            actions={
              <span className="font-mono text-xs tabular-nums text-muted">
                Estimate {formatMoney(totals)}
              </span>
            }
          />
          <CardBody>
            <ItemsEditor
              items={state.items}
              onChange={(items) => patch({ items })}
              rateLabel="Est. rate"
              showTax
              maxRows={50}
              errors={Object.fromEntries(
                Object.entries(fieldErrors)
                  .filter(([path]) => path.startsWith('items.'))
                  .map(([path, message]) => [path.replace('items.', ''), message]),
              )}
            />
            <p className="mt-2 text-xs text-muted">
              The estimated rate is your internal ceiling. It is stored on the tender and never sent
              to a vendor.
            </p>
          </CardBody>
        </Card>
      )}

      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Delivery and deadlines" />
            <CardBody>
              <FormGrid columns={1}>
                <FormField label="Delivery location" required error={fieldErrors.deliveryLocation}>
                  <Input
                    value={state.deliveryLocation}
                    placeholder="Warehouse 2, MIDC Bhosari, Pune"
                    onChange={(event) => patch({ deliveryLocation: event.target.value })}
                  />
                </FormField>

                <FormField
                  label="Delivery state"
                  required
                  error={fieldErrors.deliveryStateCode}
                  hint="The place of supply — it decides CGST/SGST versus IGST on every document that follows."
                >
                  <Select
                    placeholder="Select a state"
                    options={STATE_OPTIONS}
                    value={state.deliveryStateCode}
                    onChange={(event) => patch({ deliveryStateCode: event.target.value })}
                  />
                </FormField>

                <FormField
                  label="Bid submission deadline"
                  required
                  error={fieldErrors.bidSubmissionDeadline}
                  hint="Bids stay sealed until this moment. At least an hour from now."
                >
                  <DatePicker
                    mode="datetime"
                    value={state.bidSubmissionDeadline}
                    onChange={(iso) => patch({ bidSubmissionDeadline: iso })}
                  />
                </FormField>

                <FormField
                  label="Delivery deadline"
                  required
                  error={fieldErrors.deliveryDeadline}
                  hint="Must be after the bid deadline."
                >
                  <DatePicker
                    mode="datetime"
                    value={state.deliveryDeadline}
                    onChange={(iso) => patch({ deliveryDeadline: iso })}
                  />
                </FormField>
              </FormGrid>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Evaluation" description="How the winning bid is chosen." />
            <CardBody>
              <FormField label="Method" required error={fieldErrors.evaluationMethod}>
                <Select
                  value={state.evaluationMethod}
                  options={[
                    { value: 'LOWEST_PRICE', label: 'Lowest price' },
                    { value: 'WEIGHTED_SCORE', label: 'Weighted score' },
                  ]}
                  onChange={(event) =>
                    patch({ evaluationMethod: event.target.value as WizardState['evaluationMethod'] })
                  }
                />
              </FormField>

              {state.evaluationMethod === 'WEIGHTED_SCORE' ? (
                <div className="mt-4">
                  <CriteriaEditor
                    criteria={state.criteria}
                    onChange={(criteria) => patch({ criteria })}
                    error={fieldErrors.criteria}
                  />
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted">
                  The cheapest compliant bid wins. You can still score bids by hand on the comparison
                  screen, but the ranking follows price.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader
            title="Invite vendors"
            description="Only invited vendors can see this tender or bid on it."
          />
          <CardBody>
            <VendorPicker
              selected={selectedVendors}
              onChange={setSelectedVendors}
              suggestions={suggestions.data}
              isLoadingSuggestions={suggestions.isLoading}
              minimum={minVendors}
            />
          </CardBody>
        </Card>
      )}

      {step === 4 && (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Card>
              <CardHeader title={state.title || 'Untitled tender'} />
              <CardBody>
                <p className="mb-4 text-sm whitespace-pre-wrap">{state.description}</p>
                <FieldGrid className="grid-cols-2 sm:grid-cols-3">
                  <Field label="Category">
                    {categories.data?.find((c) => c.id === state.categoryId)?.name ?? '—'}
                  </Field>
                  <Field label="Estimated budget" numeric>
                    {state.estimatedBudget ? formatMoney(state.estimatedBudget) : '—'}
                  </Field>
                  <Field label="Evaluation">
                    {state.evaluationMethod === 'WEIGHTED_SCORE' ? 'Weighted score' : 'Lowest price'}
                  </Field>
                  <Field label="Delivery to" className="col-span-2">
                    {state.deliveryLocation}
                  </Field>
                  <Field label="Bids close">{formatDateTime(state.bidSubmissionDeadline)}</Field>
                  <Field label="Delivery by">{formatDateTime(state.deliveryDeadline)}</Field>
                </FieldGrid>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title={`${state.items.length} line items`} />
              <CardBody className="p-0">
                <table className="w-full text-sm">
                  <thead className="bg-subtle text-xs text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">#</th>
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Quantity</th>
                      <th className="px-3 py-2 text-right font-medium">Est. rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {state.items.map((item, index) => (
                      <tr key={item.key}>
                        <td className="px-3 py-2 font-mono text-xs tabular-nums text-muted">
                          {index + 1}
                        </td>
                        <td className="px-3 py-2">{item.description || '—'}</td>
                        <td className="numeric px-3 py-2">{formatQty(item.quantity, item.unit)}</td>
                        <td className="numeric px-3 py-2">
                          {item.rate ? formatMoney(item.rate) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          </div>

          <Card className="h-fit">
            <CardHeader title="Before publishing" />
            <CardBody className="space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span>Vendors invited</span>
                <span
                  className={cn(
                    'font-mono tabular-nums',
                    selectedVendors.length >= minVendors ? 'text-success' : 'text-danger',
                  )}
                >
                  {selectedVendors.length} / {minVendors}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Line items</span>
                <span className="font-mono tabular-nums">{state.items.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Estimate from your rates</span>
                <span className="font-mono tabular-nums">{formatMoney(totals)}</span>
              </div>

              <p className="border-t border-border pt-3 text-muted">
                Publishing notifies every invited vendor and locks the tender: items and deadlines
                cannot change once bids can be submitted.
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          disabled={step === 0 || busy}
          leftIcon={<ChevronLeft className="size-3.5" />}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
        >
          Back
        </Button>

        <div className="flex items-center gap-2">
          {step >= 2 && (
            <Button
              variant="outline"
              loading={create.isPending || update.isPending}
              leftIcon={<Save className="size-3.5" />}
              onClick={saveAndExit}
            >
              Save draft
            </Button>
          )}

          {step < STEPS.length - 1 ? (
            <Button
              loading={busy}
              rightIcon={<ChevronRight className="size-3.5" />}
              onClick={next}
            >
              Continue
            </Button>
          ) : (
            <Button
              loading={busy}
              disabled={selectedVendors.length < minVendors}
              leftIcon={<Send className="size-3.5" />}
              onClick={onPublish}
            >
              Publish tender
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
