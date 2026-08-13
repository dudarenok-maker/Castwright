#!/usr/bin/env -S npx tsx
/*
 * repair-missing-book-language.mts
 *
 * Backfill for #2246 scope item 2. Seven pre-fs-2 books (the whole "Keeper of
 * the Lost Cities" series, measured 2026-08-11) have NO `language` key in
 * their `.audiobook/state.json` at all — they predate the field. Downstream,
 * absent and explicit `'en'` are INDISTINGUISHABLE today:
 * `bookStateLanguage` (server/src/workspace/scan.ts) resolves a missing key
 * to `'en'` via `normaliseBookLanguage` (server/src/tts/language.ts), the
 * same default the analyzer resolves language through. So a language-less
 * book has always been analysed as English — harmless while the book
 * genuinely is English, silent mis-narration the moment it isn't — and
 * nothing in the product can tell the two states apart or correct either
 * one.
 *
 * This script finds every book with a missing `language` key, builds a
 * PER-CHAPTER sample, and calls the REAL `detectManuscriptLanguageFromChapters`
 * (server/src/tts/detect-language.ts, #2263) — no re-implementation, so the
 * backfilled value is exactly what live per-chapter detection would decide
 * today (the same function POST /api/import now calls).
 *
 * #2263 round — rewritten from a single flat-text sample to chapter-aware
 * sampling, mirroring the fix that landed for live import: a flat sample
 * (whole book, or the front-matter-stripped prefix used before this round)
 * lets front matter or a partial/resumed analysis cache outvote the real
 * body; voting per chapter — with front-matter chapters and chapters
 * already marked `excluded` in state.json dropped from the vote — doesn't
 * have that failure mode. See detect-language.ts's own header for the full
 * mechanism and the corpus numbers behind the majority threshold.
 *
 * The load-bearing rule (unchanged by this round, do not soften it): it
 * writes ONLY when detection genuinely decided AND had enough to decide
 * from. `fallback: false` alone is NOT proof of confidence — franc has no
 * confidence floor above its own `minLength: 30`, so a short,
 * unrepresentative sample (a table of contents, a run of OCR noise) can
 * return a fluent, WRONG, non-fallback language (#2246 C1: a genuinely
 * English table of contents mis-detects as 'es' with `fallback: false`).
 * Round 1's fix required a SECOND independent sample to agree before
 * writing; round 2 proved that fix unusable in practice — `loadAnalysisCache`
 * resolves `CACHE_DIR` from its own module `__dirname`
 * (server/src/store/analysis-cache.ts), i.e. PER CHECKOUT, so every worktree
 * but the primary one reports zero cache hits and the two-source gate
 * silently no-ops (`0 written, N skipped (single source only)`, exit 0) —
 * on exactly the box this project's own branching workflow mandates running
 * scripts from. Round 2 reverted to a single sample gated on a PROSE-SIGNAL
 * FLOOR instead (a non-fallback detection trusted only once the sample
 * clears `PROSE_UNIT_FLOOR` sentence-terminal-punctuated units); this round
 * keeps that floor, applied to the WINNING language's own combined prose
 * units regardless of how many chapters contributed to it (see
 * `detectManuscriptLanguageFromChapters`'s own comment, and
 * `server/src/tts/prose-units.ts` for the shared constants/helpers it and
 * this script both import — since #2256, two more floors live there
 * alongside it). Any of: no readable text, a surrendered (fallback)
 * detection, a too-thin sample, or (since #2256) a too-repetitive or
 * too-numbered one is a skip, reported with a reason naming which.
 * Skipping is fully recoverable; writing a wrong language is what this
 * script exists to prevent.
 *
 * Text sample preference, per book (unchanged by this round — now a set of
 * chapters rather than one flat string):
 *   1. The book's analysis cache, one sample per non-excluded chapter id
 *      (server/handoff/cache/<manuscriptId>.json) — the same text real
 *      analysis already produced.
 *   2. No cache → the book's own manuscript file, re-parsed the same way
 *      POST /:bookId/reparse does (server/src/parsers, real parseManuscript),
 *      chapters the user already excluded dropped the same way.
 *   3. Neither readable → skip and name the book in the report. Never guess
 *      with no material to look at.
 *
 * #2256 (closed except for one named, tracked shape — see #2341 at the end
 * of this note) — the prose-unit floor alone rejected the three original
 * evidenced junk classes (a TOC-only sample, a nav-only EPUB stub, an
 * OCR-noise sample — all measured at 1 prose unit, 20x under the floor) but
 * not a *punctuated* one: a long numbered TOC or a periods-and-page-numbers
 * index racks up enough terminators to clear the floor on entry count
 * alone, and a median-prose-unit-LENGTH secondary test can't separate that
 * from a real CJK book — a repeated numbered TOC ("1. Prologue. 2. Kaz.")
 * and a real CJK book can sit at the same median letters-per-unit, because a
 * CJK sentence really is that short in letters. Two LEXICAL floors close it
 * instead (`server/src/tts/prose-units.ts`): `LEXICAL_RICHNESS_FLOOR`
 * (Guiraud's R — a punctuated junk list repeats a tiny vocabulary; real
 * prose, short-clause CJK included, keeps introducing new words) and
 * `DIGIT_TOKEN_SHARE_CEILING` (a numbered list needs its numbers; real
 * narrative prose is not digit-dense). Both apply to the same winning-
 * language sample the prose-unit floor already checks, chapter-count-
 * invariant the same way — and, since #2256 round 4, chapter-ORDER-
 * invariant too: both this script and the detector build that sample via
 * prose-units.ts's `joinSamplesForGates`, which closes each chapter's
 * sample at a sentence terminator so the dedup step cannot glue one
 * chapter's trailing text onto the next one's first sentence. See
 * prose-units.ts's own header for the corpus both were measured against,
 * the margins on each side, and the one real Chinese chapter-heading
 * layout (`第N章<title>`) that still clears both gates, tracked as #2341.
 *
 * Write path: `writeStateJsonAtomic` (server/src/workspace/state-migrate.ts)
 * — the same schema-stamp + rotating-backup helper every other state.json
 * write site uses. Every other field is preserved via spread; nothing here
 * ever reconstructs the object.
 *
 * DRY RUN BY DEFAULT — prints the planned writes and exits without touching
 * disk. Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/repair-missing-book-language.mts            # dry run
 *   npx tsx scripts/repair-missing-book-language.mts --apply    # write
 *   npm run repair:book-language                                # dry run
 *   npm run repair:book-language -- --apply
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

import {
  detectManuscriptLanguage,
  detectManuscriptLanguageFromChapters,
  selectBodyChapters,
  prepareSample,
} from '../server/src/tts/detect-language.js';
import { countWords } from '../server/src/parsers/front-matter.js';
import {
  countProseUnits,
  PROSE_UNIT_FLOOR,
  guiraudR,
  LEXICAL_RICHNESS_FLOOR,
  digitTokenShare,
  DIGIT_TOKEN_SHARE_CEILING,
  joinSamplesForGates,
} from '../server/src/tts/prose-units.js';
import { loadAnalysisCache } from '../server/src/store/analysis-cache.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from '../server/src/workspace/state-migrate.js';
import { parseManuscript } from '../server/src/parsers/index.js';
import type { BookStateJson } from '../server/src/workspace/scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER_ROOT = join(REPO_ROOT, 'server');

// ---------------------------------------------------------------------------
// Pure decision logic — exported for unit tests. No I/O in here at all: the
// real detectManuscriptLanguageFromChapters is pure (chapters in,
// DetectionResult out), so this whole decision can be unit-tested with
// plain chapter fixtures.
// ---------------------------------------------------------------------------

export type SampleSource = 'analysis-cache' | 'manuscript';

/** One chapter's worth of sample text for detection — the shape
 *  `detectManuscriptLanguageFromChapters` takes, plus the chapter `id` for
 *  callers that need to trace a sample back to its cache/state entry
 *  (detection itself never reads `id`). */
