/* #2246 Task 7 — the static guard that stops a future writer bypassing the
   state.json write seam.

   The design ("The static guard", docs/superpowers/specs/2026-08-13-language-
   recurrence-and-prompt-design.md) starts from the failure that motivated it:
   types close the spreads and every future mint, but a spread of a JSON.parse
   `any` compiles clean against the write type — which is exactly how
   `samples.ts` slipped through. This guard is the complement: it enforces that
   NOTHING writes state.json outside the sanctioned seam
   (`writeStateJsonAtomic` in state-migrate.ts), the property that makes the
   type check total.

   BUILT IN THE cast-lock.guard.test.ts IDIOM, as #2246 requires: a scan over
   raw source text under `server/src`, REUSING its `skipOpaqueToken` /
   `computeOpaqueRanges` / `isOpaque` helpers so a comment or string that
   happens to spell out one of these patterns verbatim is never a site. No
   parser, no import resolver, no call-graph — the same syntactic horizon
   cast-lock works inside, and the same zero-grammar scanner quirks come with
   it (a regex literal that contains a quote can swallow following lines as one
   opaque range — a known, accepted artifact of the idiom).

   THREE CHECKS:

   G1 — SEAM EXCLUSIVITY, FILE-scoped (deliberately, not adjacency-scoped).
     The dominant idiom here is the extracted path — `const p =
     stateJsonPath(bookDir); … later … writeJsonAtomic(p, …)` — which
     adjacency matching does not see at all. So in ANY non-test file under
     `server/src` that mentions `stateJsonPath(`, EVERY `writeJsonAtomic(`
     occurrence is a finding UNLESS the file is the seam itself
     (`state-migrate.ts`, G1's only file-level exemption) or a pinned allowlist
     entry. Files that legitimately write OTHER .json alongside state.json go on
     the allowlist with an exact count and a reason, asserted BOTH ways — a
     further unlocked write in an allowlisted file fails it just like any other.

   G2 — NO RAW SERIALISATION INTO THE STATE PATH. Catches the two mechanisms
     that bypass writeJsonAtomic entirely: (a) `planEntry`/`writeFile` writing
     a Buffer/JSON.stringify at `stateJsonPath(…)`, and (b) a hand-built
     `join(<any args>, 'state.json')` fed to a writer, in ANY arity (the
     two-arg-only first draft missed `samples.ts`'s three-arg join; a join is
     only a finding when it reaches a writer, never a read). One raw writer is
     pinned — the atomic bundle importer scan-import-folder — allowed ONLY
     while it keeps the seam's stated-absence contract
     (`language: state.language ?? null`); drop that marker and it reddens (M4).

   G3 — FAIL CLOSED ON ABSENT EVIDENCE. Floors of 35 sites across 19 files
     (re-measured this run: 45 across 23), PLUS a per-file expected-count map
     asserted BOTH ways, so aliasing a single file's import reddens that exact
     file (M5). A bare global floor is too slack for a realistic mutation to
     breach; the per-file map is the binding constraint.

   DECLARED BLIND SPOTS (from the design, verbatim):
     - aliased writer/path imports — the scan matches names, not bindings;
     - a path built by concatenation rather than join(..., 'state.json');
     - spread-of-`any` / `JSON.parse` results — the type's blind spot, and this
       guard's too, since the call looks correct at both layers;
     - call-graph indirection — deliberately syntactic and call-graph blind;
     - template-literal `${...}`, skipped whole as opaque;
     - scripts/*.mjs / *.mts writers outside server/src — the live one,
       `repair-missing-book-language.mts`, writes state.json and this guard
       cannot see it (out of scope, #2256, and off-limits here).

   MUTATION-PROOF — the task issue's table IS the acceptance; every row was run
   individually with the others reverted, and the red named the mutated file:
     M1  delete language from import.ts's mint literal             → typecheck
     M2  language: undefined at every corrected-list site          → typecheck
     M3  add a bare writeJsonAtomic(p, s) to a stateJsonPath file    → G1
     M4  revert scan-import-folder to stage the un-normalised buffer → G2
     M5  alias stateJsonPath in one file                              → G3
     M6  revert one migrated writer to writeJsonAtomic(statePath,…)  → G1
   Negative control (stays GREEN): a prose comment quoting
   `writeJsonAtomic(stateJsonPath(` and a string literal `join(dir,'state.json')`
   — both opaque, never sites. `git diff` empty of mutations before finalise. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src
const SEAM_FILE = 'workspace/state-migrate.ts';

/** Every non-test `.ts` file under `server/src`, recursively. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** If `src[i]` opens a string/template literal or a line/block comment, return
    the index just past its end (handling backslash escapes inside quotes, and
    the unterminated-comment case by running to EOF). Otherwise return -1.
    Reused behaviourally from cast-lock.guard.test.ts. */
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

