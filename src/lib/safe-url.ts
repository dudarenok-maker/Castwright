/** Allow only http(s) and same-origin relative paths for <img src>. Covers are
    always a server path (/api/books/:id/cover) or a remote http(s) search URL —
    never data:/blob:. Returns '' for anything else (notably javascript:). */
export function safeImageSrc(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}
