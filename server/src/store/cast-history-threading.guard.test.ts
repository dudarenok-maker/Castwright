/* Guard 3 (#2128, spine rule 2) — the loaded `CastIdHistory` object is threaded
   WHOLE into `buildCastResolver` / `isAudioCurrent`, never a hand-built object
   literal.

   This is the axis this codebase actually fails on, three times, each recorded
   in-tree:
     - cast-resolve.ts:43-47 — "five of this function's six call sites pass
       `supersededBy` alone and silently default `rejected` to `[]`"
     - repair-cast-id-drift.mjs (collectSegmentOrphans) — a hand-built
       `{supersededBy, rejected}` subset "silently dropping `rejectedPairs`"
     - repair-cast-id-drift.mjs (planBookRepairs) — "`rejectedPairs` was missing
       from this defended object — correct on `main` ... and wrong the moment
       #2092/#2089 merged"

   Every field #2128 adds is OPTIONAL, so a narrowing site keeps compiling while
   dropping `recordedAtSeq` — and an absent `recordedAtSeq` reads `'unknown'`,
   which lists. Fail-closed, but it lists the whole book forever and looks like
   the feature not working.

   BLIND SPOTS, stated rather than implied:
   - Call-graph blind. A variable built as a literal three lines up and passed
     by name is not caught. Only a literal AT the call site is.
   - Scans every non-test .ts file under server/src (recursively) and
     `scripts/repair-cast-id-drift.mjs`. Any other `.mjs` caller is invisible.
   - Comment/string text is stripped before matching, so a call quoted inside a
     doc comment neither fires nor masks a real one. `blankOutOpaque` does NOT
     understand regex literals, so a `/'/` in scanned source would blank forward
     to the next quote. Mitigated, not closed, by the allowlist's `count` check
     firing in BOTH directions on the two files that do contain literals — those
     act as a live-fire canary: if the scanner started blanking real code, their
     counts would drop and the suite would redden.
   - FAIL-OPEN GUARD (added on top of the brief's original shape, task-5
     correction): the offender loop below only walks the files it actually
     found — if `collectTsFiles` or the `.mjs` path silently matched nothing
     (a renamed directory, a typo'd path), the main assertion would pass
     VACUOUSLY, exactly the failure mode this whole lane exists to avoid (see
     `cast.json` write-lock guard, `cast-lock.guard.test.ts`, for the same
     shape). Closed the same way that guard closes it: every `ALLOWLIST`
     entry must actually be found among the scanned files, checked in a
     REVERSE pass below — an empty `files` list can never satisfy that, since
     nothing would be visited to match either allowlist entry, so the suite
     reddens instead of passing green on zero evidence. A dedicated "point the
     walker at a directory that doesn't exist" probe was run by hand (see
     task-5-report.md) rather than shipped as a persistent test, since
     `readdirSync` on a missing directory throws — the walker cannot silently
     return `[]` for a bad path, only for an empty, EXISTING one, which the
     reverse allowlist check already covers. */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, '..');
const REPO = join(SERVER_SRC, '..', '..');

const CALLS = ['buildCastResolver(', 'isAudioCurrent('];

/** Every non-test `.ts` file under `dir`, recursively — copied from
 *  `server/src/workspace/cast-lock.guard.test.ts`'s `collectSourceFiles`
 *  rather than `fs.globSync` (Node 22+ only; this repo targets Node 20 —
 *  round 1, M17) or a second `node:fs` import (would trip
 *  `no-duplicate-imports`). Throws (via `readdirSync`) if `dir` does not
 *  exist, rather than returning `[]` — the fail-open guard above depends on
 *  a bad path being loud, not silent. */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Replace every line comment, block comment and string literal with spaces of
 *  the same length, so indices stay stable and quoted code never matches. */
export function blankOutOpaque(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const end = src.indexOf('\n', i); const stop = end < 0 ? src.length : end; blank(i, stop); i = stop; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; blank(i, stop); i = stop; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < src.length && src[k] !== c) { if (src[k] === '\\') k += 1; k += 1; }
      blank(i, Math.min(k + 1, src.length));
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** True when the call starting at `callIndex` passes an object LITERAL as its
 *  history argument (the second top-level argument for `buildCastResolver`, the
 *  third for `isAudioCurrent`). Walks paren/brace/bracket depth rather than
 *  regexing, so a nested call in an earlier argument cannot fool it. */
export function historyArgIsLiteral(src: string, callIndex: number, argIndex: number): boolean {
  let i = src.indexOf('(', callIndex);
  if (i < 0) return false;
  i += 1;
  let depth = 0;
  let arg = 0;
  let start = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (c === ')' && depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      if (arg === argIndex) break;
      arg += 1;
      start = i + 1;
    }
  }
  if (arg !== argIndex) return false;
  return /^\s*\{/.test(src.slice(start, i));
}

export function findLiteralHistoryCalls(src: string): Array<{ call: string; index: number }> {
  const clean = blankOutOpaque(src);
  const hits: Array<{ call: string; index: number }> = [];
  for (const call of CALLS) {
    const argIndex = call === 'isAudioCurrent(' ? 2 : 1;
    let from = 0;
    for (;;) {
      const at = clean.indexOf(call, from);
      if (at < 0) break;
      from = at + call.length;
      // Skip a definition (`function buildCastResolver(`) or an import line.
      const before = clean.slice(Math.max(0, at - 30), at);
      if (/\bfunction\s+$|\bexport\s+function\s+$/.test(before)) continue;
      if (historyArgIsLiteral(clean, at, argIndex)) hits.push({ call, index: at });
    }
  }
  return hits;
}

