import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentDto, DocumentOwnerType, Paginated } from '@tb/shared';
import { apiDelete, apiDownload, apiGetPage } from '@/lib/api';
import { qk } from '@/lib/queryKeys';

/** Documents (plan 14 §A). Upload itself lives in `FileUpload`, which needs progress. */

export const useDocuments = (ownerType: DocumentOwnerType, ownerId: string | undefined) =>
  useQuery<Paginated<DocumentDto>>({
    queryKey: qk.documents.list(ownerType, ownerId ?? ''),
    queryFn: () =>
      apiGetPage<DocumentDto>('/documents', { params: { ownerType, ownerId, limit: 100 } }),
    enabled: !!ownerId,
  });

export const useDeleteDocument = (ownerType: DocumentOwnerType, ownerId: string | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/documents/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: qk.documents.list(ownerType, ownerId ?? '') }),
  });
};

/**
 * Download a document.
 *
 * `GET /documents/:id/download` authenticates from the `Authorization` header
 * and answers 302 to a short-lived signed storage URL. That combination cannot
 * be completed by a browser: a plain `window.open` carries no bearer token and
 * gets 401, and an XHR that does carry one cannot follow a cross-origin redirect
 * (the redirected request needs a preflight, which the fetch spec forbids
 * following). So this attempts the fetch and reports honestly when the redirect
 * cannot be followed, rather than opening a blank tab.
 *
 * The fix belongs on the server — an endpoint that RETURNS the signed URL as
 * JSON instead of redirecting to it — and when it exists, this is the one place
 * the client changes.
 */
export async function downloadDocument(id: string, fileName: string): Promise<void> {
  const blob = await apiDownload(`/documents/${id}/download`);

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
