/** The chapter id a `?chapter=` search param names, or null when it is absent
    or not a number. `ReadyRoute` and the Generate view's scroll gate share this
    so they agree on what "names a chapter" means (#4199). */
export function parseChapterParam(raw: string | null): number | null {
  if (raw == null) return null;
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}
