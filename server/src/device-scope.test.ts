import { describe, expect, it } from 'vitest';
import { COMPANION_ALLOWLIST, companionAllows, isPlainTarget, pathnameOf } from './device-scope.js';

const BOOK = '%D0%BB%D1%83%D0%BA%D1%8C%D1%8F%D0%BD%D0%B5%D0%BD%D0%BA%D0%BE__x__y';

describe('device-scope companion allowlist', () => {
  // R1: EXACT equality, never a subset. The expectation is the literal itself,
  // so this cannot pass having examined nothing.
  it('the allowlist is exactly these nine rows', () => {
    // RegExp#source escapes `/` as `\/`; undo that so the literals read as routes.
    expect(COMPANION_ALLOWLIST.map((r) => [r.method, r.pattern.source.replace(/\\\//g, '/')])).toEqual([
      ['GET', '^/api/info$'],
      ['GET', '^/api/library/sync-manifest$'],
      ['GET', '^/api/books/[^/]+/cover$'],
      ['GET', '^/api/books/[^/]+/chapters/[0-9]+/audio$'],
      ['GET', '^/api/books/[^/]+/chapters/[0-9]+/audio\\.(mp3|m4a|ogg)$'],
      ['GET', '^/api/books/[^/]+/listen-progress$'],
      ['PUT', '^/api/books/[^/]+/listen-progress$'],
      ['PUT', '^/api/books/[^/]+/listen-stats$'],
      ['POST', '^/api/books/[^/]+/shelf-status$'],
    ]);
  });

  it.each([
    ['GET', '/api/info'],
    ['GET', '/api/library/sync-manifest'],
    ['GET', `/api/books/${BOOK}/cover`],
    ['GET', `/api/books/${BOOK}/chapters/12/audio`],
    ['GET', `/api/books/${BOOK}/chapters/12/audio.mp3`],
    ['GET', `/api/books/${BOOK}/chapters/12/audio.m4a`],
    ['GET', `/api/books/${BOOK}/chapters/12/audio.ogg`],
    ['GET', `/api/books/${BOOK}/listen-progress`],
    ['PUT', `/api/books/${BOOK}/listen-progress`],
    ['PUT', `/api/books/${BOOK}/listen-stats`],
    ['POST', `/api/books/${BOOK}/shelf-status`],
  ])('allows %s %s', (m, p) => expect(companionAllows(m, p)).toBe(true));

  // Express routes HEAD to the GET handler and a HEAD cannot return more than
  // its GET, so accepting it costs no authority and removes a skew class.
  it('allows HEAD wherever GET is allowed', () => {
    expect(companionAllows('HEAD', '/api/info')).toBe(true);
  });

  it('uppercases the method', () => {
    expect(companionAllows('get', '/api/info')).toBe(true);
  });

  it.each([
    // (a) method-blindness: /cover carries GET, POST and DELETE.
    ['DELETE', `/api/books/${BOOK}/cover`],
    ['POST', `/api/books/${BOOK}/cover`],
    // M5: dropping the $ anchors. POST /dismiss-whats-new shares the info router.
    ['POST', '/api/info/dismiss-whats-new'],
    // Adjacent to the allowlisted audio rows (chapter-audio.ts /audio/previous*).
    ['GET', `/api/books/${BOOK}/chapters/12/audio/previous`],
    ['GET', `/api/books/${BOOK}/chapters/12/audio/previous.mp3`],
    ['DELETE', `/api/books/${BOOK}/chapters/12/audio/previous`],
    ['POST', `/api/books/${BOOK}/chapters/12/audio/previous/restore`],
    ['POST', `/api/books/${BOOK}/chapters/12/audio/previous/restore-unrecorded`],
    // M6: the cross-mount collision; the guard is mounted on ['/api','/workspace'].
    ['GET', '/workspace/info'],
    ['GET', '/workspace/books/x/cover'],
    // M16: no case folding. /API/INFO routes in Express but must not match here.
    ['GET', '/API/INFO'],
    // M17 / invariant 5: neither pairing-session route may EVER be allowlisted.
    ['POST', '/api/devices/pair-session'],
    ['POST', '/api/pair/session'],
    ['POST', '/api/devices'],
    ['DELETE', '/api/devices/abc'],
    // chapterId is [0-9]+, not [^/]+.
    ['GET', `/api/books/${BOOK}/chapters/../audio`],
    ['GET', `/api/books/${BOOK}/chapters/x/audio`],
  ])('denies %s %s', (m, p) => expect(companionAllows(m, p)).toBe(false));

  it('denies a request with no method', () => {
    expect(companionAllows(undefined, '/api/info')).toBe(false);
  });

  it.each([
    ['/api/info?x=1', '/api/info'],
    ['/api/info#frag', '/api/info'],
    ['/api/info?a=b#c', '/api/info'],
    ['/api/info', '/api/info'],
    [`/api/books/${BOOK}/cover?v=1`, `/api/books/${BOOK}/cover`],
  ])('pathnameOf(%s) === %s', (i, o) => expect(pathnameOf(i)).toBe(o));

  // A trailing slash routes (Express is non-strict) but does not match the
  // anchored pattern: denied. Safe direction, pinned so it can't flip silently.
  it('denies a trailing slash', () => {
    expect(companionAllows('GET', '/api/info/')).toBe(false);
  });
});

describe('isPlainTarget', () => {
  it.each([
    '/api/info',
    '/api/books/b/cover?x=1&y=%7B',
    "/api/books/a-b_c.d~e!$&'()*+,;=:@/cover",
  ])('accepts %s', (t) => expect(isPlainTarget(t)).toBe(true));

  // Characters outside RFC 3986's path/query set: legacy url.parse escapes or rewrites them.
  it.each(['{', '}', '|', '^', '`', '"', '<', '>', '#', '\\', ' ', '\t', 'é'])(
    'rejects a target containing %j',
    (c) => expect(isPlainTarget(`/api/books/b${c}/cover`)).toBe(false),
  );

  // "'" is a legal sub-delim and parseurl's fast path leaves it alone; it is only
  // escaped on the legacy path, which a # (denied above) is needed to reach.
  it("rejects the legacy-parse escapable \"'\" when it travels with a #", () => {
    expect(isPlainTarget("/api/books/b'/cover#x")).toBe(false);
  });
});

// Express routes URLs containing # / whitespace / U+00A0 / U+FEFF through legacy
// url.parse, which turns "\" into "/" before the query. The guard must not
// approve a path Express will route differently (default-deny, #4720 pass 1).
describe('device-scope backslash divergence', () => {
  // Each path matches an allowlist row if the "\" is ignored, so it goes red
  // when the deny is removed.
  it.each([
    ['GET', '/api/books/b\\exports/cover'],
    ['GET', '/api/books/x\\y/cover'],
    ['PUT', '/api/books/x\\y/listen-stats'],
    ['POST', '/api/books/x\\y/shelf-status'],
  ])('denies %s %s', (m, p) => {
    expect(companionAllows(m, p)).toBe(false);
  });
});
