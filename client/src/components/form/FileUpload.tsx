import { useRef, useState, type DragEvent } from 'react';
import { File as FileIcon, Trash2, Upload } from 'lucide-react';
import {
  MAX_UPLOAD_MB,
  UPLOAD_RULES,
  type DocumentDto,
  type DocumentOwnerType,
  type DocumentType,
} from '@tb/shared';
import { cn } from '@/lib/cn';
import { api, toApiError } from '@/lib/api';
import { formatFileSize } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

/**
 * Document upload (plan 16 §5), wired to POST /documents (plan 14 §A).
 *
 * The validation here is the same table the server enforces (`UPLOAD_RULES` from
 * `@tb/shared`), so a 12 MB TIFF is refused in the browser instead of after a
 * 12 MB upload. The server still re-checks it — this is courtesy, not security.
 *
 * Note what is never accepted, for any type: SVG. It is executable XML.
 */
export interface FileUploadProps {
  ownerType: DocumentOwnerType;
  ownerId: string;
  type: DocumentType;
  onUploaded?: (document: DocumentDto) => void;
  onRemove?: (documentId: string) => void;
  /** Already-uploaded documents, so one component is the whole attachments panel. */
  existing?: DocumentDto[];
  disabled?: boolean;
  label?: string;
  className?: string;
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
};

export function FileUpload({
  ownerType,
  ownerId,
  type,
  onUploaded,
  onRemove,
  existing = [],
  disabled = false,
  label,
  className,
}: FileUploadProps) {
  const rule = UPLOAD_RULES[type];
  const maxMb = Math.min(rule.maxMb, MAX_UPLOAD_MB);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reject = (message: string) => {
    setError(message);
    toast.error('That file was not uploaded', message);
  };

  async function send(file: File) {
    setError(null);

    if (!rule.mime.includes(file.type)) {
      const allowed = rule.mime.map((mime) => EXTENSIONS[mime] ?? mime).join(', ');
      reject(`${file.name} is not an accepted format. Allowed: ${allowed}.`);
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      reject(`${file.name} is ${formatFileSize(file.size)}; the limit for this document is ${maxMb} MB.`);
      return;
    }

    const body = new FormData();
    body.append('file', file);
    body.append('type', type);
    body.append('ownerType', ownerType);
    body.append('ownerId', ownerId);

    setProgress(0);
    try {
      const response = await api.post<{ success: true; data: DocumentDto }>('/documents', body, {
        onUploadProgress: (event) => {
          if (event.total) setProgress(Math.round((event.loaded / event.total) * 100));
        },
      });
      onUploaded?.(response.data.data);
      toast.success('File uploaded', file.name);
    } catch (uploadError) {
      const apiError = toApiError(uploadError);
      reject(apiError.message);
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void send(file);
  };

  const busy = progress !== null;

  return (
    <div className={cn('space-y-2', className)}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border bg-subtle',
          disabled && 'opacity-60',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={rule.mime.join(',')}
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send(file);
          }}
        />

        <Upload aria-hidden className="mx-auto mb-2 size-5 text-muted" />
        <p className="text-xs text-text">
          {label ?? 'Drag a file here, or'}{' '}
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
          >
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-muted">
          {rule.mime.map((mime) => EXTENSIONS[mime] ?? mime).join(' · ')} — up to {maxMb} MB
        </p>

        {busy && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 font-mono text-xs tabular-nums text-muted">{progress}%</p>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>

      {existing.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {existing.map((document) => (
            <li key={document.id} className="flex items-center gap-3 px-3 py-2">
              <FileIcon aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-xs text-text">{document.fileName}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                {formatFileSize(document.sizeBytes)}
              </span>
              {document.canDelete && onRemove && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${document.fileName}`}
                  className="size-7"
                  onClick={() => onRemove(document.id)}
                >
                  <Trash2 className="size-3.5 text-danger" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
