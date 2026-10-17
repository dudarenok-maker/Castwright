/* #2246 — pass-2 review of PR #2492, finding "B1 root cause" (server-2246
   B1 fix-agent round): a fixture-shaped blind spot in state-language.guard.test.ts.

   THE INCIDENT THIS TRACES BACK TO. #1969's `chapter-qa-repair.test.ts`
   fixture (`scaffoldStaleAuditionBook`) had no `language` key. Months later
   this PR added a pre-flight `409 language_unset` gate to
   `chapter-qa-repair.ts`, and the old fixture broke — CI reported it as an
   unrelated-looking red in a completely different test file
   (`server-2246-language-recurrence`, commit `dd0be129`, "re-sweep language
   fixtures property-keyed" — despite the message, the actual diff was one
   line, `+ language: 'en'`, at exactly the fixture CI happened to name).

   THE GAP. `state-language.guard.test.ts`'s `collectSourceFiles` excludes
   `*.test.ts` by construction (correct for ITS job — auditing production
   write sites) — so it structurally cannot see a TEST FIXTURE that builds a
   `state.json`-shaped object with no `language` key. Nothing failed the
   AUTHORING run when that fixture was written; it failed a stranger's PR,
   at a randomly-later date, for a reason with no visible connection to the
   change that PR made. This guard closes that: it scans `*.test.ts` files
   (the complement of the production guard) for a `state.json`-shaped
   fixture built in a file that actually exercises a language-gated route,
   and fails if the fixture omits `language`.

   WHY NOT A SHARED TYPESCRIPT-LEVEL FIX (the higher-leverage option when
   available, per Task 7's own design note). There is no shared fixture
   builder: `grep -rn 'function (make|build|create)State'` across
   `server/src` turns up nine PER-FILE local helpers, none shared across
   files, and the ~150 other `state.json` fixtures in this tree are raw
   object literals or `JSON.stringify(...)` blobs written ad hoc. `language`
   is also optional on `BookStateJson` itself (only `BookStateJsonWrite`,
   the seam's own write type, makes it required `string | null`) — a
   TEST-SIDE fixture that never goes through the seam gets no compiler help
   either way. So this is the SAME syntactic-scan idiom as
   state-language.guard.test.ts, applied to the complementary file set.

   SCOPE, BY DESIGN. NOT every `state.json`-shaped fixture in the tree needs
   `language` — most tests never touch a language-gated route, and forcing
   `language: 'en'` onto all ~150 of them would be exactly the kind of
   unrequested, speculative churn CLAUDE.md's "Surgical changes" section
   rules out. This guard only looks at fixtures in files that actually
   exercise one of the gated entry points — the pre-flight-gated route
   modules AND the two analyzer job functions that gate independently of
   the HTTP layer (`runMainAnalyzerJob` / `runSubsetAnalyzerJob`, which is
   exactly how the four `analysis.*.test.ts` files below are at risk today
   without a live break: they call the job function directly, bypassing the
   route's own pre-flight). A `vi.doMock(...)` factory naming a router
   identifier as a mock shape (`generationRouter: undefined`) is excluded —
   that's a stub, not a mount.

   A DELIBERATE test of the gate itself (a fixture built specifically to
   prove the 409/error fires, e.g. `chapter-splice.test.ts`'s "unset book
   language" describe block) is excluded by a nearby `language_unset` /
   "Deliberately NO `language`" marker — the same shape as this file wants
   to catch, used on purpose.

   KNOWN, PRE-EXISTING GAP (not a regression, not fixed here — see the
   PER-FILE allowlist below). Six `analysis*.test.ts` files build
   language-less fixtures that reach `runMainAnalyzerJob`/`runSubsetAnalyzerJob`
   directly and pass today only because that path doesn't (yet) enforce the
   route's pre-flight check. Pass-2 of the #2492 review confirmed these:
   "no live second instance today" — they're pinned here, by file and exact
   count, asserted BOTH ways (per state-language.guard.test.ts's own G1/G3
   idiom), so this guard is fail-closed against a SEVENTH file joining the
   set, or the count moving in an already-pinned file, while staying quiet
   about the ones already on record. Do not grow this allowlist to swallow
   a new instance — fix the fixture instead.

   DECLARED BLIND SPOTS (same shape as state-language.guard.test.ts's own):
     - a fixture assembled by spreading a shared base object — the marker
       this guard keys on (`language:`) must appear in the SAME object
       literal;
     - a gated-file signal computed from router/job identifiers and import
       paths, not a call graph — a route mounted through an intermediary
       re-export would not be detected;
     - template-literal `${...}` JSON bodies, skipped whole as opaque. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/** Every `*.test.ts` file under `server/src`, recursively — the complement
    of state-language.guard.test.ts's `collectSourceFiles`. */