export interface ChapterSample {
  id: number;
  title: string;
  body: string;
}

export type BookLanguagePlan =
  | { bookId: string; action: 'has-language'; existingLanguage?: string }
  | { bookId: string; action: 'skip-no-text'; reason: string }
  | { bookId: string; action: 'skip-fallback'; language: string; sampleSource: SampleSource; reason: string }
  | { bookId: string; action: 'backfill'; language: string; sampleSource: SampleSource };

interface MassEntry {
  language: string;
  mass: number;
}

/* Percentage labels for a mass breakdown. Largest-remainder rounded so the
   printed shares always sum to exactly 100 — a plain per-language
   Math.round can print e.g. a three-way 33.3/33.3/33.3 tie as "33% / 33% /
   33%", which sums to 99, not 100 — and so a genuinely nonzero mass never
   prints as "0%", which a plain per-language Math.round does for any share
   under half a percentage point. */
function shareLabel(entries: MassEntry[], totalMass: number): string {
  const withFloor = entries.map((e) => {
    const exact = totalMass > 0 ? (e.mass / totalMass) * 100 : 0;
    return { ...e, exact, pct: Math.floor(exact) };
  });
  let remaining = 100 - withFloor.reduce((sum, e) => sum + e.pct, 0);
  const byRemainder = [...withFloor].sort((a, b) => (b.exact - b.pct) - (a.exact - a.pct));
  for (let i = 0; i < byRemainder.length && remaining > 0; i++, remaining--) byRemainder[i].pct += 1;

  // A nonzero mass should never read 0% even when its true share rounds
  // down to it — steal one point from the current largest share instead of
  // leaving a real contributor invisible.
  for (const e of withFloor) {
    if (e.mass > 0 && e.pct === 0) {
      const donor = [...withFloor].filter((x) => x !== e).sort((a, b) => b.pct - a.pct)[0];
      if (donor && donor.pct > 1) {
        donor.pct -= 1;
        e.pct = 1;
      }
    }
  }

  return withFloor
    .sort((a, b) => b.mass - a.mass)
    .map((e) => `${e.language} ${e.mass.toLocaleString('en-US')} words (${e.pct}%)`)
    .join(' / ');
}

