import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { FormField } from '@/components/form/FormField';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
  title: string;
  /** What will actually happen — spell out the consequence, not "Are you sure?". */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Cancel, reject, blacklist and override all require a reason: the audit row
   * is worthless without one, and these are the actions people ask about months
   * later. Off for a plain "discard this draft".
   */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonMinLength?: number;
  loading?: boolean;
  destructive?: boolean;
}

/**
 * Destructive-action confirmation (plan 16 §5).
 *
 * Deliberately not `window.confirm`: a native dialog cannot collect the reason,
 * cannot be styled, and blocks the event loop.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonMinLength = 10,
  loading = false,
  destructive = true,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  // Reopening must not inherit the last attempt's text.
  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const tooShort = requireReason && reason.trim().length < reasonMinLength;
  const error = touched && tooShort ? `Please give at least ${reasonMinLength} characters.` : undefined;

  const confirm = async () => {
    setTouched(true);
    if (tooShort) return;
    await onConfirm(reason.trim());
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissable={!loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={loading}
            onClick={confirm}
            disabled={touched && tooShort}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text">{message}</p>

      {requireReason && (
        <FormField
          label={reasonLabel}
          required
          error={error}
          hint="Recorded on the audit trail and shown to the other party."
          className="mt-4"
        >
          <Textarea
            value={reason}
            rows={3}
            disabled={loading}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="Why is this being done?"
          />
        </FormField>
      )}
    </Dialog>
  );
}
