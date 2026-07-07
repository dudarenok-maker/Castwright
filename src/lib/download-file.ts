/* Shared Blob-download helper — extracted from the inline patterns in
   listen.tsx (portable bundle export) and share-card-modal.tsx (JSON
   export) so fs-51's text/JSON export reuses one implementation. */
export function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
