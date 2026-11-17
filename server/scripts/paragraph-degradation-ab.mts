/* #2254 runner, capture half (spec docs/superpowers/specs/2026-11-13-paragraph-
   degradation-signal-design.md §4.3 "The #2254 runner", R6-5, R7-9, R7-10, owner
   decision 20, R10-6).

   paragraph-degradation-ab.mts --manifest <file.json> --model <name> --scratch <dir>
                                [--language ru] [--resume]

   The manifest is `[{ chapterId, chapterTextPath, rosterPath }]`. Chapters are
   captured ONE AT A TIME, live, through captureChapterStages. Each capture is
   written to <scratch>/capture-ch<id>.json the moment it returns, BEFORE anything
   measures it (R6-5). One analyzer model runs every capture: any saved capture
   under a different model refuses the run and writes nothing (owner decision 20,
   R10-6). `--resume` keeps every saved chapter, restores the shared structure
   budget from the most recent saved capture and captures only the rest (R7-10).

   Phase 7b step 3 (§4.4 step 2, owner decisions 16, 18-20, 22, 23; R8-2, R9-2,
   R10-2, R10-3): the run WALKS the manifest in descending hidden-turn order
   (countTurnOpeners, ties by chapter id), capturing as it goes. A chapter below
   the 80% floor is swapped for the next candidate; the walk ends at three clear
   chapters or after two swaps. <scratch>/pick.json records every chapter's
   status and the outcome (three / fewer-than-three: N / not-computed /
   stopped-for-owner). --recapture <ids> --reason <t> supersedes those captures
   and re-walks from the head with the cap reset, reusing every kept capture;
   --reroll --reason <t> (once, only after not-computed) supersedes them all and
   captures afresh.

   Harness vs production (§4.3): capacity comes from resolveCapacity for the
   owner's real engine ('local' for Ollama); --model is required, with no default;
   ONE structureBudget, seeded from analyzer.structure.maxWindowsPerBook, is shared
   across the book's chapters. Chapter text is read as-is (AC5 M-8). */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureChapterStages, type CapturedChapter } from '../src/analyzer/attribution-eval/run-eval.js';
import { buildRosterSnapshot } from '../src/analyzer/attribution-eval/capture.js';
import type { RosterSnapshot } from '../src/analyzer/attribution-eval/roster-schema.js';
import { OllamaAnalyzer } from '../src/analyzer/ollama.js';
import type { Analyzer, StageCall } from '../src/analyzer/index.js';
import { countTurnOpeners } from '../src/analyzer/dialogue-structure/legibility.js';
import { resolveCapacity } from '../src/analyzer/capacity.js';
import { configValue } from '../src/config/resolver.js';

export const USAGE =
  'usage: paragraph-degradation-ab.mts --manifest <file.json> --model <name> --scratch <dir> [--language ru] [--resume | --recapture <ids> --reason <text> | --reroll --reason <text>]\n';

export interface ManifestEntry {
  chapterId: number;
  chapterTextPath: string;
  rosterPath: string;
}

/** What a capture file holds: every captureChapterStages field plus the run's own. */
export type SavedCapture = CapturedChapter & {
  chapterId: number;
  model: string;
  remainingWindows: number;
  capturedAt: string;
  round: number;
  wallClockMs: number;
};

export interface RunnerDeps {
  /** The analyzer factory; tests pass a mock. */
  makeAnalyzer: (o: { url: string; model: string }) => Analyzer;
  /** The live capture; tests may wrap it to observe the budget it is given. */
  capture: typeof captureChapterStages;
  /** Runs after a chapter's file is on disk and before the next chapter (measurement goes here). */
  afterCapture?: (saved: SavedCapture, file: string) => void | Promise<void>;
  log: (line: string) => void;
}

