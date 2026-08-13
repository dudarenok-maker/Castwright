/* #2344 / #2348 — static guard against a re-introduced direct
   `fetch('/api/...')` call under src/components/, src/views/, src/modals/,
   src/routes/, or src/hooks/ that bypasses the mock/real seam (`api.*` in
   src/lib/api.ts — see CLAUDE.md "Mocks behind VITE_USE_MOCKS"). This mirrors
   server/src/workspace/cast-lock.guard.test.ts's house style: a syntactic
   scan (not a parser) over raw source text, with a file+count allowlist
   pinning the CURRENT, deliberately-documented direct-fetch surface. A
   file not on the allowlist that has any matching occurrence fails
   outright; a file ON the allowlist whose count has drifted in EITHER
   direction fails too — see cast-lock.guard's own header for why
   file+count, not file alone, is the right key (a file-level exemption
   would blind the guard to a SECOND, genuinely new unlisted fetch landing
   in an already-allowlisted file).

   #2344's own history is why this exists: the issue that prompted this
   guard was filed off an unverified `git grep "fetch("`, which matched
   `refetch(`/`onRefetch(` and wildly overstated the real defect (two
   genuine call sites, not the dozen the raw grep implied). The matcher
   below is written specifically not to repeat that mistake.

   #2348's independent review widened the scan to src/views/ (an identical
   `fetch('/api/qwen/detect')` sat uncaught at src/views/cast.tsx — a
   byte-identical duplicate of the allowlisted qwen-status-notice.tsx call)
   and tightened the matcher to close two bypasses a human would plausibly
   write: whitespace between `fetch` and `(` (`fetch ('/api/x')`), and a
   leading-slash-free literal (`fetch('api/x')`, which still resolves to
   `/api/x` from the SPA root).

   #2348 review pass 2 (finding N2) widened the scan again, to src/modals/,
   src/routes/, and src/hooks/ — the header below previously claimed those
   were out of scope without saying so. A scan of all three at the time of
   that widening found zero `fetch(` call sites of any shape (verified with
   both the full matcher and a bare `\bfetch\s*\(` sweep), so no new
   allowlist entries were needed; the widening exists to keep the BLIND
   SPOTS list honest and to catch a future regression in those directories
   too.

   MATCHER: the literal token "fetch" immediately followed (modulo optional
   whitespace on both sides of the paren) by an opening paren, NOT preceded
   by a word character — that lookbehind is what rules out `refetch(` /
   `onRefetch(` (whose matched substring is preceded by the word character
   "e") — and then a quote character (single, double, or backtick) that
   opens on an optional leading slash followed by the literal three
   characters `api/`. `fetch(endpoint, …)` or a template literal built from
   an interpolated variable never matches at all, because nothing at the
   position right after the opening paren is a quote character followed by
   that literal prefix text. Proven below: an inline fixture containing
   `refetch('/api/x')` / `onRefetch('/api/y')` (spaced and unspaced) —
   i.e. the lookbehind's actual target: the full `fetch(` + quote + `api/`
   shape, just preceded by the word character that makes it `refetch(`
   rather than `fetch(` — is asserted NOT flagged, and further tests
   confirm the guard reddens on a genuine new literal-prefixed fetch call,
   on `fetch (` with a space, and on a leading-slash-free `api/` literal.
   (An earlier version of the false-positive fixture used bare
   `refetch()`/`onRefetch()` with no `/api/` argument at all — that fixture
   never matched the matcher's `['"`]\/?api\/` suffix regardless of the
   lookbehind, so the test passed vacuously and pinned nothing; see the
   test's own comment below.)

   BLIND SPOTS (this scan is syntactic, not semantic — same caveat as
   cast-lock.guard's own header, applied to a different invariant):
     - A fetch reached via a variable or interpolated endpoint, e.g.
       `fetch(endpoint, {...})` or a template literal starting with `${` —
       blocker-fix-action.tsx's runJobAction/pollJob build exactly this
       shape from `JOB_START_ENDPOINT[action.kind]` (a prop-derived table),
       and this scan cannot trace an interpolated template back to a literal
       API-path string. A regression that reintroduces a raw literal-prefixed
       fetch is caught; one laundered through an intermediate variable is
       not.
     - A fetch reached through a shared helper function defined elsewhere
       (no call-graph tracing — same limitation as cast-lock.guard).
     - Anything outside src/components/, src/views/, src/modals/,
       src/routes/, and src/hooks/ — out of scope by design (src/store/,
       src/lib/, src/data/, src/mocks/). In particular
       `src/store/queue-thunks.ts` already honours the VITE_USE_MOCKS toggle
       through its OWN branch (a `USE_MOCKS` check + `mockQueueRequest`), not
       through `api.*`, and is a documented, correct exception (see
       CLAUDE.md); this guard has nothing to say about it either way.
     - A comment or string that merely quotes the pattern is deliberately
       NOT opaque-token-aware the way cast-lock.guard's `skipOpaqueToken` is
       — there is no legitimate reason for this codebase's runtime source
       (non-comment, non-string) to spell out that exact call shape outside
       a real fetch call, so the simpler scan is intentional, not an
       oversight. This header describes the pattern in prose rather than
       spelling it out verbatim for exactly that reason — the regex itself,
       spelled out once, lives just below in code. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_ROOT = __dirname; // src/components
const VIEWS_ROOT = join(__dirname, '..', 'views'); // src/views
const MODALS_ROOT = join(__dirname, '..', 'modals'); // src/modals
const ROUTES_ROOT = join(__dirname, '..', 'routes'); // src/routes
const HOOKS_ROOT = join(__dirname, '..', 'hooks'); // src/hooks

/** Every non-test `.ts`/`.tsx` file under `dir`, recursively. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** `fetch(` — not preceded by a word character (rules out `refetch(` /
    `onRefetch(`), tolerant of whitespace on either side of the paren —
    immediately followed by a string/template-literal quote that opens on
    an optional leading slash then the literal text `api/`. */
