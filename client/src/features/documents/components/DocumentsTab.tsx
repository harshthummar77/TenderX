import { Download, FileText, Trash2 } from 'lucide-react';
import { PERMISSIONS as P, type DocumentOwnerType, type DocumentType } from '@tb/shared';
import { formatDateTime, formatFileSize, humanize } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/data/EmptyState';
import { FileUpload } from '@/components/form/FileUpload';
import { downloadDocument, useDeleteDocument, useDocuments } from '@/features/documents/api';

/**
 * The "Documents" tab, reused by the vendor, tender, PO, GRN, invoice and
 * payment screens. Upload is `FileUpload` (which owns validation and progress);
 * this adds the list, the download and the delete.
 */
export function DocumentsTab({
  ownerType,
  ownerId,
  uploadType,
  title = 'Documents',
  description,
  canUpload = true,
}: {
  ownerType: DocumentOwnerType;
  ownerId: string | undefined;
  /** The document type new uploads get. Omit to hide the uploader. */
  uploadType?: DocumentType;
  title?: string;
  description?: string;
  canUpload?: boolean;
}) {
  const { can } = useAuth();
  const documents = useDocuments(ownerType, ownerId);
  const remove = useDeleteDocument(ownerType, ownerId);

  const rows = documents.data?.data ?? [];
  const showUploader = canUpload && !!uploadType && can(P.DOCUMENT_UPLOAD);

  return (
    <Card>
      <CardHeader title={title} description={description} />

      {showUploader && ownerId && (
        <CardBody className="border-b border-border">
          <FileUpload
            ownerType={ownerType}
            ownerId={ownerId}
            type={uploadType}
            onUploaded={() => documents.refetch()}
          />
        </CardBody>
      )}

      {documents.isLoading ? (
        <CardBody>
          <Skeleton className="h-20 w-full" />
        </CardBody>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="No documents"
          message={
            showUploader
              ? 'Drag a file into the box above to attach one.'
              : 'Nothing has been attached to this record.'
          }
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>File</TH>
              <TH>Type</TH>
              <TH numeric>Size</TH>
              <TH>Uploaded by</TH>
              <TH>When</TH>
              <TH className="text-right">Actions</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((document) => (
              <TR key={document.id}>
                <TD className="max-w-xs truncate">{document.fileName}</TD>
                <TD className="text-xs text-muted">{humanize(document.type)}</TD>
                <TD numeric>{formatFileSize(document.sizeBytes)}</TD>
                <TD className="text-xs text-muted">{document.uploadedByName ?? '—'}</TD>
                <TD className="text-xs text-muted">{formatDateTime(document.createdAt)}</TD>
                <TD className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Download ${document.fileName}`}
                      className="size-7"
                      onClick={() =>
                        void downloadDocument(document.id, document.fileName).catch(() =>
                          toast.error(
                            'Download unavailable',
                            'The server redirects to a signed storage URL, which a browser cannot follow with a bearer token.',
                          ),
                        )
                      }
                    >
                      <Download className="size-3.5" />
                    </Button>

                    {document.canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${document.fileName}`}
                        className="size-7"
                        disabled={remove.isPending}
                        onClick={() =>
                          remove.mutate(document.id, {
                            onSuccess: () => toast.success('Document deleted'),
                            onError: (error) => toast.fromError(error),
                          })
                        }
                      >
                        <Trash2 className="size-3.5 text-danger" />
                      </Button>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