export type SurrenderDiagnostic =
  | { kind: 'no-majority'; split: string }
  | { kind: 'too-thin'; language: string; split: string; units: number; floor: number }
  | { kind: 'too-repetitive'; language: string; split: string; richness: number; floor: number }
  | { kind: 'too-numbered'; language: string; split: string; digitShare: number; ceiling: number };

/* Diagnostic-only: replays the SAME body-chapter selection and MASS-weighted
   vote detectManuscriptLanguageFromChapters applies internally — reusing its
   own exported selectBodyChapters and detectManuscriptLanguage, never a
   second classifier — purely to explain a 'skip-fallback' reason after the
   fact. The accept/reject DECISION always comes from
   detectManuscriptLanguageFromChapters itself; this can never disagree with
   it — at worst it returns null (nothing to report) and the reason falls
   back to a generic surrender message.

   Every surrender used to be reported here as "no clear majority" — including
   one where a language won outright (a strict majority of the non-surrendered
   mass) and the ONLY reason detectManuscriptLanguageFromChapters still
   surrendered was that winning language's own combined prose-unit count
   sitting under PROSE_UNIT_FLOOR: self-contradictory output, e.g. "no clear
   majority ... (de 720 words (100%))". This now branches on the SAME share
   the real vote decides on: a winner over the strict-majority line (> 0.5)
   can only have surrendered via the floor, so that case is reported as too
   thin — naming the winning language's own prose-unit count and the floor —
   never as a majority problem.

   #2256 — a winner that clears PROSE_UNIT_FLOOR can still surrender on
   either of the two junk-gate floors voteLanguage applies next (see
   detect-language.ts's own comment): lexical richness (a small repeated
   vocabulary — 'too-repetitive') or digit-token share (a numbered list —
   'too-numbered'). Checked in the SAME order voteLanguage applies them, on
   the SAME (unwindowed) sample — round-3's independent review (finding C3)
   found this guarantee broken WHILE THE BRANCH WAS IN REVIEW, never in a
   release: an unmerged round-2 revision had voteLanguage computing its two
   lexical gates over a RICHNESS_SAMPLE_CHARS-truncated prefix while this
   function kept computing over the full join, so a real surrender could
   have been attributed to the wrong gate (or missed entirely) here. Round 3
   retracted that windowing fix outright (see prose-units.ts's own
   finding-3(a) retraction) rather than threading the same cap through both
   call sites; round 4 (finding B1) then moved the join itself behind the
   shared `joinSamplesForGates`, so the two sites no longer even spell the
   sample construction independently — that is what makes this comment's
   guarantee hold by construction rather than by two matching literals. */
