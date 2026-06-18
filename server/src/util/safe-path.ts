import path from 'node:path';

/** Thrown when a path segment or composed path would escape its root. */
export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/* Deny-list, NOT an allowlist: a safe segment may contain any Unicode
   letter/number plus `-`, `_`, `.` mid-name (plan-219 Cyrillic + nanoid ids
   survive). The load-bearing check is assertContained; this is a pre-filter. */
export function safeSegment(seg: string): string {
  if (seg === '' || seg === '.' || seg === '..') {
    throw new PathContainmentError(`Unsafe path segment: "${seg}"`);
  }
  if (/[/\\\x00]/.test(seg)) {
    // separators or NUL
    throw new PathContainmentError(`Path segment contains a separator or NUL`);
  }
  if (path.isAbsolute(seg) || /^[A-Za-z]:/.test(seg)) {
    throw new PathContainmentError(`Path segment is absolute: "${seg}"`);
  }
  return seg;
}

/** TRANSFORMING sanitizer for an id used as a single path segment. Unlike the
    validating `safeSegment` (which throws), this REPLACES path separators / NUL
    and collapses any `..` run, so the RETURN VALUE is a guaranteed-contained
    component. CodeQL models a separator/`..`-stripping `.replace()` as a path
    sanitizer and — crucially — propagates it across function boundaries (a
    throwing guard does not), so wrapping an id in `sanitizeIdSegment(...)` inside
    a path builder clears that builder's callers too. Legitimate ids (slugs,
    nanoids, `qwen-<id>`, Cyrillic) contain none of these, so they pass through
    unchanged. */
export function sanitizeIdSegment(seg: string): string {
  return seg.replace(/[/\\\x00]/g, '_').replace(/\.\.+/g, '_');
}

/** Throw unless `resolved` is inside `root`. CodeQL-recognized barrier
    (RelativePathStartsWithSanitizer) — keep the raw relative string. */
export function assertContained(root: string, resolved: string): void {
  const rel = path.relative(path.resolve(root), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathContainmentError(`Path escapes root: ${resolved}`);
  }
}

/** Resolve `segments` under `root`, asserting containment. Call at the sink. */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments.map(safeSegment));
  assertContained(root, resolved);
  return resolved;
}
