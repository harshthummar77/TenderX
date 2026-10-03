import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toApiError } from '@/lib/api';

/**
 * The server-validation bridge (plan 16 §2).
 *
 * The API reports a 422 as `error.fields[] = [{ path, message }]`, `toApiError`
 * flattens that to `fieldErrors`, and this walks it into React Hook Form. Because
 * the server's `path` is the same dotted path the form uses for its input names
 * (`organization.gstin`, `items.3.rate`), a server-side rule the client cannot
 * check — a GSTIN checksum, a duplicate email, a quantity over the PO balance —
 * lands on the right input with no per-form code.
 *
 * Written once; every form in the app benefits.
 *
 * Returns true when at least one message was attached, so a caller can decide
 * whether a toast is still needed:
 *
 *   onError: (error) => {
 *     if (!applyFieldErrors(error, form.setError)) toast.fromError(error);
 *   }
 */
export function applyFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
): boolean {
  const { fieldErrors } = toApiError(error);
  const entries = Object.entries(fieldErrors);
  if (entries.length === 0) return false;

  for (const [path, message] of entries) {
    setError(path as Path<T>, { type: 'server', message });
  }
  return true;
}

/**
 * Attach what the server said, and return a message for anything that was not
 * field-specific ("Invalid email or password") so a form can show it at the top.
 */
export function formErrorMessage(error: unknown): string | null {
  const apiError = toApiError(error);
  return Object.keys(apiError.fieldErrors).length > 0 ? null : apiError.message;
}