function describeSurrenderReason(
  chapters: ChapterSample[],
  meta: { author?: string | null; title?: string | null },
): SurrenderDiagnostic | null {
  const bodyChapters = selectBodyChapters(chapters);
  const candidates = bodyChapters.length > 0 ? bodyChapters : chapters;
  if (candidates.length === 0) return null;
  // A single candidate is just the n=1 case of the same vote (see
  // detectManuscriptLanguageFromChapters's own comment in detect-language.ts):
  // its whole mass "wins" unanimously below, so the too-thin branch applies
  // to it exactly as it does to any other winner.

  const ballots = candidates.map((c) => ({ chapter: c, detection: detectManuscriptLanguage(c.body, meta) }));
  const nonSurrendered = ballots.filter((b) => !b.detection.fallback);
  if (nonSurrendered.length === 0) return null;

  const massByLanguage = new Map<string, number>();
  let totalMass = 0;
  for (const { chapter, detection } of nonSurrendered) {
    const mass = countWords(chapter.body);
    massByLanguage.set(detection.language, (massByLanguage.get(detection.language) ?? 0) + mass);
    totalMass += mass;
  }
  if (massByLanguage.size === 0 || totalMass === 0) return null;

  const entries: MassEntry[] = [...massByLanguage.entries()].map(([language, mass]) => ({ language, mass }));
  const split = shareLabel(entries, totalMass);

  let winner: string | null = null;
  let winnerMass = 0;
  for (const { language, mass } of entries) {
    if (mass > winnerMass) {
      winner = language;
      winnerMass = mass;
    }
  }
  if (!winner || winnerMass / totalMass <= 0.5) return { kind: 'no-majority', split };

  const winningSamples = nonSurrendered
    .filter((b) => b.detection.language === winner)
    .map((b) => prepareSample(b.chapter.body, meta));
  const winningUnits = winningSamples.reduce((sum, s) => sum + countProseUnits(s), 0);
  if (winningUnits < PROSE_UNIT_FLOOR) {
    return { kind: 'too-thin', language: winner, split, units: winningUnits, floor: PROSE_UNIT_FLOOR };
  }

  const winningSample = joinSamplesForGates(winningSamples);
  const richness = guiraudR(winningSample);
  if (richness < LEXICAL_RICHNESS_FLOOR) {
    return { kind: 'too-repetitive', language: winner, split, richness, floor: LEXICAL_RICHNESS_FLOOR };
  }
  const digitShare = digitTokenShare(winningSample);
  if (digitShare > DIGIT_TOKEN_SHARE_CEILING) {
    return { kind: 'too-numbered', language: winner, split, digitShare, ceiling: DIGIT_TOKEN_SHARE_CEILING };
  }
  return null;
}

/* Chapter-aware (#2263): one sample source only (analysis cache preferred,
   else a manuscript re-parse — same preference order as before), but the
   sample is now that source's CHAPTERS, not one flattened string. Both
   sources have already dropped chapters marked `excluded` in state.json —
   see cacheChaptersFor / manuscriptChaptersFor below.
   detectManuscriptLanguageFromChapters applies its OWN front-matter/
   word-count selection and majority vote on top of that; a surrender (no
   majority, or too little to corroborate) is never written — `fallback:
   false` is not proof of confidence on its own, see the file header. */