function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** If `src[i]` opens a string/template literal or a line/block comment,
    return the index just past its end. Duplicated behaviourally from
    state-language.guard.test.ts / cast-lock.guard.test.ts. */
function skipOpaqueToken(src: string, i: number): number {
  const n = src.length;
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    const quote = ch;
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === quote) {
        j++;
        break;
      }
      j++;
    }
    return j;
  }
  if (ch === '/' && src[i + 1] === '/') {
    let j = i + 2;
    while (j < n && src[j] !== '\n') j++;
    return j;
  }
  if (ch === '/' && src[i + 1] === '*') {
    let j = i + 2;
    while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
    j += 2;
    return j;
  }
  return -1;
}

interface Range {
  start: number;
  end: number;
}

function computeOpaqueRanges(content: string): Range[] {
  const ranges: Range[] = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    const skip = skipOpaqueToken(content, i);
    if (skip !== -1) {
      ranges.push({ start: i, end: skip });
      i = skip;
      continue;
    }
    i++;
  }
  return ranges;
}

function opaqueRangeAt(ranges: Range[], index: number): Range | undefined {
  return ranges.find((r) => index >= r.start && index < r.end);
}

function isOpaque(ranges: Range[], index: number): boolean {
  return opaqueRangeAt(ranges, index) !== undefined;
}

/** Classify every `{` in `content` as an object-literal opener ('obj') or a
    block-statement opener ('block'), from the last significant (non-opaque,
    non-whitespace) token before it: preceded by `( , [ : = ? & |` or the
    keyword `return` -> an expression position, so an object literal;
    everything else (`) ; } {`, an `=>` arrow-body, a bare identifier or
    keyword, start-of-file) -> a block statement. Zero-grammar, same
    tolerance as the rest of this scanning idiom: a TS return-type object
    TYPE literal (`): { a: T }`) also follows `:` and reads as 'obj' here,
    harmless since a type position never spells out BookState's fixture
    VALUES. */
function classifyBraces(content: string): Array<'obj' | 'block' | undefined> {
  const n = content.length;
  const kind: Array<'obj' | 'block' | undefined> = new Array(n);
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  const exprChars = new Set(['(', ',', '[', ':', '=', '?', '&', '|']);
  while (i < n) {
    const skip = skipOpaqueToken(content, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const ch = content[i];
    if (ch === '{') {
      const prevTwo = content.slice(Math.max(0, i - 2), i).trimEnd();
      const isArrowBody = prevTwo.endsWith('=>');
      kind[i] = !isArrowBody && (exprChars.has(lastSig) || lastWord === 'return') ? 'obj' : 'block';
      lastSig = '{';
      lastWord = '';
    } else if (ch === '}') {
      lastSig = '}';
      lastWord = '';
    } else if (/\s/.test(ch)) {
      // whitespace: lastSig/lastWord unchanged
    } else if (/[A-Za-z0-9_$]/.test(ch)) {
      lastWord += ch;
      lastSig = ch;
    } else {
      lastSig = ch;
      lastWord = '';
    }
    i++;
  }
  return kind;
}

/** Every object-literal span in `content`, per `classifyBraces` — ALL of
    them, at every nesting depth, not just outermost. Callers filter to
    "state.json-shaped" spans by signal-key content and THEN dedupe to the
    maximal span among those matches (see `maximalMatches` below); dedup
    can't happen here because whether an outer span "contains" a real
    fixture depends on the outer's own signal-key content, which this
    function doesn't compute. */
function findObjectLiteralSpans(
  content: string,
  opaque: Range[],
  braceKind: Array<'obj' | 'block' | undefined>,
): Range[] {
  const spans: Range[] = [];
  const stack: Array<{ start: number; obj: boolean }> = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    const r = opaqueRangeAt(opaque, i);
    if (r) {
      i = r.end;
      continue;
    }
    const ch = content[i];
    if (ch === '{') {
      stack.push({ start: i, obj: braceKind[i] === 'obj' });
    } else if (ch === '}') {
      const top = stack.pop();
      if (top && top.obj) {
        spans.push({ start: top.start, end: i });
      }
    }
    i++;
  }
  return spans;
}