/** Every [start, end) span in `content` that is a string/template literal or a
    comment, per `skipOpaqueToken`. Reused behaviourally from
    cast-lock.guard.test.ts. */
function computeOpaqueRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
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

/** True iff `index` falls inside one of `ranges` — a string/template/comment,
    not real code. Reused behaviourally from cast-lock.guard.test.ts. */
function isOpaque(ranges: Array<{ start: number; end: number }>, index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

/** Count non-opaque (real-code) occurrences of `re` in `content`. `re` is
    shared global state so `lastIndex` is reset before scanning, exactly as
    WRITE_RE is handled in cast-lock.guard.test.ts. */
function countInCode(
  content: string,
  re: RegExp,
  opaque: Array<{ start: number; end: number }>,
): number {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let c = 0;
  while ((m = re.exec(content))) {
    if (!isOpaque(opaque, m.index)) c++;
  }
  return c;
}

// ---------------------------------------------------------------- G1

const STATE_PATH_RE = /\bstateJsonPath\(/g;
const WRITE_JSON_ATOMIC_RE = /\bwriteJsonAtomic\(/g;

/* Files that mention stateJsonPath and legitimately call writeJsonAtomic for
   OTHER .json files, never for state.json. Keyed on RELATIVE PATH AND COUNT,
   never path alone; asserted BOTH ways. Every target was classified from
   current source, not assumed. */
const G1_ALLOWED = new Map<string, { writes: number; why: string }>([
  [
    'routes/book-state.ts',
    {
      writes: 9,
      why: 'writes cast.json, edits, revisions.json, change-log.json, carryover, log, listen-progress.json and listen-stats.json — all OTHER per-book .json, never state.json (its state writes route through writeStateJsonAtomic). One writeJsonAtomic( on :1070 is prose in a comment and is opaque, hence 9 not 10.',
    },
  ],
  [
    'routes/analysis.ts',
    {
      writes: 6,
      why: 'writes cast.json (castJsonPath), logPath and manuscript-edits.json — all OTHER .json.',
    },
  ],
  [
    'routes/voices.ts',
    {
      writes: 3,
      why: 'writes voices-meta.json and cast.json (castJsonPath) — never state.json.',
    },
  ],
  [
    'workspace/auto-backup.ts',
    {
      writes: 1,
      why: "writeJsonAtomic(snap, value) writes a COPY of state.json to the workspace .backups/<bookId> snapshot dir — deliberately OUTSIDE every book's state path. Its restore writes state.json back THROUGH writeStateJsonAtomic (:226).",
    },
  ],
  [
    'workspace/voice-library-usage.ts',
    {
      writes: 1,
      why: 'writes cast.json (castJsonPath) — not state.json.',
    },
  ],
  [
    'routes/chapters-restructure.ts',
    {
      writes: 1,
      why: 'writes edits.json (manuscript-edits) — not state.json.',
    },
  ],
  [
    'audio/finalize-chapter-write.ts',
    {
      writes: 1,
      why: 'writes the chapter segments file (segPath) — not state.json.',
    },
  ],
]);

// ---------------------------------------------------------------- G2

const RAW_STATE_WRITE_RE = /\b(?:planEntry|writeFile)\(\s*stateJsonPath\(/g;
const JOIN_STATE_WRITE_RE = /\b(?:writeFile|writeJsonAtomic|planEntry)\([^)]*state\.json'/g;

/* The one raw-to-state-path writer that exists today, pinned with its count AND
   a required normalisation marker: the bundle importer writes state.json through
   its own staged write+rename across the bundle, but a write that does NOT
   restate language is exactly the untyped bypass the seam forbids. Remove the
   marker or change the count and G2 reddens naming this file (M4). */
const G2_RAW_ALLOWED = new Map<string, { writes: number; marker: RegExp; why: string }>([
  [
    'import/scan-import-folder.ts',
    {
      writes: 1,
      marker: /\blanguage:\s*state\.language\s*\?\?\s*null/g,
      why: 'atomic portable-bundle importer: stages state.json via planEntry(stateJsonPath(bookDir), finalStateBuf, ...) then writeFile+rename across the whole bundle; required to restate language (language: state.language ?? null) so a language-less bundle lands as explicit null, not an untyped write.',
    },
  ],
]);

/** Number of raw-serialisation-into-state-path findings in `content`. */
function countRawStateWrites(
  content: string,
  opaque: Array<{ start: number; end: number }>,
): number {
  return (
    countInCode(content, RAW_STATE_WRITE_RE, opaque) +
    countInCode(content, JOIN_STATE_WRITE_RE, opaque)
  );
}

// ---------------------------------------------------------------- G3

/* Per-file expected sites of `stateJsonPath(` — re-measured from current source
   at implementation time (NOT the plan's floor numbers, which have drifted once
   already): 46 sites across 23 non-test files (voices.ts gained a 4th site in
   #2006's series-wide clone-consent veto — a per-book state.json read added to
   the workspace scan). Asserted BOTH ways; aliasing one file's import reddens
   that exact file (M5). */
const G3_STATE_SITES: Record<string, number> = {
  'audio/finalize-chapter-write.ts': 1,
  'audio/render-integrity/aggregate.ts': 1,
  'cover/store.ts': 2,
  'cover/upload.ts': 2,
  'import/scan-import-folder.ts': 1,
  'routes/analysis.ts': 2,
  'routes/book-state.ts': 9,
  'routes/chapters-restructure.ts': 1,
  'routes/generation.ts': 2,
  'routes/import.ts': 1,
  'routes/library-sync-manifest.ts': 1,
  'routes/samples.ts': 2,
  'routes/voices.ts': 4,
  'store/attribution-health-io.ts': 2,
  'workspace/active-analyses.ts': 1,
  'workspace/auto-backup.ts': 3,
  'workspace/book-dir-guard.ts': 1,
  'workspace/library-cast-scan.ts': 1,
  'workspace/scan.ts': 4,
  'workspace/series-cast-scan.ts': 2,
  'workspace/series-full-cast-scan.ts': 1,
  'workspace/series-reuse-link.ts': 1,
  'workspace/voice-library-usage.ts': 1,
};
const G3_FLOOR_SITES = 35;
const G3_FLOOR_FILES = 19;

describe('state.json write seam — static guard (#2246 Task 7)', () => {
  it('G1: no writeJsonAtomic in a stateJsonPath-mentioning file, except the seam and the pinned other-JSON allowlist', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (rel === SEAM_FILE) continue;
      const content = readFileSync(file, 'utf8');
      const opaque = computeOpaqueRanges(content);
      const mentions = countInCode(content, STATE_PATH_RE, opaque);
      if (mentions === 0) continue; // not a stateJsonPath-mentioning file → G1 silent
      const writes = countInCode(content, WRITE_JSON_ATOMIC_RE, opaque);
      if (writes === 0) continue;

      const allowed = G1_ALLOWED.get(rel);
      if (!allowed) {
        problems.push(
          `${rel}: ${writes} writeJsonAtomic(...) call(s) in a file that mentions stateJsonPath — state.json must go ` +
            `through writeStateJsonAtomic (state-migrate.ts), never a bare writeJsonAtomic. Not on the allowlist; do NOT ` +
            `allowlist a real state write away — report it.`,
        );
        continue;
      }
      matchedAllowlistKeys.add(rel);
      if (writes !== allowed.writes) {
        problems.push(
          `${rel}: allowlisted for exactly ${allowed.writes} non-state writeJsonAtomic call(s) (${allowed.why}), but the scan ` +
            `found ${writes}.`,
        );
      }
    }

    for (const [rel, allowed] of G1_ALLOWED) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.writes} non-state writeJsonAtomic call(s), but the scan now finds the file clean ` +
            `or no longer stateJsonPath-mentioning — update or remove this allowlist entry.`,
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('G2: no raw serialisation into the state path, except the pinned, marker-conditioned scan-import-folder allowance', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      const opaque = computeOpaqueRanges(content);
      const raw = countRawStateWrites(content, opaque);
      if (raw === 0) continue;

      const allowed = G2_RAW_ALLOWED.get(rel);
      if (!allowed) {
        problems.push(
          `${rel}: ${raw} raw serialisation(s) into the state path (planEntry/writeFile at stateJsonPath(...), or a writer fed a ` +
            `hand-built join(..., 'state.json')). Route through writeStateJsonAtomic instead.`,
        );
        continue;
      }
      matchedAllowlistKeys.add(rel);
      if (raw !== allowed.writes) {
        problems.push(
          `${rel}: allowlisted for exactly ${allowed.writes} raw state write(s), but the scan found ${raw}.`,
        );
      }
      if (countInCode(content, allowed.marker, opaque) === 0) {
        problems.push(
          `${rel}: allowlisted raw state write without its required normalisation marker (${String(allowed.marker)}) — an ` +
            `un-normalised, untyped state.json write is exactly what the seam forbids (${allowed.why}).`,
        );
      }
    }

    for (const [rel, allowed] of G2_RAW_ALLOWED) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.writes} raw state write(s), but the scan now finds none — update or remove this entry.`,
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('G3: fail closed — global floors plus the per-file expected-count map for stateJsonPath(', () => {
    const files = collectSourceFiles(SRC_ROOT);
    let totalSites = 0;
    const perFile: Record<string, number> = {};
    const observedKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      const opaque = computeOpaqueRanges(content);
      const n = countInCode(content, STATE_PATH_RE, opaque);
      if (n === 0) continue;
      perFile[rel] = n;
      totalSites += n;
      observedKeys.add(rel);
    }

    const problems: string[] = [];
    if (totalSites < G3_FLOOR_SITES) {
      problems.push(
        `stateJsonPath( site count fell below the floor: ${totalSites} < ${G3_FLOOR_SITES}.`,
      );
    }
    if (observedKeys.size < G3_FLOOR_FILES) {
      problems.push(
        `stateJsonPath( file count fell below the floor: ${observedKeys.size} < ${G3_FLOOR_FILES}.`,
      );
    }

    for (const [rel, expected] of Object.entries(G3_STATE_SITES)) {
      if (perFile[rel] === undefined) {
        problems.push(
          `${rel}: expected ${expected} site(s) but the file now scans with none — update/remove the map entry.`,
        );
      } else if (perFile[rel] !== expected) {
        problems.push(
          `${rel}: expected exactly ${expected} site(s) but found ${perFile[rel]} — an aliased import would do this (M5).`,
        );
      }
    }
    for (const rel of Object.keys(perFile)) {
      if (G3_STATE_SITES[rel] === undefined) {
        problems.push(
          `${rel}: has ${perFile[rel]} site(s) but is not in the per-file map — add it or fold it out of state usage.`,
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});
