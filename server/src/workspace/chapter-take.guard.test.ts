/* #4328 (of #4319, spec 2026-11-13-chapter-take-lifecycle-design.md §5.A "The
   guard", §7 Phase 1 step 7, E4) - the static guard that keeps every chapter
   take path inside the take module. TEST CODE ONLY: it changes no behaviour.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` and
   reports a "hit" for
     RULE 1  a template literal or `join`/`resolve` call that FORMS a take name
             outside the module: a template whose last literal chunk starts
             with `.` and ends with a take suffix (the six sidecar suffixes of
             `TAKE_SIDECAR_SUFFIXES`, the three audio exts, `previous.<either>`),
             a template holding `.next-` or `.discard-`, a template with
             `.previous.` directly before an interpolation (the ext), or a
             `join` argument that is a string literal ending that way;
     RULE 2  a mutation call whose path argument is a rule-1 expression, or an
             identifier bound by a same-function `const` to one;
     RULE 3  a mutation call whose path argument is TRACKED from an audio
             directory by the resolver in `test-utils/guard-scan.ts`
             (`audioDir(...)` or an `audio/` string, through `join` / `resolve`,
             template-head and same-function `const` hops).
   Mutation calls and their path arguments (spec list): rename / renameWithRetry
   / copyFile / cp (0 and 1), rm / unlink / writeFile / writeJsonAtomic /
   writeEmbeddings / writeVerdicts / mergeVerdictRows / writeAttempted /
   createWriteStream / mkdir (0), writeChapterLufsFile (1),
   writeChapterPeaksFile (2), open (0, only with a write-flag literal), each
   with its `*Sync` variant, matched bare and as a member call. Comments and
   string / regex text never match: the scan walks the AST.
   The module files are exempt: `workspace/chapter-take.ts` and
   `workspace/take-fields.ts` (R10-2: the leaf is part of the module).

   IT IS A TRIPWIRE, NOT A PROOF (E4). FALSE NEGATIVES (take paths this does
   NOT catch - spec §5.A "Blind spots", verbatim):
     - a variable suffix or root from outside the function (a parameter, a
       helper's return, a reassigned `let`);
     - a path from an array or loop variable;
     - a zip-relative path;
     - an aliased named import;
     - a variable from another module;
     - a new caller of a module entry point that holds no book-op;
     - `scripts/*.mjs` and anything outside `server/src`.
   Also by construction: a `join(book, 'audio')` whose only audio text is the
   bare word `audio` is not a root (the spec's root is `audio/` inside, or
   ending `/audio`), and a closure reading its parent function's `const` is a
   different function and is not followed.

   ALLOWLIST. Keyed by repo-relative path (under `server/src`); EXACT counts,
   enforced in BOTH directions, the way `cast-lock.guard.test.ts` does it: more
   hits than `count` is a new violation, fewer is "lower your entry".
     { count, permanentCount?, removedBy, reason }
   `count` is the file's TOTAL hits. `permanentCount` (default 0) is the part
   of them that is permanent: a hit that is not a take part (the `audio/`
   directory itself, a book-level file - §4.3) or the reparse wipe (§5.A
   Ownership). `removedBy` is the child of #4319 that deletes the migratable
   rest (count - permanentCount), or `'permanent'` when the whole entry stays.
   Each later child lowers its own entries; Phase 1's verify child checks that
   only permanent entries remain.

   MUTATION CHECK (B8): the scan is exposed as `scanTakePaths(fileName, text)`
   and the tests below feed it synthetic sources - never a planted real file. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
  resolvedCallName,
  collectSourceFiles,
  isTrackedAudioPath,
  isTrackedBy,
  parseGuardSource,
  unwrapExpression,
} from '../test-utils/guard-scan.js';
import { CHAPTER_AUDIO_EXTS, TAKE_SIDECAR_SUFFIXES } from './take-fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/** Files that ARE the take module (R10-2: the leaf counts as the module). */
const MODULE_FILES: ReadonlySet<string> = new Set([
  'workspace/chapter-take.ts',
  'workspace/take-fields.ts',
]);

/* ---------------------------------------------------------------------------
   Rule tables
   ------------------------------------------------------------------------- */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SUFFIX_ALT = [...Object.values(TAKE_SIDECAR_SUFFIXES), ...CHAPTER_AUDIO_EXTS]
  .map(escapeRe)
  .join('|');