/** Among `matched` spans (all already known to be state.json-shaped), keep
    only the ones not fully contained inside another matched span — avoids
    reporting the same fixture twice when it happens to nest (e.g. inside a
    wrapping helper call). */
function maximalMatches(matched: Range[]): Range[] {
  return matched.filter(
    (s) =>
      !matched.some(
        (o) => o !== s && o.start <= s.start && s.end <= o.end && !(o.start === s.start && o.end === s.end),
      ),
  );
}

const SIGNAL_KEYS = ['bookId', 'manuscriptId', 'castConfirmed', 'isStandalone', 'manuscriptFile'];
const SIGNAL_THRESHOLD = 3;

/** How many of BookStateJson's distinctive, non-optional field names appear
    as a `key:` in `text` — a `state.json`-shaped fixture, not some
    unrelated large object. */
function signalKeyCount(text: string): number {
  let count = 0;
  for (const key of SIGNAL_KEYS) {
    if (new RegExp(`\\b${key}\\s*:`).test(text)) count++;
  }
  return count;
}

/* Identifiers whose presence in a test file means it exercises a
   language-gated entry point: the eight gated routers' exported names, plus
   the two analyzer job functions that gate independently of the HTTP
   pre-flight (a test can call either directly, bypassing the route). */
const GATE_SIGNAL_NAMES = [
  'chapterQaRepairRouter',
  'chapterSpliceRouter',
  'singleDesignRouter',
  'scriptReviewRouter',
  'qwenVoiceRouter',
  'generationRouter',
  'castDesignRouter',
  'analysisRouter',
  'runMainAnalyzerJob',
  'runSubsetAnalyzerJob',
];
const GATE_SIGNAL_RE = new RegExp('\\b(?:' + GATE_SIGNAL_NAMES.join('|') + ')\\b', 'g');

/** Balanced-paren spans of every `vi.doMock(...)` call — a mock factory
    naming a router identifier as a stub key (`generationRouter: undefined`)
    is not a real mount, so a signal match inside one doesn't count. */
function findDoMockSpans(content: string, opaque: Range[]): Range[] {
  const spans: Range[] = [];
  const re = /\bvi\.doMock\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (isOpaque(opaque, m.index)) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const n = content.length;
    while (i < n && depth > 0) {
      const r = opaqueRangeAt(opaque, i);
      if (r) {
        i = r.end;
        continue;
      }
      if (content[i] === '(') depth++;
      else if (content[i] === ')') depth--;
      i++;
    }
    spans.push({ start: m.index, end: i });
  }
  return spans;
}

/** True iff `content` exercises a language-gated route or analyzer job
    function outside a `vi.doMock` stub shape. */
function fileIsGated(content: string, opaque: Range[]): boolean {
  const mockSpans = findDoMockSpans(content, opaque);
  GATE_SIGNAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GATE_SIGNAL_RE.exec(content))) {
    if (isOpaque(opaque, m.index)) continue;
    if (mockSpans.some((s) => m!.index >= s.start && m!.index < s.end)) continue;
    return true;
  }
  return false;
}

/* A fixture deliberately built to prove the gate itself fires (e.g.
   chapter-splice.test.ts's "unset book language" describe block) names the
   error code, or says so outright, within the same test — never just in the
   object literal it builds. Excluded, same as the guard's own opaque-token
   tolerance for prose that happens to spell out a pattern. */