const DIRECT_API_FETCH_RE = /(?<![\w$])fetch\s*\(\s*['"`]\/?api\//g;

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

interface ScanResult {
  count: number;
  details: string[];
}

function scanFile(content: string): ScanResult | null {
  DIRECT_API_FETCH_RE.lastIndex = 0;
  const details: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = DIRECT_API_FETCH_RE.exec(content))) {
    details.push(`direct fetch('/api/...') @ line ${lineOf(content, m.index)}`);
  }
  if (details.length === 0) return null;
  return { count: details.length, details };
}

/* Keyed on file AND expected count, never file alone — see file header. */
const ALLOWED_DIRECT_FETCH = new Map<string, { count: number; why: string }>([
  [
    'coqui-install.tsx',
    { count: 2, why: 'local install/poll provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'kokoro-install.tsx',
    { count: 2, why: 'local install/poll provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'mini-player.tsx',
    {
      count: 1,
      why:
        "deliberate keepalive:true unload flush (line ~619) — must bypass the mock api because " +
        'keepalive has to survive page unload; the primary 5s flush already uses api.putListenStats (#2344 brief)',
    },
  ],
  [
    'model-pull-status.tsx',
    { count: 3, why: 'local ollama pull/refresh provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'ollama-install.tsx',
    { count: 4, why: 'local install/detect/poll/recheck provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'qwen-install.tsx',
    { count: 2, why: 'local install/poll provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'qwen-status-notice.tsx',
    { count: 1, why: 'local detect provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'venv-bootstrap.tsx',
    { count: 2, why: 'local venv bootstrap/poll provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'whisper-install.tsx',
    { count: 3, why: 'local detect/install/poll provisioning surface, no mock counterpart (#2344 brief)' },
  ],
  [
    'views/cast.tsx',
    {
      count: 1,
      why:
        'byte-identical duplicate of the allowlisted qwen-status-notice.tsx detect call, no mock ' +
        'counterpart (#2348 review finding 4)',
    },
  ],
]);

/* Roots this guard scans, each with the key-prefix its relative paths get
   in ALLOWED_DIRECT_FETCH — src/components/ entries keep their bare
   filename (unchanged since #2344); every other root is prefixed with its
   own directory name so a same-named file in any two roots can't collide. */
const SCAN_ROOTS: Array<{ dir: string; prefix: string }> = [
  { dir: COMPONENTS_ROOT, prefix: '' },
  { dir: VIEWS_ROOT, prefix: 'views/' },
  { dir: MODALS_ROOT, prefix: 'modals/' },
  { dir: ROUTES_ROOT, prefix: 'routes/' },
  { dir: HOOKS_ROOT, prefix: 'hooks/' },
];

describe('src/components + src/views + src/modals + src/routes + src/hooks direct fetch(\'/api/...\') — static guard (#2344, #2348)', () => {
  it('every direct fetch(\'/api/...\') site matches the pinned allowlist, file+count', () => {
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const { dir, prefix } of SCAN_ROOTS) {
      for (const file of collectSourceFiles(dir)) {
        const rel = prefix + relative(dir, file).split(sep).join('/');
        const content = readFileSync(file, 'utf8');
        const result = scanFile(content);
        if (!result) continue;

        const allowed = ALLOWED_DIRECT_FETCH.get(rel);
        if (allowed) {
          matchedAllowlistKeys.add(rel);
          if (result.count !== allowed.count) {
            problems.push(
              `${rel}: allowlisted for exactly ${allowed.count} direct fetch(es) (${allowed.why}), ` +
                `but the scan found ${result.count}:\n  ${result.details.join('\n  ')}`,
            );
          }
        } else {
          problems.push(
            `${rel}: ${result.count} direct fetch('/api/...') call(s) — NOT on the allowlist. ` +
              'Route through the matching api.* wrapper in src/lib/api.ts, or add a justified ' +
              'allowlist entry naming why this site has no mock counterpart:\n  ' +
              result.details.join('\n  '),
          );
        }
      }
    }

    for (const [rel, allowed] of ALLOWED_DIRECT_FETCH) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.count} direct fetch(es), but the scan now finds ZERO — ` +
            'update or remove this allowlist entry.',
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('does not flag refetch(\'/api/...\')/onRefetch(\'/api/...\'), spaced or not — the false positive that produced #2344\'s overstated issue body', () => {
    // Each call below carries the matcher's FULL positive shape after the
    // word "fetch" — `(`, an optional space, a quote, an optional leading
    // slash, and the literal `api/` — so that if the `(?<![\w$])`
    // lookbehind were ever dropped, `fetch('/api/...` inside `refetch(` /
    // `onRefetch(` would match and this test would go red. A fixture with
    // no `/api/` argument (e.g. bare `refetch()`) never exercises that
    // lookbehind at all — nothing after the paren matches the required
    // quote+`api/` suffix either way — so it would pass whether or not the
    // lookbehind is present, pinning nothing.
    const fixture = [
      'function useThing() {',
      '  refetch(\'/api/x\');',
      '  onRefetch(\'/api/y\');',
      '  refetch (\'/api/x\');',
      '  onRefetch (\'/api/y\');',
      '}',
    ].join('\n');
    expect(scanFile(fixture)).toBeNull();
  });

  it('DOES flag a genuine literal fetch(\'/api/...\') call (red-then-green sanity)', () => {
    const fixture = "async function x() { await fetch('/api/whatever'); }";
    const result = scanFile(fixture);
    expect(result).not.toBeNull();
    expect(result?.count).toBe(1);
  });

  it('DOES flag `fetch (\'/api/x\')` — whitespace between fetch and the paren (#2348 review finding 3)', () => {
    const fixture = "async function x() { await fetch ('/api/whatever'); }";
    const result = scanFile(fixture);
    expect(result).not.toBeNull();
    expect(result?.count).toBe(1);
  });

  it('DOES flag `fetch(\'api/config\')` — no leading slash, still resolves to /api/config from the SPA root (#2348 review finding 3)', () => {
    const fixture = "async function x() { await fetch('api/config'); }";
    const result = scanFile(fixture);
    expect(result).not.toBeNull();
    expect(result?.count).toBe(1);
  });
});