/** A chunk that starts with `.` and ends with a take suffix (`.mp3`,
    `.previous.m4a`, `.segments.json`, ...). */
const TAKE_TAIL_RE = new RegExp(`^\\..*\\.(?:${SUFFIX_ALT})$`);
const TAKE_TAIL_SHORT_RE = new RegExp(`^\\.(?:${SUFFIX_ALT})$`);
const isTakeTail = (chunk: string): boolean =>
  TAKE_TAIL_SHORT_RE.test(chunk) || TAKE_TAIL_RE.test(chunk);
const NEXT_DISCARD_RE = /\.(?:next|discard)-/;
const PREVIOUS_THEN_EXT_RE = /\.previous\.$/;

/** Mutation call -> the argument indices that carry a path. */
const MUTATION_ARGS: ReadonlyMap<string, readonly number[]> = (() => {
  const base: Array<[string, readonly number[]]> = [
    ['rename', [0, 1]],
    ['renameWithRetry', [0, 1]],
    ['copyFile', [0, 1]],
    ['cp', [0, 1]],
    ['rm', [0]],
    ['unlink', [0]],
    ['writeFile', [0]],
    ['writeJsonAtomic', [0]],
    ['writeEmbeddings', [0]],
    ['writeVerdicts', [0]],
    ['mergeVerdictRows', [0]],
    ['writeAttempted', [0]],
    ['createWriteStream', [0]],
    ['mkdir', [0]],
    ['writeChapterLufsFile', [1]],
    ['writeChapterPeaksFile', [2]],
    ['open', [0]],
  ];
  const map = new Map<string, readonly number[]>();
  for (const [name, idx] of base) {
    map.set(name, idx);
    map.set(`${name}Sync`, idx);
  }
  return map;
})();

/** `open` / `openSync` mutate only with a write flag (`w`, `a`, `r+`, `+`). */
const WRITE_FLAG_RE = /[wa+]/;

/* ---------------------------------------------------------------------------
   The scan
   ------------------------------------------------------------------------- */

interface Hit {
  rule: 1 | 2 | 3;
  start: number;
  end: number;
  line: number;
  text: string;
}

function isStringish(
  e: ts.Node,
): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
}

/** Rule 1 for a template literal. */
function templateFormsTakeName(t: ts.TemplateExpression): boolean {
  const chunks = [t.head.text, ...t.templateSpans.map((s) => s.literal.text)];
  const tail = chunks[chunks.length - 1];
  if (isTakeTail(tail)) return true;
  return chunks.some((c) => NEXT_DISCARD_RE.test(c) || PREVIOUS_THEN_EXT_RE.test(c));
}

/** Rule 1 for a `join` / `resolve` call: a string-literal argument ending as a
    take name does. (A template argument is a rule-1 hit of its own.) */
function joinFormsTakeName(call: ts.CallExpression): boolean {
  const name = resolvedCallName(call);
  if (name !== 'join' && name !== 'resolve') return false;
  return call.arguments.some((a) => isStringish(a) && isTakeTail(a.text));
}

/** The rule-1 expression test, also the root of rule 2's const resolution. */
function isTakeNameExpr(e: ts.Expression): boolean {
  if (ts.isTemplateExpression(e)) return templateFormsTakeName(e);
  return ts.isCallExpression(e) && joinFormsTakeName(e);
}

function opensForWrite(call: ts.CallExpression): boolean {
  const flag = call.arguments[1];
  return flag !== undefined && isStringish(flag) && WRITE_FLAG_RE.test(flag.text);
}

/** Every take-path hit in `content`, a file whose path under `server/src` is
    `fileName`. Module files report nothing. Nested hits collapse into the
    outermost one, so a call argument and the template inside it count once. */
