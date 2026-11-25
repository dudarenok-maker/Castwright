/* The correctness criterion is the UNION of endpoint sets over every SUPPORTED
   APK version — not the set derived from HEAD. Installed clients are not
   upgraded in lockstep: release.yml publishes a standalone APK and
   apk:companion's auto-incrementing versionCode means field devices update on
   their own schedule.

   Rows are ADDED when a new client ships, and REMOVED only when the last APK
   that used them is out of support. Do NOT edit this table to track HEAD.

   Coupled to apps/android/test/data/api_client_test.dart's nine pins. There is
   deliberately no mechanical link (see the design of record, §Q1): a Dart
   parser here would not run — no verify.yml scope regex anchors on apps/ — and
   its failure mode is silent green.

   Pure leaf: NO imports, no IO, so it cannot join an import cycle.

   Matching is on the RAW pathname of originalUrl: no decoding, no case
   folding. The guard is mounted on ['/api', '/workspace'], so req.path would
   present /info for both mounts (M6). */

export interface CompanionRule {
  method: 'GET' | 'PUT' | 'POST';
  pattern: RegExp;
}

export const COMPANION_ALLOWLIST: readonly CompanionRule[] = [
  { method: 'GET', pattern: /^\/api\/info$/ },
  { method: 'GET', pattern: /^\/api\/library\/sync-manifest$/ },
  { method: 'GET', pattern: /^\/api\/books\/[^/]+\/cover$/ },
  // Rows 4 and 5 are two different routes: JSON peaks, then the audio file.
  { method: 'GET', pattern: /^\/api\/books\/[^/]+\/chapters\/[0-9]+\/audio$/ },
  { method: 'GET', pattern: /^\/api\/books\/[^/]+\/chapters\/[0-9]+\/audio\.(mp3|m4a|ogg)$/ },
  { method: 'GET', pattern: /^\/api\/books\/[^/]+\/listen-progress$/ },
  { method: 'PUT', pattern: /^\/api\/books\/[^/]+\/listen-progress$/ },
  { method: 'PUT', pattern: /^\/api\/books\/[^/]+\/listen-stats$/ },
  { method: 'POST', pattern: /^\/api\/books\/[^/]+\/shelf-status$/ },
];

/** The pathname of an originalUrl: split at the FIRST `?` or `#`; never decoded. */
export function pathnameOf(originalUrl: string): string {
  const i = originalUrl.search(/[?#]/);
  return i === -1 ? originalUrl : originalUrl.slice(0, i);
}

/** Whether a companion-scoped device may call `method` on `pathname`. */
export function companionAllows(method: string | undefined, pathname: string): boolean {
  if (!method) return false;
  let m = method.toUpperCase();
  if (m === 'HEAD') m = 'GET';
  return COMPANION_ALLOWLIST.some((r) => r.method === m && r.pattern.test(pathname));
}
