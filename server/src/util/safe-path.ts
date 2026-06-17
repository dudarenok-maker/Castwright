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