export function scanTakePaths(fileName: string, content: string): Hit[] {
  if (MODULE_FILES.has(fileName)) return [];
  const sf = parseGuardSource(content, fileName);
  const raw: Hit[] = [];
  const add = (rule: Hit['rule'], node: ts.Node): void => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    raw.push({
      rule,
      start,
      end,
      line: sf.getLineAndCharacterOfPosition(start).line + 1,
      text: content.slice(start, Math.min(end, start + 80)).replace(/\s+/g, ' '),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && templateFormsTakeName(node)) add(1, node);
    if (ts.isCallExpression(node)) {
      if (joinFormsTakeName(node)) add(1, node);
      const name = resolvedCallName(node);
      const indices = name === null ? undefined : MUTATION_ARGS.get(name);
      const writes = name === 'open' || name === 'openSync' ? opensForWrite(node) : true;
      if (indices && writes) {
        for (const i of indices) {
          const arg = node.arguments[i];
          if (!arg) continue;
          const bare = unwrapExpression(arg);
          if (ts.isIdentifier(bare) && isTrackedBy(bare, isTakeNameExpr)) add(2, arg);
          if (isTrackedAudioPath(arg)) add(3, arg);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Collapse: keep the outermost of nested / identical spans.
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  for (const hit of raw) {
    const last = kept[kept.length - 1];
    if (last && hit.start >= last.start && hit.end <= last.end) continue;
    kept.push(hit);
  }
  return kept;
}

/* ---------------------------------------------------------------------------
   The allowlist
   ------------------------------------------------------------------------- */

interface AllowEntry {
  count: number;
  permanentCount?: number;
  removedBy: 4329 | 4330 | 4331 | 4332 | 4333 | 4334 | 4335 | 'permanent';
  reason: string;
}

const ALLOWLIST: Record<string, AllowEntry> = {
  'audio/finalize-chapter-write.ts': { count: 13, removedBy: 4333, reason: "job writer builds and writes the live take" },
  'audio/previous-audio.ts': { count: 7, removedBy: 4334, reason: "preserve/restore/revisions builds previous-take paths" },
  'audio/render-integrity/aggregate.ts': { count: 3, removedBy: 4332, reason: "audio/tts/scoring helper builds or writes take parts" },
  'audio/render-integrity/verdicts-io.ts': { count: 2, removedBy: 4332, reason: "audio/tts/scoring helper builds or writes take parts" },
  'audio/segments-io.ts': { count: 1, removedBy: 4332, reason: "audio/tts/scoring helper builds or writes take parts" },
  'import/scan-import-folder.ts': { count: 1, permanentCount: 1, removedBy: 'permanent', reason: "mkdir of audioDir(stage): the audio/ directory itself, not a take part." },
  'routes/book-state.ts': { count: 1, permanentCount: 1, removedBy: 'permanent', reason: "permanent: §5.A Ownership: the reparse wipe stays allowlisted (applyReparse rm(ad, { recursive: true, force: true }), the audio/ directory itself, not a take part)." },
  'routes/chapter-qa-repair.ts': { count: 6, removedBy: 4333, reason: "job writer builds and writes the live take" },
  'routes/chapter-splice.ts': { count: 1, removedBy: 4333, reason: "job writer builds and writes the live take" },
  'routes/generation.ts': { count: 1, permanentCount: 1, removedBy: 'permanent', reason: "mkdir of audioDir(bookDir): the audio/ directory itself, not a take part." },
  'tts/mp3.ts': { count: 1, removedBy: 4332, reason: "rule-1 false positive: a temp encode name (audiobook-encode-<pid>-<ts>.mp3), not a take path; #4332 narrows or reroutes it" },
  'tts/voice-sample-cache.ts': { count: 1, removedBy: 4332, reason: "rule-1 false positive: a voice-sample cache file name (<scope>-<model>-<hash>.mp3), not a take path; #4332 narrows or reroutes it" },
  'workspace/fsck-orphan-audio.ts': { count: 8, removedBy: 4335, reason: "fsck probes and removes take files" },
  'workspace/preserve-previous-audio.ts': { count: 7, removedBy: 4334, reason: "preserve/restore/revisions builds previous-take paths" },
};

/* ---------------------------------------------------------------------------
   Tests
   ------------------------------------------------------------------------- */

function scanTree(): Map<string, Hit[]> {
  const out = new Map<string, Hit[]>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split(sep).join('/');
    const hits = scanTakePaths(rel, readFileSync(file, 'utf8'));
    if (hits.length > 0) out.set(rel, hits);
  }
  return out;
}

const describeHits = (hits: Hit[]): string =>
  hits.map((h) => `    rule ${h.rule} @ line ${h.line}: ${h.text}`).join('\n');

describe('chapter take guard (#4328, spec §5.A) - tree scan', () => {
  it('every take path outside the take module is on the allowlist, with its exact count', () => {
    const found = scanTree();
    const problems: string[] = [];
    for (const [rel, hits] of found) {
      const entry = ALLOWLIST[rel];
      if (!entry) {
        problems.push(`${rel}: ${hits.length} take-path hit(s), NOT on the allowlist:\n${describeHits(hits)}`);
      } else if (hits.length > entry.count) {
        problems.push(
          `${rel}: raise your entry? the scan found ${hits.length} hit(s), the entry allows ${entry.count} - a NEW take path:\n${describeHits(hits)}`,
        );
      } else if (hits.length < entry.count) {
        problems.push(
          `${rel}: lower your entry - the scan found ${hits.length} hit(s), the entry still says ${entry.count}.`,
        );
      }
    }
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      if (!found.has(rel)) {
        problems.push(`${rel}: allowlisted for ${entry.count} hit(s) but the scan finds ZERO - remove the entry.`);
      }
    }
    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('allowlist entries are well formed: removedBy is a child number or permanent, with a reason', () => {
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      expect(entry.count, rel).toBeGreaterThan(0);
      expect(entry.reason.length, `${rel}: reason`).toBeGreaterThan(10);
      const permanent = entry.permanentCount ?? 0;
      expect(permanent, `${rel}: permanentCount`).toBeLessThanOrEqual(entry.count);
      if (entry.removedBy === 'permanent') {
        expect(permanent, `${rel}: a permanent entry is permanent in full`).toBe(entry.count);
      } else {
        expect(permanent, `${rel}: a migratable entry has migratable hits`).toBeLessThan(entry.count);
      }
      expect(rel.endsWith('.ts'), rel).toBe(true);
      // The module is never allowlisted - it is exempt.
      expect(MODULE_FILES.has(rel), `${rel}: the module files are exempt, not allowlisted`).toBe(false);
    }
  });

  it('the scan is real: it walks many files and finds the known sites (a scan that finds nothing proves nothing)', () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(300);
    const found = scanTree();
    expect(found.size).toBeGreaterThan(2); // the permanent entries alone are 3
    for (const rel of ['routes/book-state.ts', 'routes/generation.ts', 'import/scan-import-folder.ts']) {
      expect(found.has(rel), `${rel}: expected take-path hits`).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------------------
   Mutation check (B8): synthetic sources, never planted into real files.
   ------------------------------------------------------------------------- */

const OUTSIDE = 'routes/some-new-route.ts';
const rulesOf = (file: string, src: string): number[] => scanTakePaths(file, src).map((h) => h.rule);

describe('chapter take guard (#4328) - the scan reports what it must', () => {
  it('rule 1: a ${slug}.segments.json template is reported', () => {
    const hits = scanTakePaths(OUTSIDE, 'const p = `${slug}.segments.json`;');
    expect(hits.map((h) => h.rule)).toEqual([1]);
  });

  it('rule 1: audio exts, previous.<ext>, next-/discard- and a join string argument are reported', () => {
    expect(rulesOf(OUTSIDE, 'const p = `${slug}.mp3`;')).toEqual([1]);
    expect(rulesOf(OUTSIDE, 'const p = `${slug}.previous.m4a`;')).toEqual([1]);
    expect(rulesOf(OUTSIDE, 'const p = `${slug}.next-${id}`;')).toEqual([1]);
    expect(rulesOf(OUTSIDE, 'const p = `${slug}.discard-${id}`;')).toEqual([1]);
    expect(rulesOf(OUTSIDE, 'const p = `${slug}.previous.${ext}`;')).toEqual([1]);
    expect(rulesOf(OUTSIDE, "const p = join(dir, slug + '.x', '.peaks.json');")).toEqual([1]);
  });

  it('rule 1: an unrelated template, prose and a string are not reported', () => {
    expect(scanTakePaths(OUTSIDE, 'const p = `${slug}.txt`;')).toEqual([]);
    expect(scanTakePaths(OUTSIDE, '// `${slug}.segments.json` in a comment')).toEqual([]);
    expect(scanTakePaths(OUTSIDE, "const s = '.segments.json';")).toEqual([]);
  });

  it('rule 2: rm(`${slug}.peaks.json`) is reported (once: the call argument and its template collapse)', () => {
    expect(rulesOf(OUTSIDE, 'await rm(`${slug}.peaks.json`);')).toEqual([1]);
    // ...and the same-function const form is rule 2.
    const src = 'async function f(slug) { const q = `${slug}.peaks.json`; await rm(q); }';
    expect(rulesOf(OUTSIDE, src).sort()).toEqual([1, 2]);
  });

  it('rule 3, B8 plant 1: rename(t, p) where p = join(audioDir(...), `${slug}.${ext}`) is reported (rename\'s SECOND argument)', () => {
    const src = [
      'async function f(bookDir, slug, ext, t) {',
      '  const audioRoot = audioDir(bookDir);',
      '  const p = join(audioRoot, `${slug}.${ext}`);',
      '  await rename(t, p);',
      '}',
    ].join('\n');
    const hits = scanTakePaths(OUTSIDE, src);
    expect(hits.some((h) => h.rule === 3 && h.text === 'p'), JSON.stringify(hits)).toBe(true);
  });

  it('rule 3, B8 plant 2: writeFile(tmp, buf) where tmp = `${p}.tmp-${pid}` and p is tracked is reported', () => {
    const src = [
      'async function f(bookDir, slug, pid, buf) {',
      '  const audioRoot = audioDir(bookDir);',
      '  const p = join(audioRoot, slug);',
      '  const tmp = `${p}.tmp-${pid}`;',
      '  await writeFile(tmp, buf);',
      '}',
    ].join('\n');
    const hits = scanTakePaths(OUTSIDE, src);
    expect(hits.some((h) => h.rule === 3 && h.text === 'tmp'), JSON.stringify(hits)).toBe(true);
  });

  it('rule 3, B8 plant 3: writeChapterPeaksFile(pcm, sr, p) with p tracked is reported (argument 2)', () => {
    const src = [
      'async function f(bookDir, slug, pcm, sr) {',
      '  const audioRoot = audioDir(bookDir);',
      '  const p = join(audioRoot, slug);',
      '  await writeChapterPeaksFile(pcm, sr, p);',
      '}',
    ].join('\n');
    const hits = scanTakePaths(OUTSIDE, src);
    expect(hits.some((h) => h.rule === 3 && h.text === 'p'), JSON.stringify(hits)).toBe(true);
  });

  it('rule 3: writeChapterLufsFile (argument 1), a member call and a Sync variant are reported', () => {
    const lufs = 'async function f(b, s, j) { const r = audioDir(b); await writeChapterLufsFile(j, join(r, s)); }';
    expect(rulesOf(OUTSIDE, lufs)).toEqual([3]);
    const member = 'async function f(b, s) { const r = audioDir(b); await fsp.rm(join(r, s)); }';
    expect(rulesOf(OUTSIDE, member)).toEqual([3]);
    const sync = 'function f(b, s) { const r = audioDir(b); unlinkSync(join(r, s)); }';
    expect(rulesOf(OUTSIDE, sync)).toEqual([3]);
  });

  it('rule 3: a read of a tracked path (existsSync, readFile) is not a mutation and is not reported', () => {
    const src = 'async function f(b, s) { const r = audioDir(b); await readFile(join(r, s)); existsSync(join(r, s)); }';
    expect(scanTakePaths(OUTSIDE, src)).toEqual([]);
  });

  it('rule 3: open() counts only with a write flag', () => {
    const w = "async function f(b, s) { const r = audioDir(b); await open(join(r, s), 'w'); }";
    const rd = "async function f(b, s) { const r = audioDir(b); await open(join(r, s), 'r'); }";
    expect(rulesOf(OUTSIDE, w)).toEqual([3]);
    expect(rulesOf(OUTSIDE, rd)).toEqual([]);
  });

  it('PINNED BLIND SPOT: the plant-1 shape with audioRoot as a function PARAMETER is NOT reported. If a later improvement starts catching it, flip this pin and update the FALSE NEGATIVES header.', () => {
    const src = [
      'async function f(audioRoot, slug, ext, t) {',
      '  const p = join(audioRoot, `${slug}.${ext}`);',
      '  await rename(t, p);',
      '}',
    ].join('\n');
    expect(scanTakePaths(OUTSIDE, src)).toEqual([]);
  });

  it('the module exemption: the same plant in workspace/chapter-take.ts and workspace/take-fields.ts is NOT reported', () => {
    const src = [
      'async function f(bookDir, slug, ext, t) {',
      '  const audioRoot = audioDir(bookDir);',
      '  const p = join(audioRoot, `${slug}.${ext}`);',
      '  await rename(t, p);',
      '  const q = `${slug}.segments.json`;',
      '}',
    ].join('\n');
    expect(scanTakePaths('workspace/chapter-take.ts', src)).toEqual([]);
    expect(scanTakePaths('workspace/take-fields.ts', src)).toEqual([]);
    expect(scanTakePaths(OUTSIDE, src).length).toBeGreaterThan(0);
  });
});