const DELIBERATE_RE = /language_unset|Deliberately\s+NO\s+`?language/i;
const DELIBERATE_WINDOW = 4000;

/* Pre-existing gap, NOT fixed by this guard (see header). Six files build a
   language-less state.json fixture that reaches `runMainAnalyzerJob` /
   `runSubsetAnalyzerJob` directly and pass today only because that path
   doesn't enforce the route's own pre-flight 409. Keyed on file AND exact
   count, asserted both ways — a SEVENTH file, or a count change in one of
   these six, reddens (that's the guard doing its job); don't grow this map
   to swallow a new instance. */
const KNOWN_GAP: Record<string, number> = {
  'routes/analysis.test.ts': 13,
  'routes/analysis.live-id-retire-filter.test.ts': 1,
  'routes/analysis.merge-base-detect.test.ts': 1,
  'routes/analysis.persist-block-degraded-history.test.ts': 3,
  'routes/analysis.persist-lock-timeout.test.ts': 1,
  'routes/analysis.rename-midrun.test.ts': 1,
};
const KNOWN_GAP_FLOOR_FILES = 5;

describe('state.json test-fixture language — static guard (#2246 B1 root cause)', () => {
  it("H1: a state.json fixture in a language-gated test file always states `language`, except the recorded pre-existing gap", () => {
    const files = collectTestFiles(SRC_ROOT);
    const problems: string[] = [];
    const perFileMissing: Record<string, number> = {};
    let gatedFileCount = 0;
    let gatedSpanCount = 0;

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      const opaque = computeOpaqueRanges(content);
      if (!fileIsGated(content, opaque)) continue;
      gatedFileCount++;

      const braceKind = classifyBraces(content);
      const spans = findObjectLiteralSpans(content, opaque, braceKind);
      const matched = spans.filter((s) => signalKeyCount(content.slice(s.start, s.end)) >= SIGNAL_THRESHOLD);
      const stateSpans = maximalMatches(matched);
      gatedSpanCount += stateSpans.length;

      const missingLines: number[] = [];
      for (const s of stateSpans) {
        const text = content.slice(s.start, s.end);
        if (/\blanguage\s*:/.test(text)) continue;
        const before = content.slice(Math.max(0, s.start - DELIBERATE_WINDOW), s.start);
        const after = content.slice(s.end, Math.min(content.length, s.end + DELIBERATE_WINDOW));
        if (DELIBERATE_RE.test(before) || DELIBERATE_RE.test(after)) continue; // deliberate gate test
        const line = content.slice(0, s.start).split('\n').length;
        missingLines.push(line);
      }
      if (missingLines.length > 0) perFileMissing[rel] = missingLines.length;

      const expected = KNOWN_GAP[rel] ?? 0;
      if (missingLines.length > expected) {
        problems.push(
          `${rel}: ${missingLines.length} state.json-shaped fixture(s) missing \`language\` in a file that exercises a ` +
            `language-gated route/job (lines ${missingLines.join(', ')}) — ${expected} already recorded in KNOWN_GAP. This ` +
            `is exactly the #1969/#2492 recurrence shape: an untyped fixture that will 409 the moment its route's ` +
            `pre-flight actually runs against it. Add \`language: 'en'\` (or a real value) to the fixture, or — if this ` +
            `is a deliberate test of the language-unset gate itself — name \`language_unset\` nearby so this guard ` +
            `recognises the intent.`,
        );
      } else if (missingLines.length < expected) {
        problems.push(
          `${rel}: KNOWN_GAP records ${expected} pre-existing language-less fixture(s), but the scan now finds only ` +
            `${missingLines.length} — update KNOWN_GAP down to match (the gap was narrowed; record the improvement).`,
        );
      }
    }

    for (const rel of Object.keys(KNOWN_GAP)) {
      if (perFileMissing[rel] === undefined) {
        problems.push(
          `${rel}: KNOWN_GAP records ${KNOWN_GAP[rel]} pre-existing language-less fixture(s), but the scan now finds ` +
            `none (file no longer gated, or the fixtures were fixed) — remove this entry.`,
        );
      }
    }

    // Fail closed on absent evidence: if the gate-signal scan itself broke
    // (e.g. every router got renamed), don't let this guard pass vacuously.
    if (gatedFileCount < KNOWN_GAP_FLOOR_FILES) {
      problems.push(
        `Only ${gatedFileCount} file(s) matched as language-gated — expected at least ${KNOWN_GAP_FLOOR_FILES}. The ` +
          `gate-signal scan may be broken (a renamed router/job export, or a moved route file).`,
      );
    }
    if (gatedSpanCount < 20) {
      problems.push(
        `Only ${gatedSpanCount} state.json-shaped fixture span(s) found across gated files — expected at least 20. ` +
          `The object-literal scan may be broken.`,
      );
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});