export function planBookLanguage(input: {
  bookId: string;
  hasLanguageKey: boolean;
  existingLanguage?: string;
  cacheChapters: ChapterSample[] | null;
  manuscriptChapters: ChapterSample[] | null;
  meta?: { author?: string | null; title?: string | null };
}): BookLanguagePlan {
  const { bookId, hasLanguageKey, existingLanguage, cacheChapters, manuscriptChapters, meta = {} } = input;

  if (hasLanguageKey) {
    return { bookId, action: 'has-language', existingLanguage };
  }

  const hasCache = !!(cacheChapters && cacheChapters.length > 0);
  const hasManuscript = !!(manuscriptChapters && manuscriptChapters.length > 0);

  if (!hasCache && !hasManuscript) {
    return {
      bookId,
      action: 'skip-no-text',
      reason: 'no analysis-cache sentence text and no readable manuscript file',
    };
  }

  const sample: { chapters: ChapterSample[]; source: SampleSource } = hasCache
    ? { chapters: cacheChapters as ChapterSample[], source: 'analysis-cache' }
    : { chapters: manuscriptChapters as ChapterSample[], source: 'manuscript' };

  const detection = detectManuscriptLanguageFromChapters(sample.chapters, meta);

  if (detection.fallback) {
    const diag = describeSurrenderReason(sample.chapters, meta);
    const reason =
      diag?.kind === 'no-majority'
        ? `no clear majority across ${sample.source} body chapters (${diag.split}) — a guess is never written`
        : diag?.kind === 'too-thin'
          ? `${diag.language} won a clear majority across ${sample.source} body chapters (${diag.split}), but ` +
            `only ${diag.units} prose unit(s) — under the ${diag.floor}-unit floor — so the sample is too thin ` +
            'to trust; a guess is never written'
          : diag?.kind === 'too-repetitive'
            ? `${diag.language} won a clear majority across ${sample.source} body chapters (${diag.split}), but ` +
              `its vocabulary is too repetitive to trust as prose (Guiraud's R ${diag.richness.toFixed(2)} — ` +
              `under the ${diag.floor} floor, e.g. a numbered list or a repeated heading); a guess is never written`
            : diag?.kind === 'too-numbered'
              ? `${diag.language} won a clear majority across ${sample.source} body chapters (${diag.split}), but ` +
                `${(diag.digitShare * 100).toFixed(0)}% of its tokens carry a digit — over the ` +
                `${(diag.ceiling * 100).toFixed(0)}% ceiling, the shape of a table of contents or an index, not ` +
                'prose; a guess is never written'
              : `detection surrendered (confidence-floor guess '${detection.language}') from ${sample.source} ` +
                'chapters — a guess is never written';
    return {
      bookId,
      action: 'skip-fallback',
      language: detection.language,
      sampleSource: sample.source,
      reason,
    };
  }

  return { bookId, action: 'backfill', language: detection.language, sampleSource: sample.source };
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

/** Read server/.env the way the server's own load-env.ts does
 *  (`process.loadEnvFile`), but by absolute path — load-env.ts relies on
 *  process.cwd() being `server/`, which isn't true when this script is
 *  invoked from the repo root. Seeds the SAME env var
 *  (`server/src/workspace/paths.ts` reads WORKSPACE_DIR) so that module's
 *  own resolution algorithm — not a copy of it — produces the real answer. */
function loadServerDotEnv(): void {
  const envPath = join(SERVER_ROOT, '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Fallback KEY=VALUE parse for a Node < 20.6 host (loadEnvFile is newer).
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}

/** Every directory under `root` that IS a book — i.e. contains an
 *  `.audiobook/state.json`. Generic recursive descent (books nest by
 *  author/series, but this doesn't assume a fixed depth) rather than a
 *  hardcoded 3-level walk. Never descends into `.audiobook` itself or into
 *  `.upgrade-backups` (per-upgrade snapshot copies of state.json living
 *  outside any book folder — see server/src/workspace/upgrade-coordinator.ts
 *  — which must never be mistaken for a live book). */
function findAudiobookDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.upgrade-backups') continue;
      const child = join(dir, e.name);
      if (e.name === '.audiobook') {
        if (existsSync(join(child, 'state.json'))) found.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** One ChapterSample per non-excluded analysis-cache chapter (#2263 — was
 *  cacheSampleText, a single flattened string across every chapter). The
 *  cache is keyed by chapter id, and per server/src/store/manuscripts.ts
 *  that id IS the same `state.chapters[].id` — so a chapter's title (for
 *  the front-matter selection) and its `excluded` flag both come from the
 *  matching `state.chapters[]` entry, matched by id. Returns null when
 *  there's no cache (the common case for a language-less book — the
 *  analysis cache is install-relative scratch space, see
 *  server/src/export/manuscript-sentences.ts), the cache is empty/corrupt,
 *  or every chapter is excluded/empty — either way this never throws, it's
 *  just the preferred sample when it exists. */
export async function cacheChaptersFor(
  manuscriptId: string,
  stateChapters: BookStateJson['chapters'],
): Promise<ChapterSample[] | null> {
  try {
    const cache = await loadAnalysisCache(manuscriptId);
    const excludedIds = new Set<number>(stateChapters.filter((c) => c.excluded).map((c) => c.id));
    const titleById = new Map<number, string>(stateChapters.map((c) => [c.id, c.title]));

    const chapters: ChapterSample[] = [];
    for (const [idStr, sentences] of Object.entries(cache.chapters ?? {})) {
      const id = Number(idStr);
      if (excludedIds.has(id)) continue;
      // '\n', not ' ' — detectManuscriptLanguage runs stripFrontMatterBoilerplate
      // first, which is LINE-based and drops any line matching an unanchored
      // global-boilerplate pattern. Joining a chapter's sentences onto one
      // line means a single boilerplate match (a stray copyright/e-library
      // notice sentence mid-chapter) wipes that WHOLE chapter's sample, not
      // just the one sentence.
      const body = (sentences ?? [])
        .map((s) => s.text)
        .join('\n')
        .trim();
      if (!body) continue;
      chapters.push({ id, title: titleById.get(id) ?? '', body });
    }
    return chapters.length > 0 ? chapters : null;
  } catch {
    return null;
  }
}

/** Re-parse the book's own manuscript file on disk (same parseManuscript the
 *  reparse route uses) into ChapterSamples, dropping chapters already marked
 *  `excluded` in state.json (same id match as cacheChaptersFor). Null when
 *  the book has no manuscript file, it's missing on disk, it fails to
 *  parse, or every chapter is excluded/empty — never throws, so a bad file
 *  just falls through to "no text" rather than aborting the whole run. */
async function manuscriptChaptersFor(bookDir: string, state: BookStateJson): Promise<ChapterSample[] | null> {
  if (!state.manuscriptFile) return null;
  const manuscriptPath = join(bookDir, state.manuscriptFile);
  if (!existsSync(manuscriptPath)) return null;
  try {
    const buffer = readFileSync(manuscriptPath);
    const parsed = await parseManuscript({
      buffer,
      fileName: state.manuscriptFile,
      sourcePath: manuscriptPath,
    });
    const excludedIds = new Set<number>((state.chapters ?? []).filter((c) => c.excluded).map((c) => c.id));
    const chapters: ChapterSample[] = parsed.chapters
      .filter((c) => !excludedIds.has(c.id) && c.body && c.body.trim().length > 0)
      .map((c) => ({ id: c.id, title: c.title, body: c.body }));
    return chapters.length > 0 ? chapters : null;
  } catch {
    return null;
  }
}

/**
 * @param argv                — process.argv slice (flags only; pass [] for defaults)
 * @param booksRootOverride   — override the resolved BOOKS_ROOT (used in tests)
 */
export async function main(argv: string[] = process.argv.slice(2), booksRootOverride?: string): Promise<void> {
  const APPLY = argv.includes('--apply');

  loadServerDotEnv();
  const { BOOKS_ROOT, stateJsonPath } = await import('../server/src/workspace/paths.js');
  const booksRoot = booksRootOverride ?? BOOKS_ROOT;

  if (!existsSync(booksRoot)) {
    console.error(`No books root at ${booksRoot}. Set WORKSPACE_DIR (server/.env) to your workspace.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — workspace books: ${booksRoot}\n`);

  const audiobookDirs = findAudiobookDirs(booksRoot);

  let alreadyHad = 0;
  let backfillPlanned = 0;
  let backfillWritten = 0;
  let skippedNoText = 0;
  let skippedFallback = 0;
  let unreadable = 0;

  for (const audiobookDir of audiobookDirs) {
    const bookDir = dirname(audiobookDir);
    const bookLabel = relative(booksRoot, bookDir);
    const statePath = stateJsonPath(bookDir);
    let state: BookStateJson | null;
    try {
      state = await readStateJsonWithRecovery(statePath);
    } catch (err) {
      // readJsonWithRecovery (server/src/workspace/state-io.ts) re-throws the
      // ORIGINAL error for ANY failure class once every rotated backup is
      // also unusable — not just a parse failure. A locked file (Windows AV
      // or OneDrive holding a read handle, or the app server itself holding
      // state.json open) throws EBUSY/EPERM, not SyntaxError, and unlike
      // genuine corruption it's often transient — printing a bare
      // "unreadable" with nothing else looks identical to real corruption
      // and gives the operator nothing to act on. Distinguish the two here:
      // a SyntaxError is the corrupt-JSON case this recovery path exists
      // for; anything else is an I/O failure and is reported as such, with
      // the underlying message, so a locked file is diagnosable on sight
      // instead of silently skipped and never retried. Exit-code behaviour
      // for this path is unchanged — a caught error here still just skips
      // the book, same as before.
      unreadable += 1;
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof SyntaxError ? 'corrupt JSON' : 'read error';
      console.log(`  [${bookLabel}] SKIP — state.json unreadable (${kind}: ${message})`);
      continue;
    }
    if (!state) {
      unreadable += 1;
      console.log(`  [${bookLabel}] SKIP — state.json unreadable (no file)`);
      continue;
    }

    const hasLanguageKey = Object.prototype.hasOwnProperty.call(state, 'language');
    const existingLanguage = (state as BookStateJson & { language?: string }).language;

    // Single sample source only (#2246 round 2, preserved by #2263):
    // analysis-cache chapters preferred, a manuscript re-parse only when
    // there's no cache — never both, so a book with a usable cache never
    // pays for an unnecessary re-parse.
    let cacheChapters: ChapterSample[] | null = null;
    let manuscriptChapters: ChapterSample[] | null = null;
    if (!hasLanguageKey) {
      cacheChapters = state.manuscriptId
        ? await cacheChaptersFor(state.manuscriptId, state.chapters ?? [])
        : null;
      if (!cacheChapters) manuscriptChapters = await manuscriptChaptersFor(bookDir, state);
    }

    const plan = planBookLanguage({
      bookId: state.bookId ?? bookLabel,
      hasLanguageKey,
      existingLanguage,
      cacheChapters,
      manuscriptChapters,
      meta: { author: state.author, title: state.title },
    });

    switch (plan.action) {
      case 'has-language':
        alreadyHad += 1;
        console.log(`  [${bookLabel}] already has language '${plan.existingLanguage}' — skipped`);
        break;
      case 'skip-no-text':
        skippedNoText += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'skip-fallback':
        skippedFallback += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'backfill':
        backfillPlanned += 1;
        console.log(
          `  [${bookLabel}] ${APPLY ? 'Writing' : 'Would write'} language → '${plan.language}'  ` +
            `(source: ${plan.sampleSource})`,
        );
        if (APPLY) {
          await writeStateJsonAtomic(statePath, { ...state, language: plan.language });
          backfillWritten += 1;
        }
        break;
    }
  }

  console.log(
    `\n${audiobookDirs.length} book(s) scanned — ${alreadyHad} already had a language, ` +
      `${APPLY ? backfillWritten : backfillPlanned} ${APPLY ? 'written' : 'would be written'}, ` +
      `${skippedNoText} skipped (no text), ${skippedFallback} skipped (detection surrendered)` +
      `${unreadable > 0 ? `, ${unreadable} skipped (state.json unreadable)` : ''}.`,
  );
  if (!APPLY && backfillPlanned > 0) console.log('Re-run with --apply to write.');
}

// Run when executed directly (not imported in tests).
if (isDirectlyInvoked(import.meta.url)) {
  main();
}
