/* Shared Blob-download helper, modeled on share-card-modal.tsx's downloadJson,
   for fs-51's text/JSON export. Note: listen.tsx's export pattern additionally
   appends the anchor to the DOM and delays URL.revokeObjectURL by 1000ms for
   cross-browser (Firefox/Safari) reliability — this helper does neither, so a
   future caller with that same reliability requirement shouldn't assume parity. */
export function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