export function defaultDeps(): RunnerDeps {
  return {
    makeAnalyzer: (o) => new OllamaAnalyzer(o),
    capture: captureChapterStages,
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

export interface CaptureRunOptions {
  manifest: ManifestEntry[];
  model: string;
  scratch: string;
  language?: string;
  resume?: boolean;
  /** Chapter ids whose current captures are superseded before the pick is re-walked. */
  recapture?: number[];
  /** Supersede every current capture and re-walk, capturing afresh (once per scratch dir). */
  reroll?: boolean;
  /** The cause recorded for a --recapture or --reroll. */
  reason?: string;
}

export const captureFileName = (chapterId: number): string => `capture-ch${chapterId}.json`;
export const supersededFileName = (chapterId: number, round: number): string =>
  `capture-ch${chapterId}.superseded-r${round}.json`;
export const PICK_FILE = 'pick.json';

/** Spec §4.4 step 2: three clear chapters, at most two swaps (R8-2). */
export const PICK_SIZE = 3;
export const MAX_SWAPS = 2;

export type ChapterStatus = 'picked' | 'swapped-out' | 'captured-not-used' | 'not-captured';
export type PickOutcome = 'three' | `fewer-than-three: ${number}` | 'not-computed' | 'stopped-for-owner';

export interface ChapterPickRecord {
  hiddenTurns: number;
  dashParagraphs: number;
  alignedPct: number | null;
  flagOnly: boolean | null;
  status: ChapterStatus;
}
export interface SupersededRecord {
  chapterId: number;
  /** The round the superseded capture was made in. */
  round: number;
  file: string;
  /** The round whose re-capture or re-roll replaced it. */
  supersededInRound: number;
}
export interface RoundRecord {
  round: number;
  kind: 'initial' | 'recapture' | 'reroll';
  cause: string | null;
  model: string;
  picked: number[];
  outcome: PickOutcome;
  outcomeReason: string | null;
}
export interface PickFile {
  model: string;
  round: number;
  rerolls: number;
  remainingWindows: number;
  order: number[];
  chapters: Record<string, ChapterPickRecord>;
  superseded: SupersededRecord[];
  rounds: RoundRecord[];
  picked: number[];
  outcome: PickOutcome;
  outcomeReason: string | null;
}

/** Every saved (current) capture in <scratch>, in no particular order. A missing directory holds none. */
export function readSavedCaptures(scratch: string): Array<{ file: string; saved: SavedCapture }> {
  if (!existsSync(scratch)) return [];
  return readdirSync(scratch)
    .filter((f) => /^capture-ch\d+\.json$/.test(f))
    .map((f) => ({ file: f, saved: JSON.parse(readFileSync(join(scratch, f), 'utf8')) as SavedCapture }));
}

export function readPick(scratch: string): PickFile | null {
  const f = join(scratch, PICK_FILE);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as PickFile) : null;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** Writes via a temp name then a rename, so a capture file is never half-written. */
function writeCaptureFile(scratch: string, saved: SavedCapture): string {
  const file = join(scratch, captureFileName(saved.chapterId));
  writeAtomic(file, JSON.stringify(saved, null, 2));
  return file;
}

function rosterFrom(path: string): RosterSnapshot {
  const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const chars = Array.isArray(j) ? j : (j as { characters?: unknown }).characters;
  if (!Array.isArray(chars)) throw new Error(`roster ${path}: expected a characters array`);
  return buildRosterSnapshot(chars as Parameters<typeof buildRosterSnapshot>[0]);
}

const fmtMs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Paragraphs (lines) that open with a dash: the chapter's dash-turn paragraph count. */
export const countDashParagraphs = (body: string): number =>
  body.split('\n').filter((l) => /^\s*[—–-]/u.test(l)).length;

/** Below the 80% alignment floor (flagOnly). A capture with no structure report cannot clear it. */
const belowFloor = (c: CapturedChapter): boolean => (c.structureReport ? c.structureReport.flagOnly : true);

/** Returns the process exit code. Refusals return before anything is written. */
export async function runCapture(opts: CaptureRunOptions, deps: RunnerDeps): Promise<number> {
  const scratch = resolve(opts.scratch);
  const recapture = opts.recapture ?? [];
  const mode: 'initial' | 'recapture' | 'reroll' = opts.reroll ? 'reroll' : recapture.length > 0 ? 'recapture' : 'initial';
  const refuse = (why: string): number => {
    deps.log(`refused: ${why} Nothing was written.`);
    return 1;
  };

  if (opts.reroll && recapture.length > 0) return refuse('--reroll and --recapture are separate runs.');
  if (mode !== 'initial' && !opts.reason?.trim()) return refuse(`--${mode} needs --reason "<text>".`);

  // One model across every capture: checked before any capture, resume or re-capture.
  const existing = readSavedCaptures(scratch);
  const foreign = existing.filter((e) => e.saved.model !== opts.model);
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map((e) => e.saved.model))].join(', ');
    return refuse(`${scratch} holds captures made under model ${names}, not ${opts.model};`);
  }
  if (mode === 'initial' && existing.length > 0 && !opts.resume) {
    return refuse(`${scratch} already holds ${existing.length} capture(s); pass --resume to continue the run.`);
  }

  const prior = readPick(scratch);
  if (mode === 'reroll') {
    if (!prior || (prior.outcome !== 'not-computed' && prior.outcome !== 'stopped-for-owner')) {
      return refuse('--reroll is allowed only when the last settled outcome is not-computed.');
    }
    if (prior.rerolls >= 1) return refuse('a re-roll has already been made in this scratch directory.');
  }
  if (mode === 'recapture') {
    const have = new Set(existing.map((e) => e.saved.chapterId));
    const missing = recapture.filter((id) => !have.has(id));
    if (missing.length > 0) return refuse(`no current capture for chapter(s) ${missing.join(', ')}.`);
  }

  // Candidates in descending hidden-turn count, ties by chapter id (§4.4 step 2, owner decision 18).
  const texts = new Map<number, string>();
  for (const m of opts.manifest) texts.set(m.chapterId, readFileSync(m.chapterTextPath, 'utf8')); // as-is
  const hidden = new Map(opts.manifest.map((m) => [m.chapterId, countTurnOpeners(texts.get(m.chapterId)!)] as const));
  const candidates = [...opts.manifest].sort(
    (a, b) => hidden.get(b.chapterId)! - hidden.get(a.chapterId)! || a.chapterId - b.chapterId,
  );

  // The budget the whole book shares; restored from the newest current capture, else from the last settle.
  const newest = existing.map((e) => e.saved).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1);
  const structureBudget = {
    remainingWindows: newest
      ? newest.remainingWindows
      : (prior?.remainingWindows ?? configValue<number>('analyzer.structure.maxWindowsPerBook')),
  };

  mkdirSync(scratch, { recursive: true });
  const round = mode === 'initial' ? (prior?.round ?? 1) : (prior?.round ?? 1) + 1;
  const superseded: SupersededRecord[] = [...(prior?.superseded ?? [])];
  const current = new Map(existing.map((e) => [e.saved.chapterId, e.saved] as const));

  // A re-capture or a re-roll retires current captures before the walk starts again.
  const retire = mode === 'reroll' ? [...current.keys()] : recapture;
  for (const id of retire) {
    const old = current.get(id)!;
    const file = supersededFileName(id, old.round);
    renameSync(join(scratch, captureFileName(id)), join(scratch, file));
    superseded.push({ chapterId: id, round: old.round, file, supersededInRound: round });
    current.delete(id);
  }

  const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const analyzer = deps.makeAnalyzer({ url, model: opts.model });
  const capacity = resolveCapacity({ engine: 'local', model: opts.model });
  const stageCall = { language: opts.language } as StageCall;

  const status = new Map<number, ChapterStatus>();
  let clear = 0;
  let swaps = 0;
  let msPerChar: number | null = null;
  // The walk restarts from the head with the cap reset; it reuses every kept capture.
  for (let i = 0; i < candidates.length && clear < PICK_SIZE; i++) {
    const m = candidates[i]!;
    let cap = current.get(m.chapterId);
    if (!cap) {
      const chapterText = texts.get(m.chapterId)!;
      const t0 = Date.now();
      const captured = await deps.capture({
        analyzer,
        manuscriptId: `ab-${m.chapterId}`,
        title: `Chapter ${m.chapterId}`,
        chapterId: m.chapterId,
        chapterText,
        roster: rosterFrom(m.rosterPath),
        stageCall,
        capacity,
        structureBudget,
      });
      const wallClockMs = Date.now() - t0;
      const record: SavedCapture = {
        ...captured,
        chapterId: m.chapterId,
        model: opts.model,
        remainingWindows: structureBudget.remainingWindows,
        capturedAt: new Date().toISOString(),
        round,
        wallClockMs,
      };
      const file = writeCaptureFile(scratch, record); // on disk BEFORE anything measures it (R6-5)
      current.set(m.chapterId, record);
      cap = record;
      if (deps.afterCapture) await deps.afterCapture(record, file);

      const sr = captured.structureReport;
      deps.log(
        `ch${m.chapterId}: alignedPct=${sr?.alignedPct ?? 'n/a'} flagOnly=${sr?.flagOnly ?? 'n/a'} wall=${fmtMs(wallClockMs)}`,
      );
      if (msPerChar === null && chapterText.length > 0) {
        msPerChar = wallClockMs / chapterText.length;
        const rest = candidates
          .slice(i + 1)
          .filter((r) => !current.has(r.chapterId))
          .slice(0, PICK_SIZE - clear);
        const restChars = rest.reduce((n, r) => n + texts.get(r.chapterId)!.length, 0);
        if (restChars > 0) {
          deps.log(`estimate for up to ${rest.length} more chapter(s): ~${fmtMs(restChars * msPerChar)}`);
        }
      }
    }
    if (!belowFloor(cap)) {
      status.set(m.chapterId, 'picked');
      clear++;
    } else {
      status.set(m.chapterId, 'swapped-out'); // below the floor: it leaves the pick
      if (swaps >= MAX_SWAPS) break; // no third swap: the walk ends here
      swaps++;
    }
  }

  const picked = candidates.filter((m) => status.get(m.chapterId) === 'picked').map((m) => m.chapterId);
  const rerolls = (prior?.rerolls ?? 0) + (mode === 'reroll' ? 1 : 0);
  let outcome: PickOutcome;
  let outcomeReason: string | null = null;
  if (clear >= PICK_SIZE) outcome = 'three';
  else if (clear > 0) {
    outcome = `fewer-than-three: ${clear}`;
    outcomeReason = `${swaps >= MAX_SWAPS ? 'the two-swap cap was reached' : 'the manifest ran out of candidates'} with ${clear} chapter(s) clear of the alignment floor`;
  } else if (rerolls >= 1) {
    outcome = 'stopped-for-owner';
    outcomeReason =
      'no chapter cleared the alignment floor after the same-model re-roll and no defect was found; stopped for the owner, nothing more captured';
  } else {
    outcome = 'not-computed';
    outcomeReason = 'no chapter taken cleared the alignment floor';
  }

  const chapters: Record<string, ChapterPickRecord> = {};
  for (const m of opts.manifest) {
    const cap = current.get(m.chapterId);
    const sr = cap?.structureReport;
    chapters[String(m.chapterId)] = {
      hiddenTurns: hidden.get(m.chapterId)!,
      dashParagraphs: countDashParagraphs(texts.get(m.chapterId)!),
      alignedPct: sr?.alignedPct ?? null,
      flagOnly: sr?.flagOnly ?? null,
      status: status.get(m.chapterId) ?? (cap ? 'captured-not-used' : 'not-captured'),
    };
  }
  const prevEntry = prior?.rounds.find((r) => r.round === round);
  const entry: RoundRecord = {
    round,
    kind: mode === 'initial' ? (prevEntry?.kind ?? 'initial') : mode,
    cause: mode === 'initial' ? (prevEntry?.cause ?? null) : (opts.reason ?? null),
    model: opts.model,
    picked,
    outcome,
    outcomeReason,
  };
  const pick: PickFile = {
    model: opts.model,
    round,
    rerolls,
    remainingWindows: structureBudget.remainingWindows,
    order: candidates.map((m) => m.chapterId),
    chapters,
    superseded,
    rounds: [...(prior?.rounds ?? []).filter((r) => r.round !== round), entry],
    picked,
    outcome,
    outcomeReason,
  };
  writeAtomic(join(scratch, PICK_FILE), JSON.stringify(pick, null, 2));
  deps.log(`pick (round ${round}): ${picked.map((id) => `ch${id}`).join(', ') || 'none'} -> ${outcome}`);
  return 0;
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[], deps: RunnerDeps = defaultDeps()): Promise<number> {
  const manifestPath = argValue(argv, '--manifest');
  const model = argValue(argv, '--model');
  const scratch = argValue(argv, '--scratch');
  if (!manifestPath || !model || !scratch) {
    process.stderr.write(USAGE);
    return 2;
  }
  const recaptureArg = argValue(argv, '--recapture');
  const recaptureIds = recaptureArg === undefined ? undefined : recaptureArg.split(',').map((x) => Number(x.trim()));
  if (recaptureIds && recaptureIds.some((n) => !Number.isInteger(n))) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as ManifestEntry[];
    return await runCapture(
      {
        manifest,
        model,
        scratch,
        language: argValue(argv, '--language'),
        resume: argv.includes('--resume'),
        recapture: recaptureIds,
        reroll: argv.includes('--reroll'),
        reason: argValue(argv, '--reason'),
      },
      deps,
    );
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
