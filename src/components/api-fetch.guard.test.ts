/* #2344 — static guard against a re-introduced direct `fetch('/api/...')`
   call under src/components/ that bypasses the mock/real seam (`api.*` in
   src/lib/api.ts — see CLAUDE.md "Mocks behind VITE_USE_MOCKS"). This
   mirrors server/src/workspace/cast-lock.guard.test.ts's house style: a
   syntactic scan (not a parser) over raw source text, with a file+count
   allowlist pinning the CURRENT, deliberately-documented direct-fetch
   surface. A file not on the allowlist that has any matching occurrence
   fails outright; a file ON the allowlist whose count has drifted in
   EITHER direction fails too — see cast-lock.guard's own header for why
   file+count, not file alone, is the right key (a file-level exemption
   would blind the guard to a SECOND, genuinely new unlisted fetch landing
   in an already-allowlisted file).

   #2344's own history is why this exists: the issue that prompted this
   guard was filed off an unverified `git grep "fetch("`, which matched
   `refetch(`/`onRefetch(` and wildly overstated the real defect (two
   genuine call sites, not the dozen the raw grep implied). The matcher
   below is written specifically not to repeat that mistake.

   MATCHER: the literal token "fetch" immediately followed by an opening
   paren, NOT preceded by a word character — that lookbehind is what rules
   out `refetch(` / `onRefetch(` (whose matched substring is preceded by the
   word character "e") — and then, after optional whitespace, a quote
   character (single, double, or backtick) that itself opens on the four
   literal characters forming the API path prefix. `fetch(endpoint, …)` or a
   template literal built from an interpolated variable never matches at
   all, because nothing at the position right after the opening paren is a
   quote character followed by that literal prefix text. Proven both ways
   below: a fixture containing only `refetch()`/`onRefetch()` is asserted
   NOT flagged, and a third test confirms the guard actually reddens on a
   genuine new literal-prefixed fetch call.

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
     - Anything outside src/components/ — out of scope by design. In
       particular `src/store/queue-thunks.ts` already honours the
       VITE_USE_MOCKS toggle through its OWN branch (a `USE_MOCKS` check +
       `mockQueueRequest`), not through `api.*`, and is a documented,
       correct exception (see CLAUDE.md); this guard has nothing to say
       about it either way.
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

/** Every non-test `.ts`/`.tsx` file under src/components, recursively. */
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
    `onRefetch(`) — immediately followed by optional whitespace and a
    string/template-literal quote that opens on the literal text `/api/`. */
const DIRECT_API_FETCH_RE = /(?<![\w$])fetch\(\s*['"`]\/api\//g;

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
]);

describe('src/components direct fetch(\'/api/...\') — static guard (#2344)', () => {
  it('every direct fetch(\'/api/...\') site matches the pinned allowlist, file+count', () => {
    const files = collectSourceFiles(COMPONENTS_ROOT);
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(COMPONENTS_ROOT, file).split(sep).join('/');
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

  it('does not flag refetch()/onRefetch() — the false positive that produced #2344\'s overstated issue body', () => {
    const fixture = [
      'function useThing() {',
      '  const refetch = () => {};',
      '  const onRefetch = () => {};',
      '  refetch();',
      '  onRefetch();',
      '  return { refetch, onRefetch };',
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
});