/* Keyed on file AND count, never on file alone, and checked in BOTH directions
   — a fix that removes a literal must shrink or delete its entry, exactly as a
   regression that adds one must fail. Each entry records WHY it is legitimate;
   an entry without a reason is an entry added by reflex. */
const ALLOWLIST: Array<{ file: string; count: number; reason: string }> = [
  {
    file: 'server/src/store/cast-resolve.ts',
    count: 1,
    reason:
      "rejectedPairsGoverning deliberately builds a rejects-BLIND resolver — passing a rejects-honouring one " +
      'is the bug it exists to prevent. It never calls isAudioCurrent, so no marker can be dropped here.',
  },
  {
    file: 'scripts/repair-cast-id-drift.mjs',
    count: 1,
    reason:
      "planBookRepairs's `idOnlyResolver` (currently :749, passed to resolveTierBId — cited by symbol, " +
      'not line: this file has moved before and will again) is id-shape-only BY DESIGN — empty history on ' +
      "purpose, built once per book, see resolveTierBId's doc comment. It never calls isAudioCurrent. " +
      "planBookRepairs's `historyResolver` was the OTHER literal here (task-5 correction: fixed to thread " +
      'the whole `history` object via a defended, non-literal local rather than allowlisted — see the ' +
      'module doc comment on that local for why it still needs `supersededBy` defended for a partial-' +
      'history caller).',
  },
];

describe('guard 3 — the loaded CastIdHistory is threaded whole (#2128)', () => {
  const files = [
    ...collectTsFiles(SERVER_SRC),
    join(REPO, 'scripts', 'repair-cast-id-drift.mjs'),
  ];

  it('scanned at least the expected number of files — a walker matching nothing must not pass green', () => {
    // Canary for the fail-open hazard: `server/src` has ~150+ non-test .ts
    // files today. A wrong SERVER_SRC/REPO path (a renamed directory, a
    // typo) would make `collectTsFiles` return a tiny or empty list — this
    // floor catches that directly, on top of the reverse allowlist check
    // below (which catches it indirectly, via an unmatched allowlist entry).
    expect(files.length).toBeGreaterThan(50);
  });

  it('flags no object-literal history argument outside the allowlist', () => {
    const offenders: string[] = [];
    const matchedAllowlistFiles = new Set<string>();
    for (const abs of files) {
      const rel = relative(REPO, abs).replace(/\\/g, '/');
      const hits = findLiteralHistoryCalls(readFileSync(abs, 'utf8'));
      const allowed = ALLOWLIST.find((a) => a.file === rel);
      if (!hits.length && !allowed) continue;
      if (!allowed) { offenders.push(`${rel}: ${hits.length} literal history arg(s)`); continue; }
      matchedAllowlistFiles.add(rel);
      if (hits.length !== allowed.count) {
        offenders.push(`${rel}: expected ${allowed.count} allowlisted literal(s), found ${hits.length}`);
      }
    }
    // Reverse direction (mirrors cast-lock.guard.test.ts): every allowlist
    // entry's file must actually have been scanned. If it wasn't — because
    // the file moved, or because `files` came back empty from a broken
    // walker path — that is exactly the fail-open hazard the file header
    // describes, and it must redden rather than pass on zero evidence.
    for (const allowed of ALLOWLIST) {
      if (!matchedAllowlistFiles.has(allowed.file)) {
        offenders.push(`${allowed.file}: allowlisted for ${allowed.count} literal(s), but was never scanned`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /* Neutralisation proof — without this, a scanner that silently matched
     NOTHING (a broken path, a renamed call, a regex that never fires) would
     pass this suite green forever while defending nothing. */
  it('actually detects a violation', () => {
    const violating = `
      const r = buildCastResolver(cast, { supersededBy: history.supersededBy });
    `;
    expect(findLiteralHistoryCalls(violating)).toHaveLength(1);
  });

  it('does not fire on the correct shape', () => {
    expect(findLiteralHistoryCalls('const r = buildCastResolver(cast, castIdHistory);')).toEqual([]);
    expect(findLiteralHistoryCalls('isAudioCurrent(resolution, seg, castIdHistory);')).toEqual([]);
  });

  it('is not fooled by a nested call or an object in an EARLIER argument', () => {
    expect(findLiteralHistoryCalls('buildCastResolver(pick({ id: 1 }), castIdHistory);')).toEqual([]);
    expect(findLiteralHistoryCalls('isAudioCurrent(resolve(id), { castHistorySeq: 3 }, history);')).toEqual([]);
  });

  it('ignores a call quoted in a comment or a string', () => {
    expect(findLiteralHistoryCalls('// buildCastResolver(cast, { supersededBy: {} })')).toEqual([]);
    expect(findLiteralHistoryCalls('/* buildCastResolver(cast, { supersededBy: {} }) */')).toEqual([]);
    expect(findLiteralHistoryCalls('const s = "buildCastResolver(cast, { supersededBy: {} })";')).toEqual([]);
  });
});
