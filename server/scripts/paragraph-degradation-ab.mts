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

   Phase 7c step 2 (§4.3 "1A engine replay", §4.4 step 2, R4-1, R4-4, R5-6, R7-7, R9-3,
   R10-2): --from-captures --scratch <dir> --manifest <file.json> --language ru measures the
   saved captures with NO model and NO analyzer. Per captured chapter the engine is replayed
   three times over the captured `raw`: control (recovery on, must deep-equal the captured
   `deterministic`, else the chapter's 1A is void), on (the control's output) and off
   (recoverMidParagraphTurns: false). A capture does not store the chapter text, so the
   manifest supplies it (the same string the capture read). Writes report.json / report.md.

   Phase 7c step 3 (§4.3 "The confident-decision report", owner decisions 5, 8, 14; R5-3, R6-4,
   R6-6, R7-8): the engine's confident decisions on turn sentences are counted by class (a)-(d) and
   by reason, with no verdict, and 1A's changed sentences carry the same class. An unknown
   confident reason fails the measurement before anything is written (saved captures untouched).

   Settings: server/.env is loaded as the server does, and the owner's saved user settings are read
   WITHOUT writing (primeUserSettingsCacheReadOnly), so every knob resolves as in production, and the
   analyzer is built on getResolvedOllamaUrl() (env, then the saved Admin override, then the default).
   Each capture saves the effective value of EVERY analyzer.* registry key, the reasoning level, the
   resolved request payload, the capacity and the effective stage-2 chunk budget
   (resolveStage2ChunkCharBudget(capacity), not the configured cap). A re-capture under any difference
   in those is refused like a different --model, and the refusal names the differing keys. A knob that
   is not an analyzer.* key and not the payload or reasoning level is not covered.

   Harness vs production (§4.3): capacity comes from resolveCapacity for the
   owner's real engine ('local' for Ollama); --model is required, with no default;
   ONE structureBudget, seeded from analyzer.structure.maxWindowsPerBook, is shared
   across the book's chapters. Chapter text is read as-is (AC5 M-8). */

import '../src/load-env.js'; // server/.env into process.env before any server module reads it, as src/index.ts does
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureChapterStages, type CapturedChapter } from '../src/analyzer/attribution-eval/run-eval.js';
import { buildRosterSnapshot } from '../src/analyzer/attribution-eval/capture.js';
import type { RosterSnapshot } from '../src/analyzer/attribution-eval/roster-schema.js';
import { OllamaAnalyzer } from '../src/analyzer/ollama.js';
import type { Analyzer, StageCall } from '../src/analyzer/index.js';
import { countTurnOpeners, turnInParagraphRegex, MERGED_TURNS_DEGRADED } from '../src/analyzer/dialogue-structure/legibility.js';
import type { ParagraphEvidence, SpanEvidence } from '../src/analyzer/dialogue-structure/types.js';
import { conventionsFor } from '../src/analyzer/dialogue-structure/lang/index.js';
import { locateSentenceRanges } from '../src/analyzer/dialogue-structure/aligner.js';
import { runStructureEngine } from '../src/routes/analysis.js';
import { resolveCapacity } from '../src/analyzer/capacity.js';
import { configValue } from '../src/config/resolver.js';
import { allKnobs } from '../src/config/registry.js';
import { getResolvedOllamaUrl } from '../src/config/ollama-resolved.js';
import { resolveStage2ChunkCharBudget } from '../src/analyzer/stage2-chunk.js';
import { resolveExtraParamsSetting } from '../src/analyzer/runner/extra-params.js';
import { getCachedUserSettings, primeUserSettingsCacheReadOnly } from '../src/workspace/user-settings.js';
import { resolveReasoningSetting } from '../src/analyzer/reasoning.js';
import type { EngineCapacity } from '../src/analyzer/capacity.js';

export const USAGE =
  'usage: paragraph-degradation-ab.mts --manifest <file.json> --model <name> --scratch <dir> [--language ru] [--resume | --recapture <ids> --reason <text> | --reroll --reason <text>]\n' +
  '       paragraph-degradation-ab.mts --from-captures --manifest <file.json> --scratch <dir> --language ru\n' +
  '       paragraph-degradation-ab.mts --score <filled-sheet.md> --scratch <dir>\n';

export interface ManifestEntry {
  chapterId: number;
  chapterTextPath: string;
  rosterPath: string;
}

/** What the analyzer is sized and run by: the owner's saved settings and .env, as production resolves them. */
export interface EffectiveSettings {
  numCtx: number;
  capacity: EngineCapacity;
  /** What a chapter is actually cut to: resolveStage2ChunkCharBudget(capacity), not the configured cap. */
  effectiveChunkBudget: number;
  escalation: string;
  reasoning: unknown;
  /** The saved request payload (temperature, top_p, ...), merged last into the wire body. */
  payload: unknown;
  /** The effective value of every analyzer.* registry key, as configValue resolves it (url, numGpu, fractions, ...). */
  knobs: Record<string, number | boolean | string>;
}

export function effectiveSettings(model: string): EffectiveSettings {
  const capacity = resolveCapacity({ engine: 'local', model });
  const knobs: EffectiveSettings['knobs'] = {};
  for (const k of allKnobs()) {
    if (k.key.startsWith('analyzer.')) knobs[k.key] = configValue<number | boolean | string>(k.key);
  }
  return {
    numCtx: configValue<number>('analyzer.ollama.numCtx'),
    capacity,
    effectiveChunkBudget: resolveStage2ChunkCharBudget(capacity),
    escalation: configValue<string>('analyzer.structure.escalation'),
    reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'local', model }) ?? null,
    payload: resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'local' }) ?? null,
    knobs,
  };
}

/** Every leaf of a value as `path -> JSON`, so two settings objects compare key by key. */
function leaves(v: unknown, path: string, out: Map<string, string>): void {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, JSON.stringify(v ?? null));
}

/** The keys whose recorded and current values differ, each as `key (saved X, now Y)`; empty when identical. */
export function settingsDiff(saved: unknown, now: EffectiveSettings): string[] {
  if (saved === null || typeof saved !== 'object') return ['(no settings recorded in the capture)'];
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  leaves(saved, '', a);
  leaves(now, '', b);
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter((k) => a.get(k) !== b.get(k))
    .map((k) => `${k} (saved ${a.get(k) ?? 'absent'}, now ${b.get(k) ?? 'absent'})`);
}

/** What a capture file holds: every captureChapterStages field plus the run's own. */
export type SavedCapture = CapturedChapter & {
  chapterId: number;
  model: string;
  /** The effective analyzer settings the capture ran under (checked on every re-capture). */
  settings: EffectiveSettings;
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
  /** The settings file the runner reads (read-only); default is the server's own path. Tests point it at a temp file. */
  settingsPath?: string;
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

  // The owner's saved settings, read without writing; every knob below resolves against them.
  try {
    primeUserSettingsCacheReadOnly(deps.settingsPath);
  } catch (e) {
    return refuse(`${e instanceof Error ? e.message : String(e)};`);
  }
  const settings = effectiveSettings(opts.model);

  // One model across every capture: checked before any capture, resume or re-capture.
  const existing = readSavedCaptures(scratch);
  const foreign = existing.filter((e) => e.saved.model !== opts.model);
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map((e) => e.saved.model))].join(', ');
    return refuse(`${scratch} holds captures made under model ${names}, not ${opts.model};`);
  }
  // The same settings too: any analyzer.* knob, the reasoning level, the payload or the effective chunk budget that differs is a different experiment.
  const drifted = existing.filter((e) => settingsDiff(e.saved.settings, settings).length > 0);
  if (drifted.length > 0) {
    const keys = [...new Set(drifted.flatMap((e) => settingsDiff(e.saved.settings, settings)))];
    return refuse(
      `${scratch} holds capture(s) made under different analyzer settings (ch${drifted.map((e) => e.saved.chapterId).join(', ch')}); ` +
        `differing: ${keys.join('; ')}. Restore the settings, or use a new scratch directory;`,
    );
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

  // The transport appends a VRAM sample under <WORKSPACE_ROOT>/.telemetry/ after each call; this run writes nothing under the workspace.
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  const url = getResolvedOllamaUrl(); // env, then the saved Admin override, then the default, as production resolves it
  const analyzer = deps.makeAnalyzer({ url, model: opts.model });
  const capacity = settings.capacity;
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
        settings,
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

/* ---- Phase 7c step 2: the 1A replays (measurement half, no model) ---- */

type EngineRun = ReturnType<typeof runStructureEngine>;
type Conventions = NonNullable<ReturnType<typeof conventionsFor>>;

/** R4-4, R5-6: a model sentence is a turn sentence when its own text opens with the language's
    dialogue marker or contains a mid-paragraph turn. Decided from the text, so a hidden turn
    inside a narration span counts. */
export function isTurnSentence(text: string, conventions: Conventions): boolean {
  return (conventions.dialogueOpen?.test(text) ?? false) || turnInParagraphRegex().test(text);
}

export interface ControlVoid {
  index: number;
  controlId: string | null;
  capturedId: string | null;
  controlReason: string | null;
  capturedReason: string | null;
}
export type ControlResult = { status: 'pass' } | ({ status: 'void' } & ControlVoid);

export interface ArmReport {
  confirmed: number;
  corrected: number;
  flagged: number;
  unresolved: number;
}
export interface ChapterReplay {
  chapterId: number;
  status: ChapterStatus;
  control: ControlResult;
  sentences: number;
  turnSentences: number;
  /** Sentences whose post-crossExamine speaker differs, on vs off. */
  changedAll: number;
  changedTurn: number;
  /** Narrator-attributed turn sentences, on and off (the share's numerators). */
  narratorTurnOn: number;
  narratorTurnOff: number;
  on: ArmReport;
  off: ArmReport;
  chunks: CapturedChapter['chunks'];
  /** Ids escalation changed: `final` vs `deterministic`. */
  escalationChanged: number;
  /** The engine's confident decisions on turn sentences, class x reason (counts only, owner decision 14). */
  confident: ConfidentCounts;
  /** Every sentence whose speaker differs, on vs off, with its class (same rule, same parses). */
  changed: ChangedSentence[];
}

/* ---- the confident-decision report (§4.3) ---- */

export type DecisionClass = 'a' | 'b' | 'c' | 'd';
export const DECISION_CLASSES: readonly DecisionClass[] = ['a', 'b', 'c', 'd'];
/** The five reasons a confident (>= 0.9, unflagged) decision can carry at 7d97f15f. */
export const CONFIDENT_REASONS = ['tag-confirm', 'tag-correct', 'tag-span-narrator', 'narration-confirm', 'narration-demote'] as const;
export type ConfidentReason = (typeof CONFIDENT_REASONS)[number];
export const CONFIDENT_MIN_CONFIDENCE = 0.9;
export type ConfidentCounts = Record<DecisionClass, Record<ConfidentReason, number>>;
export interface Span { start: number; end: number }
export interface ChangedSentence {
  index: number;
  turn: boolean;
  cls: DecisionClass;
  onId: string;
  offId: string;
  /** The model sentence's text (the blind sheet shows it). */
  text: string;
  /** Its own located raw range (locateSentenceRanges), or null when not located (R10-4). */
  range: Span | null;
  /** The recovery-off line holding the start of the first span it aligns to, with the line either side (R7-8); null = unaligned. */
  lines: { prev: Span | null; cur: Span; next: Span | null } | null;
}

/** Prefix match for the two `:<id>` forms, exact for the rest. `null` = not one of the five. */
export function confidentReasonOf(reason: string): ConfidentReason | null {
  if (reason.startsWith('tag-confirm:')) return 'tag-confirm';
  if (reason.startsWith('tag-correct:')) return 'tag-correct';
  if (reason === 'tag-span-narrator' || reason === 'narration-confirm' || reason === 'narration-demote') return reason;
  return null;
}

export const emptyConfident = (): ConfidentCounts =>
  Object.fromEntries(
    DECISION_CLASSES.map((c) => [c, Object.fromEntries(CONFIDENT_REASONS.map((r) => [r, 0]))]),
  ) as ConfidentCounts;

export function addConfident(into: ConfidentCounts, from: ConfidentCounts): void {
  for (const c of DECISION_CLASSES) for (const r of CONFIDENT_REASONS) into[c][r] += from[c][r];
}

interface ParseView {
  paras: ParagraphEvidence[];
  aligned: Array<{ spans: SpanEvidence[] }>;
}

/** The line (paragraph) holding `offset`, or undefined. Lines are newline-split, so none overlap. */
const lineAt = (paras: ParagraphEvidence[], offset: number): ParagraphEvidence | undefined =>
  paras.find((p) => offset >= p.start && offset <= p.end);

/** R6-6, R7-8: first match wins. (a) and (b) read the recovery-on parse, (c) the recovery-off parse. */
export function classifySentence(
  i: number,
  on: ParseView,
  off: ParseView,
  body: string,
  conventions: Conventions,
): DecisionClass {
  const onSpans = on.aligned[i]?.spans ?? [];
  if (onSpans.length === 0) return 'd'; // unaligned: no line
  // Recovery is length-preserving, so a recovered line is an on-parse line whose start is not an off-parse line start.
  const offStarts = new Set(off.paras.map((p) => p.start));
  const recovered = (s: SpanEvidence): boolean => {
    const line = lineAt(on.paras, s.start);
    return line !== undefined && !offStarts.has(line.start);
  };
  const isA = (): boolean => onSpans.some(recovered);
  const isB = (): boolean => onSpans.every((s) => s.kind === 'narration') && lineAt(on.paras, onSpans[0]!.start)?.kind === 'narration';
  const isC = (): boolean => {
    const first = off.aligned[i]?.spans[0];
    const line = first ? lineAt(off.paras, first.start) : undefined;
    if (!line) return false;
    const text = body.slice(line.start, line.end);
    return (conventions.dialogueOpen?.test(text) ?? false) && (text.match(turnInParagraphRegex())?.length ?? 0) >= MERGED_TURNS_DEGRADED;
  };
  if (isA()) return 'a';
  if (isB()) return 'b';
  if (isC()) return 'c';
  return 'd';
}

const armOf = (r: EngineRun): ArmReport => ({
  confirmed: r.examined.report.confirmed,
  corrected: r.examined.report.corrected,
  flagged: r.examined.report.flagged,
  unresolved: r.examined.report.unresolved,
});

/** The first sentence where the control's output departs from the captured `deterministic`. */
function firstDifference(control: EngineRun, saved: SavedCapture): ControlVoid | null {
  const a = control.examined.sentences;
  const b = saved.deterministic;
  if (isDeepStrictEqual(a, b)) return null;
  const n = Math.min(a.length, b.length);
  let index = n;
  for (let i = 0; i < n; i++) {
    if (!isDeepStrictEqual(a[i], b[i])) {
      index = i;
      break;
    }
  }
  return {
    index,
    controlId: a[index]?.characterId ?? null,
    capturedId: b[index]?.characterId ?? null,
    controlReason: control.examined.reasons[index]?.reason ?? null,
    capturedReason: saved.reasons[index]?.reason ?? null,
  };
}

/** R4-1: replay the engine over one captured `raw`: control (= on) and off. No analyzer, no coverage guard. */
export function replayChapter(saved: SavedCapture, body: string, conventions: Conventions, status: ChapterStatus): ChapterReplay {
  const args = () => ({ sentences: structuredClone(saved.raw), body, stage1: saved.stage1, conventions });
  const control = runStructureEngine(args()); // recovery on; the "on" arm is this same output, reused
  const off = runStructureEngine({ ...args(), structureOptions: { recoverMidParagraphTurns: false } });
  const diff = firstDifference(control, saved);
  const onS = control.examined.sentences;
  const offS = off.examined.sentences;
  const n = Math.min(onS.length, offS.length);
  let changedAll = 0;
  let changedTurn = 0;
  let turnSentences = 0;
  let narratorTurnOn = 0;
  let narratorTurnOff = 0;
  for (let i = 0; i < n; i++) {
    const turn = isTurnSentence(saved.raw[i]?.text ?? onS[i]!.text, conventions);
    const differs = onS[i]!.characterId !== offS[i]!.characterId;
    if (differs) changedAll++;
    if (turn) {
      turnSentences++;
      if (differs) changedTurn++;
      if (onS[i]!.characterId === 'narrator') narratorTurnOn++;
      if (offS[i]!.characterId === 'narrator') narratorTurnOff++;
    }
  }
  let escalationChanged = 0;
  const m = Math.min(saved.final.length, saved.deterministic.length);
  for (let i = 0; i < m; i++) if (saved.final[i]!.characterId !== saved.deterministic[i]!.characterId) escalationChanged++;
  const onView: ParseView = { paras: control.paras, aligned: control.alignment.aligned };
  const offView: ParseView = { paras: off.paras, aligned: off.alignment.aligned };
  const confident = emptyConfident();
  const changed: ChangedSentence[] = [];
  const flagged = new Set(saved.flags.map((f) => f.index)); // R6-4: `flags` is the only flag marker
  // Both arms share one located range per sentence: it depends only on the body and the sentence list (R10-4).
  let ranges: Array<Span | null> | null = null;
  const rangeOf = (i: number): Span | null =>
    (ranges ??= locateSentenceRanges(saved.raw, body, conventions.dialogueOpen !== null))[i] ?? null;
  const offLinesOf = (i: number): ChangedSentence['lines'] => {
    const first = offView.aligned[i]?.spans[0];
    const at = first ? offView.paras.findIndex((p) => first.start >= p.start && first.start <= p.end) : -1;
    if (at < 0) return null;
    const sp = (k: number): Span | null => (offView.paras[k] ? { start: offView.paras[k]!.start, end: offView.paras[k]!.end } : null);
    return { prev: sp(at - 1), cur: sp(at)!, next: sp(at + 1) };
  };
  for (let i = 0; i < n; i++) {
    const turn = isTurnSentence(saved.raw[i]?.text ?? onS[i]!.text, conventions);
    let cls: DecisionClass | null = null;
    const classOf = (): DecisionClass => (cls ??= classifySentence(i, onView, offView, body, conventions));
    if (onS[i]!.characterId !== offS[i]!.characterId) {
      changed.push({
        index: i, turn, cls: classOf(), onId: onS[i]!.characterId, offId: offS[i]!.characterId,
        text: saved.raw[i]?.text ?? onS[i]!.text, range: rangeOf(i), lines: offLinesOf(i),
      });
    }
    const det = saved.deterministic[i];
    if (!turn || !det || det.confidence < CONFIDENT_MIN_CONFIDENCE || flagged.has(i)) continue;
    const reason = saved.reasons[i]?.reason ?? '';
    const key = confidentReasonOf(reason);
    // R5-3: a confident reason outside the five gets a class decision before it is counted.
    if (key === null) throw new Error(`ch${saved.chapterId} sentence ${i}: unknown confident reason "${reason}" (confidence ${det.confidence}); add a class decision for it`);
    if (saved.final[i]?.characterId !== det.characterId) continue; // escalation overrode the engine
    confident[classOf()][key]++;
  }
  return {
    chapterId: saved.chapterId,
    status,
    control: diff ? { status: 'void', ...diff } : { status: 'pass' },
    sentences: n,
    turnSentences,
    changedAll,
    changedTurn,
    narratorTurnOn,
    narratorTurnOff,
    on: armOf(control),
    off: armOf(off),
    chunks: saved.chunks,
    escalationChanged,
    confident,
    changed,
  };
}

const COUNT_KEYS = [
  'sentences', 'turnSentences', 'changedAll', 'changedTurn', 'narratorTurnOn', 'narratorTurnOff', 'escalationChanged',
] as const;
export type Totals = Record<(typeof COUNT_KEYS)[number], number> & {
  chapters: number;
  on: ArmReport;
  off: ArmReport;
  confident: ConfidentCounts;
  /** 1A's changed sentences by class (turn sentences and others together). */
  changedByClass: Record<DecisionClass, number>;
};

/** Sums over the chapters given: the caller decides which chapters count (picked only, R9-3). */
export function sumReplays(rs: ChapterReplay[]): Totals {
  const arm = (k: 'on' | 'off'): ArmReport => ({
    confirmed: rs.reduce((n, r) => n + r[k].confirmed, 0),
    corrected: rs.reduce((n, r) => n + r[k].corrected, 0),
    flagged: rs.reduce((n, r) => n + r[k].flagged, 0),
    unresolved: rs.reduce((n, r) => n + r[k].unresolved, 0),
  });
  const t = { chapters: rs.length, on: arm('on'), off: arm('off'), confident: emptyConfident() } as Totals;
  for (const k of COUNT_KEYS) t[k] = rs.reduce((n, r) => n + r[k], 0);
  t.changedByClass = { a: 0, b: 0, c: 0, d: 0 };
  for (const r of rs) {
    addConfident(t.confident, r.confident);
    for (const c of r.changed) t.changedByClass[c.cls]++;
  }
  return t;
}

export interface VoidChapter extends ControlVoid {
  chapterId: number;
  status: ChapterStatus;
}
export interface MeasurementReport {
  model: string | null;
  language: string;
  pickOutcome: PickOutcome | null;
  /** Picked chapters' 1A: the only chapters in the verdict, `n`, the blind sheet and every total. */
  picked: ChapterReplay[];
  totals: Totals;
  /** The same class report over the swapped-out and captured-not-used chapters, kept apart (R9-3). */
  outsideTotals: Totals;
  /** Swapped-out and captured-not-used chapters, kept outside every total (R9-3, R10-2). */
  outside: ChapterReplay[];
  /** Every control's result, across all current captures (superseded ones are not read). */
  controls: Array<{ chapterId: number; status: ChapterStatus; control: ControlResult }>;
  verdict: { state: 'void'; void: VoidChapter[] } | { state: 'ready' };
  /** The blind sheet's plan: `n`, census or sample, the seed. Null when the measurement is void (no sheet). */
  handCheck: HandCheckRecord | null;
}

/** Reads the saved captures and pick.json and replays each chapter. Constructs no analyzer.
    `bodyOf(chapterId)` supplies the chapter text the capture ran over. */
export function measureCaptures(opts: {
  scratch: string;
  language: string;
  bodyOf: (chapterId: number) => string;
}): MeasurementReport {
  const scratch = resolve(opts.scratch);
  const conventions = conventionsFor(opts.language);
  if (!conventions) throw new Error(`no dialogue conventions for language "${opts.language}"`);
  const pick = readPick(scratch);
  const saved = readSavedCaptures(scratch).map((e) => e.saved).sort((a, b) => a.chapterId - b.chapterId);
  if (saved.length === 0) throw new Error(`${scratch} holds no saved captures`);
  const statusOf = (id: number): ChapterStatus => pick?.chapters[String(id)]?.status ?? 'captured-not-used';
  // Every current capture is replayed, swapped-out and captured-not-used ones too: their controls
  // gate the verdict (R7-7). A superseded capture is a different file and is never read.
  const replays = saved.map((s) => replayChapter(s, opts.bodyOf(s.chapterId), conventions, statusOf(s.chapterId)));
  const picked = replays.filter((r) => r.status === 'picked');
  const outside = replays.filter((r) => r.status !== 'picked');
  const voids: VoidChapter[] = replays.flatMap((r) =>
    r.control.status === 'void'
      ? [{ chapterId: r.chapterId, status: r.status, index: r.control.index, controlId: r.control.controlId,
           capturedId: r.control.capturedId, controlReason: r.control.controlReason, capturedReason: r.control.capturedReason }]
      : [],
  );
  return {
    model: pick?.model ?? saved[0]!.model,
    language: opts.language,
    pickOutcome: pick?.outcome ?? null,
    picked,
    totals: sumReplays(picked),
    outsideTotals: sumReplays(outside),
    outside,
    controls: replays.map((r) => ({ chapterId: r.chapterId, status: r.status, control: r.control })),
    verdict: voids.length > 0 ? { state: 'void', void: voids } : { state: 'ready' },
    handCheck: voids.length > 0 ? null : planHandCheck(picked),
  };
}

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);

function chapterRows(rs: ChapterReplay[]): string[] {
  return rs.map(
    (r) =>
      `| ch${r.chapterId} | ${r.control.status} | ${r.sentences} | ${r.turnSentences} | ${r.changedAll} | ${r.changedTurn} | ` +
      `${pct(r.narratorTurnOn, r.turnSentences)} / ${pct(r.narratorTurnOff, r.turnSentences)} | ` +
      `${r.on.confirmed}/${r.on.corrected}/${r.on.flagged}/${r.on.unresolved} | ` +
      `${r.off.confirmed}/${r.off.corrected}/${r.off.flagged}/${r.off.unresolved} | ` +
      `${r.chunks.chunkCount}/${r.chunks.coverageRetries}/${r.chunks.coverageExhausted}/${r.chunks.deterministicSplits} | ${r.escalationChanged} |`,
  );
}
const TABLE_HEAD = [
  '| chapter | control | sentences | turn sentences | changed (all) | changed (turn) | narrator share on / off | on c/k/f/u | off c/k/f/u | chunks n/retry/exhausted/split | escalation changed |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];

const CLASS_NAMES: Record<DecisionClass, string> = {
  a: '(a) recovery-split line',
  b: '(b) unsplit dash turn',
  c: '(c) degraded dash-open paragraph',
  d: '(d) other',
};
function confidentTable(t: Totals): string[] {
  const rows = DECISION_CLASSES.map((c) => {
    const by = t.confident[c];
    const total = CONFIDENT_REASONS.reduce((n, k) => n + by[k], 0);
    return `| ${CLASS_NAMES[c]} | ${total} | ${CONFIDENT_REASONS.map((k) => by[k]).join(' | ')} |`;
  });
  return [`| class | total | ${CONFIDENT_REASONS.join(' | ')} |`, `|---|---|${CONFIDENT_REASONS.map(() => '---').join('|')}|`, ...rows];
}
function changedTable(rs: ChapterReplay[]): string[] {
  const rows = rs.flatMap((r) =>
    r.changed.map((c) => `| ch${r.chapterId} | ${c.index} | ${c.turn ? 'turn' : 'other'} | ${c.cls} | ${c.onId} | ${c.offId} |`),
  );
  if (rows.length === 0) return ['No sentence changed.'];
  return ['| chapter | sentence | kind | class | on | off |', '|---|---|---|---|---|---|', ...rows];
}

export function renderReport(r: MeasurementReport): string {
  const L: string[] = [`# #2254 1A engine replay (${r.language}${r.model ? `, model ${r.model}` : ''})`, ''];
  L.push(`Pick outcome: ${r.pickOutcome ?? 'no pick.json'}`, '', '## Chapter status and control', '', '| chapter | status | control |', '|---|---|---|');
  for (const c of r.controls) L.push(`| ch${c.chapterId} | ${c.status} | ${c.control.status} |`);
  L.push('', '## Picked chapters: 1A (c/k/f/u = confirmed/corrected/flagged/unresolved)', '', ...TABLE_HEAD, ...chapterRows(r.picked));
  const t = r.totals;
  L.push(
    '',
    `Totals over ${t.chapters} picked chapter(s): ${t.sentences} sentences, ${t.turnSentences} turn sentences, changed ${t.changedAll} (all) / ${t.changedTurn} (turn).`,
  );
  L.push('', '## Confident decisions on turn sentences, by class and reason (picked chapters; counts only, no verdict)', '', ...confidentTable(t));
  L.push('', '## 1A changed sentences (picked chapters), with class', '', ...changedTable(r.picked));
  L.push('', '## Outside the verdict: swapped-out and captured-not-used (in no total)', '');
  if (r.outside.length === 0) L.push('None.');
  else L.push(...TABLE_HEAD, ...chapterRows(r.outside), '', 'Confident decisions, outside chapters (separate from the table above):', '', ...confidentTable(r.outsideTotals), '', ...changedTable(r.outside));
  L.push('', '## Verdict state', '');
  if (r.verdict.state === 'ready') {
    L.push('`ready`.');
    const h = r.handCheck;
    if (h) L.push('', `Hand-check: n = ${h.n}, ${h.mode}${h.seed === null ? '' : `, seed ${h.seed}`}; ${h.items.length} sentence(s) on ${SHEET_FILE}.`);
  }
  else {
    L.push('`void`: a replay control did not reproduce the live snapshot.', '');
    for (const v of r.verdict.void) {
      L.push(
        `- ch${v.chapterId} (${v.status}): first difference at sentence ${v.index}: control id ${v.controlId} (${v.controlReason}) vs captured id ${v.capturedId} (${v.capturedReason})`,
      );
    }
  }
  return `${L.join('\n')}\n`;
}

/* ---- Phase 7c step 4: the blind 1A hand-check sheet (§4.3, §4.4 step 2, R7-11, R8-3, R9-4, R10-4) ---- */

export const SHEET_FILE = 'blind-sheet.md';
export const KEY_FILE = 'blind-key.json';
/** §4.4 step 2: a census up to 30; above that, 30 drawn uniformly without replacement. */
export const SHEET_CAP = 30;
/** The fixed seed the report records for the draw. */
export const SHEET_SEED = 2254;
/** A line longer than this is shown as a window (R9-4). */
export const LONG_LINE = 1200;
/** Characters shown either side of the located range in a window. */
export const WINDOW = 400;
export const MARK_OPEN = '⟦';
export const MARK_CLOSE = '⟧';

export interface HandCheckRecord {
  /** 1A's changed sentences across the picked chapters only (R9-3, R10-2). */
  n: number;
  mode: 'census' | 'sample';
  /** The seed of the draw; null for a census (nothing is drawn). */
  seed: number | null;
  /** The sentences on the sheet, in sheet order. */
  items: Array<{ chapterId: number; index: number }>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Census when `all.length <= SHEET_CAP`; else SHEET_CAP drawn uniformly without replacement (partial
    Fisher-Yates over a seeded generator), kept in their original order so the order leaks nothing. */
export function selectSheetItems<T>(all: T[], seed: number = SHEET_SEED): { mode: 'census' | 'sample'; seed: number | null; picked: T[] } {
  if (all.length <= SHEET_CAP) return { mode: 'census', seed: null, picked: [...all] };
  const rnd = mulberry32(seed);
  const idx = all.map((_, i) => i);
  for (let i = 0; i < SHEET_CAP; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const chosen = idx.slice(0, SHEET_CAP).sort((a, b) => a - b);
  return { mode: 'sample', seed, picked: chosen.map((i) => all[i]!) };
}

const oneLine = (t: string): string => t.replace(/\s*\n\s*/g, ' ↵ ');

/** A neighbouring line: whole if short, else the 400 characters nearest the sentence's line. */
function neighbour(body: string, s: Span | null, side: 'prev' | 'next'): string {
  if (!s) return '(none)';
  const t = body.slice(s.start, s.end);
  if (t.length <= LONG_LINE) return t;
  return side === 'prev' ? `…${t.slice(-WINDOW)}` : `${t.slice(0, WINDOW)}…`;
}

/** One item's section. Shows no speaker from either arm or from the engine. */
export function renderSheetItem(k: number, body: string, c: Pick<ChangedSentence, 'text' | 'range' | 'lines'>): string {
  const L: string[] = [`## Item ${k}`, `Sentence: ${oneLine(c.text)}`];
  if (c.lines === null) {
    L.push('Shown as: text alone (unaligned: this sentence aligns to no line)');
  } else if (c.range === null) {
    L.push('Shown as: text alone (unlocated: its own place in the text could not be found)');
  } else {
    const line = c.lines.cur;
    const rs = Math.max(c.range.start, line.start);
    const re = Math.min(c.range.end, line.end);
    const long = line.end - line.start > LONG_LINE;
    const ws = long ? Math.max(line.start, rs - WINDOW) : line.start;
    const we = long ? Math.min(line.end, re + WINDOW) : line.end;
    const shown = body.slice(ws, we);
    const needle = body.slice(c.range.start, c.range.end);
    let times = 0;
    for (let at = needle ? shown.indexOf(needle) : -1; at >= 0; at = shown.indexOf(needle, at + needle.length)) times++;
    L.push(`Line before: ${neighbour(body, c.lines.prev, 'prev')}`);
    if (re <= rs) {
      L.push(`Line: ${long ? `${ws > line.start ? '…' : ''}${shown}${we < line.end ? '…' : ''}` : shown}`);
      L.push('Shown as: its located range lies outside this line, so it is not marked');
    } else {
      const marked = `${body.slice(ws, rs)}${MARK_OPEN}${body.slice(rs, re)}${MARK_CLOSE}${body.slice(re, we)}`;
      L.push(`Line: ${ws > line.start && long ? '…' : ''}${marked}${we < line.end && long ? '…' : ''}`);
      L.push(
        long
          ? `Shown as: a window of ${WINDOW} characters either side of the marked sentence, cut from a line of ${line.end - line.start} characters; the sentence starts at offset ${rs - line.start} in the line`
          : `Shown as: the whole line; the sentence starts at offset ${rs - line.start} in the line`,
      );
      L.push(`Occurrences of the marked text in what is shown: ${times}`);
    }
    L.push(`Line after: ${neighbour(body, c.lines.next, 'next')}`);
  }
  L.push('Speaker: ', 'Mixed: ');
  return L.join('\n');
}

export interface SheetRoster { id: string; name: string }

/** The header: rubric and the pinned roster's ids. The only place a roster id or `narrator` appears. */
export function renderSheetHeader(roster: SheetRoster[], rec: HandCheckRecord): string {
  return [
    '# #2254 1A hand-check (blind)',
    '',
    `${rec.items.length} sentence(s) (${rec.mode}${rec.mode === 'sample' ? `, seed ${rec.seed}` : ''}). Each shows the sentence and its line in the text as imported, with the line either side. No answer from either arm or from the engine is shown.`,
    '',
    '## How to fill in an item',
    '',
    '- `Speaker:` the true speaker: a roster id from the list below, or `narrator`; or `can\'t tell`; or `two speakers`.',
    '- A mixed sentence (narration plus a turn, such as `Антон обернулся. — Ты кто?`): write the **turn\'s** speaker and put `x` in `Mixed:`.',
    '- A sentence holding two different speakers\' turns (`— Да? — Нет.`): write `two speakers`. It outranks mixed; leave `Mixed:` empty.',
    '- `Mixed:` is a separate field; filling it never changes what `Speaker:` holds.',
    '',
    '## Roster (the pinned roster)',
    '',
    ...roster.map((r) => `- ${r.id}: ${r.name}`),
  ].join('\n');
}

/** The whole sheet: header, then one `## Item <k>` section per sentence, k from 1. */
export function renderSheet(roster: SheetRoster[], rec: HandCheckRecord, sections: string[]): string {
  return `${renderSheetHeader(roster, rec)}\n\n${sections.join('\n\n')}\n`;
}

/** Every changed sentence of the picked chapters, in chapter then sentence order. */
const pickedChanged = (picked: ChapterReplay[]): Array<{ chapterId: number; c: ChangedSentence }> =>
  [...picked].sort((a, b) => a.chapterId - b.chapterId).flatMap((r) => r.changed.map((c) => ({ chapterId: r.chapterId, c })));

/** What goes on the sheet, from the picked chapters only. */
export function planHandCheck(picked: ChapterReplay[]): HandCheckRecord {
  const all = pickedChanged(picked);
  const sel = selectSheetItems(all);
  return { n: all.length, mode: sel.mode, seed: sel.seed, items: sel.picked.map((p) => ({ chapterId: p.chapterId, index: p.c.index })) };
}

/** Writes blind-sheet.md and blind-key.json for a non-void measurement; removes stale copies when void. */
export function writeBlindSheet(
  scratch: string,
  report: MeasurementReport,
  bodyOf: (chapterId: number) => string,
  roster: SheetRoster[],
): void {
  const sheet = join(scratch, SHEET_FILE);
  const key = join(scratch, KEY_FILE);
  const rec = report.handCheck;
  if (report.verdict.state !== 'ready' || rec === null) {
    for (const f of [sheet, key]) if (existsSync(f)) rmSync(f);
    return;
  }
  const byKey = new Map(pickedChanged(report.picked).map((p) => [`${p.chapterId}:${p.c.index}`, p.c] as const));
  const sections: string[] = [];
  const keyItems = rec.items.map((it, i) => {
    const c = byKey.get(`${it.chapterId}:${it.index}`)!;
    sections.push(renderSheetItem(i + 1, bodyOf(it.chapterId), c));
    return { item: i + 1, chapterId: it.chapterId, sentenceIndex: it.index, onId: c.onId, offId: c.offId, class: c.cls };
  });
  writeAtomic(sheet, renderSheet(roster, rec, sections));
  writeAtomic(key, JSON.stringify({ n: rec.n, mode: rec.mode, seed: rec.seed, roster: roster.map((r) => r.id), items: keyItems }, null, 2));
}

/** Measures from the saved files and writes report.json and report.md beside them. Nothing here
    writes a capture file, so a failure never touches a saved capture (R6-5). */
export function runMeasurement(opts: { scratch: string; language: string; manifest: ManifestEntry[] }): MeasurementReport {
  const paths = new Map(opts.manifest.map((m) => [m.chapterId, m.chapterTextPath] as const));
  const bodyOf = (id: number): string => {
    const p = paths.get(id);
    if (!p) throw new Error(`chapter ${id} has a saved capture but is not in the manifest`);
    return readFileSync(p, 'utf8'); // as-is, the string the capture read
  };
  const report = measureCaptures({ scratch: opts.scratch, language: opts.language, bodyOf });
  const scratch = resolve(opts.scratch);
  // The pinned roster: the union of the picked chapters' rosters, first definition of an id wins.
  const roster = new Map<string, SheetRoster>();
  for (const r of report.picked) {
    const m = opts.manifest.find((e) => e.chapterId === r.chapterId);
    if (m) for (const ch of rosterFrom(m.rosterPath).characters) if (!roster.has(ch.id)) roster.set(ch.id, { id: ch.id, name: ch.name });
  }
  writeBlindSheet(scratch, report, bodyOf, [...roster.values()]);
  // A new measurement can change the sheet, so a score read from the old one is stale.
  if (existsSync(join(scratch, SCORE_FILE))) rmSync(join(scratch, SCORE_FILE));
  writeAtomic(join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  writeAtomic(join(scratch, 'report.md'), renderReport(report));
  return report;
}

/* ---- Phase 7c step 5: --score and the 1A verdict (§4.3 `--score`, §4.4 "Verdict", R7-1, R7-2, R7-11, R8-3, R9-4) ---- */

export const SCORE_FILE = 'score.json';
/** §4.4: the census margins, kept by the sample test. */
export const IMPROVES_MARGIN = 3;
export const WORSE_MARGIN = 1;
/** One-sided levels of the sample test (§4.4): the looser one is for harm. */
export const IMPROVES_LEVEL = 0.025;
export const WORSE_LEVEL = 0.1;
export const CANT_TELL = "can't tell";
export const TWO_SPEAKERS = 'two speakers';

export type Verdict =
  | 'void'
  | 'not computed'
  | 'recovery changes no speaker'
  | 'recovery improves the speakers'
  | 'recovery makes them worse'
  | 'no clear direction';

const lnFactCache: number[] = [0];
function lnFact(k: number): number {
  for (let i = lnFactCache.length; i <= k; i++) lnFactCache[i] = lnFactCache[i - 1]! + Math.log(i);
  return lnFactCache[k]!;
}
const lnChoose = (n: number, k: number): number => (k < 0 || k > n ? -Infinity : lnFact(n) - lnFact(k) - lnFact(n - k));

/** P(sample I - R >= d) for a draw of `m` from a population of `n` holding `a` improvements and `b` regressions
    (the rest neutral): the multivariate hypergeometric distribution, exact. Roles swap for the other claim:
    hyperTail(n, b, a, d) is P(sample R - I >= d). */
export function hyperTail(n: number, a: number, b: number, d: number, m: number = SHEET_CAP): number {
  const c = n - a - b;
  const denom = lnChoose(n, m);
  let p = 0;
  for (let i = 0; i <= Math.min(a, m); i++) {
    for (let r = 0; r <= Math.min(b, m - i); r++) {
      if (i - r < d) continue;
      const u = m - i - r;
      if (u > c) continue;
      p += Math.exp(lnChoose(a, i) + lnChoose(b, r) + lnChoose(c, u) - denom);
    }
  }
  return Math.min(1, p);
}

/** Largest p over every split the null `I_n - R_n <= 2` allows. P rises with improvements and falls with
    regressions, so any split in the null moves, without lowering P, onto I_n - R_n = 2 (a neutral becomes an
    improvement, or with no neutral left a regression becomes a neutral): only that boundary is searched. The
    test file cross-checks this against every split at n = 31 and 40. */
export function pImproves(n: number, observedDiff: number, m: number = SHEET_CAP): number {
  let best = 0;
  for (let b = 0; 2 * b + IMPROVES_MARGIN - 1 <= n; b++) best = Math.max(best, hyperTail(n, b + IMPROVES_MARGIN - 1, b, observedDiff, m));
  return best;
}

/** Largest p over every split the null `R_n <= I_n` allows, by the mirror argument: the boundary is R_n = I_n. */
export function pWorse(n: number, observedDiff: number, m: number = SHEET_CAP): number {
  let best = 0;
  for (let a = 0; 2 * a <= n; a++) best = Math.max(best, hyperTail(n, a, a, observedDiff, m));
  return best;
}

export interface VerdictInput {
  /** Any captured chapter's replay control void (R7-7). */
  controlVoid: boolean;
  /** pick.json's outcome; `not-computed` and `stopped-for-owner` mean no chapter cleared the floor. */
  pickOutcome: PickOutcome | null;
  n: number;
  /** Judged counts: all n in a census, the 30 drawn in a sample. */
  I: number;
  R: number;
  U: number;
}
export interface VerdictResult {
  verdict: Verdict;
  mode: 'census' | 'sample' | null;
  /** One-sided p-values of the two sample claims; null in a census or when not computed. */
  pImproves: number | null;
  pWorse: number | null;
}

/** §4.4 "Verdict": the rule, in order. Void and not-computed outrank every count. */
export function decideVerdict(v: VerdictInput): VerdictResult {
  const none = { mode: null, pImproves: null, pWorse: null } as const;
  if (v.controlVoid) return { verdict: 'void', ...none };
  if (v.pickOutcome === 'not-computed' || v.pickOutcome === 'stopped-for-owner') return { verdict: 'not computed', ...none };
  if (v.n === 0) return { verdict: 'recovery changes no speaker', ...none };
  if (v.n <= SHEET_CAP) {
    const verdict: Verdict =
      v.I - v.R >= IMPROVES_MARGIN ? 'recovery improves the speakers' : v.R - v.I >= WORSE_MARGIN ? 'recovery makes them worse' : 'no clear direction';
    return { verdict, mode: 'census', pImproves: null, pWorse: null };
  }
  const pi = pImproves(v.n, v.I - v.R);
  const pw = pWorse(v.n, v.R - v.I);
  const improves = pi < IMPROVES_LEVEL;
  const worse = pw < WORSE_LEVEL;
  if (improves && worse) throw new Error(`both sample claims accepted at n = ${v.n}, I - R = ${v.I - v.R}: impossible by §4.4, the test is wrong`);
  const verdict: Verdict = improves ? 'recovery improves the speakers' : worse ? 'recovery makes them worse' : 'no clear direction';
  return { verdict, mode: 'sample', pImproves: pi, pWorse: pw };
}

export interface BlindKey {
  n: number;
  mode: 'census' | 'sample';
  seed: number | null;
  /** The pinned roster's ids, as the sheet was written. */
  roster: string[];
  items: Array<{ item: number; chapterId: number; sentenceIndex: number; onId: string; offId: string; class: DecisionClass }>;
}

export interface SheetEntry { item: number; speaker: string; mixed: boolean }

/** Reads the filled sheet: each `## Item <k>` section's `Speaker:` and `Mixed:` values. A missing field reads as empty. */
export function parseSheet(text: string): SheetEntry[] {
  const parts = text.split(/^## Item (\d+)[ \t]*$/m);
  const out: SheetEntry[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1] ?? '';
    const field = (name: string): string => {
      const all = [...body.matchAll(new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'gm'))];
      return all.length > 0 ? all[all.length - 1]![1]! : '';
    };
    out.push({ item: Number(parts[i]), speaker: field('Speaker'), mixed: field('Mixed') !== '' });
  }
  return out;
}

/** The normal form of a judged value: the two phrases are case-insensitive and take a typographic apostrophe. */
function judgedValue(raw: string, roster: ReadonlySet<string>): string | null {
  const v = raw.trim();
  if (roster.has(v)) return v;
  const low = v.toLowerCase().replace(/[’ʼ]/g, "'");
  if (low === 'narrator' || low === CANT_TELL || low === TWO_SPEAKERS) return low;
  return null;
}

/** R9-4: every judged value must be a pinned roster id, `narrator`, `can't tell` or `two speakers`. The `Mixed:`
    field is not part of the check. Returns one message per bad item, and one per item the key expects but the sheet lacks. */
export function checkSheet(entries: SheetEntry[], key: BlindKey): string[] {
  const roster = new Set(key.roster);
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.item)) errors.push(`Item ${e.item}: appears more than once on the sheet`);
    seen.add(e.item);
    if (!key.items.some((k) => k.item === e.item)) {
      errors.push(`Item ${e.item}: not an item of this sheet`);
      continue;
    }
    if (judgedValue(e.speaker, roster) === null) {
      errors.push(`Item ${e.item}: judged value ${JSON.stringify(e.speaker)} is not a roster id, narrator, ${CANT_TELL} or ${TWO_SPEAKERS}`);
    }
  }
  for (const k of key.items) if (!seen.has(k.item)) errors.push(`Item ${k.item}: missing from the sheet`);
  return errors;
}

export type Judgement = 'improvement' | 'regression' | 'neutral';
export interface Scored {
  I: number;
  R: number;
  U: number;
  /** Sentences marked mixed, two-speaker ones excluded (two speakers outranks mixed, R9-4). */
  mixed: number;
  twoSpeakers: number;
  judgements: Array<{ item: number; judged: string; judgement: Judgement; mixed: boolean }>;
}

/** §4.4 step 2: improvement = on's id is the judged speaker and off's is not; regression = the reverse; else neutral. */
export function scoreEntries(entries: SheetEntry[], key: BlindKey): Scored {
  const roster = new Set(key.roster);
  const byItem = new Map(entries.map((e) => [e.item, e] as const));
  const s: Scored = { I: 0, R: 0, U: 0, mixed: 0, twoSpeakers: 0, judgements: [] };
  for (const k of key.items) {
    const e = byItem.get(k.item)!;
    const judged = judgedValue(e.speaker, roster)!;
    const two = judged === TWO_SPEAKERS;
    let judgement: Judgement = 'neutral';
    if (!two && judged !== CANT_TELL) {
      if (judged === k.onId && judged !== k.offId) judgement = 'improvement';
      else if (judged === k.offId && judged !== k.onId) judgement = 'regression';
    }
    if (judgement === 'improvement') s.I++;
    else if (judgement === 'regression') s.R++;
    else s.U++;
    if (two) s.twoSpeakers++;
    else if (e.mixed) s.mixed++;
    s.judgements.push({ item: k.item, judged, judgement, mixed: e.mixed });
  }
  return s;
}

const VERDICT_HEADING = '## 1A verdict';

function renderVerdict(score: ScoreFile): string {
  const L = [VERDICT_HEADING, '', `**${score.verdict}**`, ''];
  if (score.verdict === 'void') L.push('A replay control did not reproduce the live snapshot; no verdict is computed on the chapters that passed.');
  else if (score.verdict === 'not computed') L.push(`No captured chapter cleared the floor (pick outcome: ${score.pickOutcome}).`);
  else {
    L.push(`${score.mode}, n = ${score.n}, judged ${score.judged}: I = ${score.I}, R = ${score.R}, U = ${score.U}.`);
    if (score.mode === 'sample') {
      L.push(
        `One-sided p: improves ${score.pImproves!.toPrecision(4)} (needs < ${IMPROVES_LEVEL}), makes them worse ${score.pWorse!.toPrecision(4)} (needs < ${WORSE_LEVEL}).`,
        `Estimated over all ${score.n}: improved ${score.estimate!.improved.toFixed(1)}, regressed ${score.estimate!.regressed.toFixed(1)}.`,
      );
    } else if (score.n > 0) L.push(`Exact: ${score.I} improved, ${score.R} regressed.`);
    L.push(`Mixed ${score.mixed}; two speakers ${score.twoSpeakers}.`);
    if (score.byClass) L.push('', `Changed sentences by class: ${(['a', 'b', 'c', 'd'] as const).map((c) => `(${c}) ${score.byClass![c]}`).join(', ')}.`);
    if (score.narratorShare) L.push(`Narrator share of turn sentences: on ${score.narratorShare.on} / ${score.narratorShare.turnSentences}, off ${score.narratorShare.off} / ${score.narratorShare.turnSentences}.`);
  }
  if (score.outside.length > 0) {
    L.push('', 'Outside the verdict (swapped-out and captured-not-used chapters, 1A counts only):', '', '| chapter | status | changed (all) | changed (turn) |', '|---|---|---|---|');
    for (const o of score.outside) L.push(`| ch${o.chapterId} | ${o.status} | ${o.changedAll} | ${o.changedTurn} |`);
  }
  return `${L.join('\n')}\n`;
}

export interface ScoreFile {
  verdict: Verdict;
  mode: 'census' | 'sample' | null;
  pickOutcome: PickOutcome | null;
  n: number;
  /** Sentences judged: n in a census, the sample size in a sample. */
  judged: number;
  seed: number | null;
  I: number;
  R: number;
  U: number;
  mixed: number;
  twoSpeakers: number;
  pImproves: number | null;
  pWorse: number | null;
  /** Sample only: `n x I / 30` and `n x R / 30`. */
  estimate: { improved: number; regressed: number } | null;
  byClass: Totals['changedByClass'] | null;
  narratorShare: { on: number; off: number; turnSentences: number } | null;
  /** Swapped-out and captured-not-used chapters' 1A counts, in no total above. */
  outside: Array<{ chapterId: number; status: ChapterStatus; changedAll: number; changedTurn: number }>;
  judgements: Scored['judgements'];
}

/** `--score <sheet> --scratch <dir>`. Returns the exit code. A roster failure writes no score and removes a stale one. */
export function runScore(opts: { scratch: string; sheetPath: string }, deps: Pick<RunnerDeps, 'log'>): number {
  const scratch = resolve(opts.scratch);
  const scorePath = join(scratch, SCORE_FILE);
  const reportPath = join(scratch, 'report.json');
  if (!existsSync(reportPath)) throw new Error(`${scratch} has no report.json: run --from-captures first`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as MeasurementReport;
  const controlVoid = report.verdict.state === 'void';
  const notComputed = report.pickOutcome === 'not-computed' || report.pickOutcome === 'stopped-for-owner';
  const n = report.handCheck?.n ?? 0;
  const base: Omit<ScoreFile, 'verdict' | 'mode' | 'pImproves' | 'pWorse' | 'estimate'> = {
    pickOutcome: report.pickOutcome,
    n,
    judged: 0,
    seed: report.handCheck?.seed ?? null,
    I: 0, R: 0, U: 0, mixed: 0, twoSpeakers: 0,
    byClass: controlVoid ? null : report.totals.changedByClass,
    narratorShare: controlVoid ? null : { on: report.totals.narratorTurnOn, off: report.totals.narratorTurnOff, turnSentences: report.totals.turnSentences },
    outside: report.outside.map((r) => ({ chapterId: r.chapterId, status: r.status, changedAll: r.changedAll, changedTurn: r.changedTurn })),
    judgements: [],
  };
  let scored: Scored | null = null;
  // Void, not-computed and n = 0 need no judgement: the sheet is read only when a count can decide.
  if (!controlVoid && !notComputed && n > 0) {
    if (!existsSync(opts.sheetPath)) throw new Error(`sheet not found: ${opts.sheetPath}`);
    const keyPath = join(scratch, KEY_FILE);
    if (!existsSync(keyPath)) throw new Error(`${scratch} has no ${KEY_FILE}: it pairs the sheet's items with the engine's ids`);
    const key = JSON.parse(readFileSync(keyPath, 'utf8')) as BlindKey;
    const entries = parseSheet(readFileSync(opts.sheetPath, 'utf8'));
    const errors = checkSheet(entries, key);
    if (errors.length > 0) {
      if (existsSync(scorePath)) rmSync(scorePath);
      for (const e of errors) process.stderr.write(`error: ${e}\n`);
      process.stderr.write('error: no score written; fix the sheet and run --score again\n');
      return 1;
    }
    scored = scoreEntries(entries, key);
  }
  const counts = scored ?? { I: 0, R: 0, U: 0, mixed: 0, twoSpeakers: 0, judgements: [] };
  const judged = scored ? scored.judgements.length : 0;
  const d = decideVerdict({ controlVoid, pickOutcome: report.pickOutcome, n, I: counts.I, R: counts.R, U: counts.U });
  const score: ScoreFile = {
    ...base,
    ...counts,
    judged,
    verdict: d.verdict,
    mode: d.mode,
    pImproves: d.pImproves,
    pWorse: d.pWorse,
    estimate: d.mode === 'sample' ? { improved: (n * counts.I) / judged, regressed: (n * counts.R) / judged } : null,
  };
  writeAtomic(scorePath, JSON.stringify(score, null, 2));
  const mdPath = join(scratch, 'report.md');
  const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
  const cut = md.indexOf(VERDICT_HEADING);
  writeAtomic(mdPath, `${(cut >= 0 ? md.slice(0, cut) : md).replace(/\n*$/, '\n')}\n${renderVerdict(score)}`);
  deps.log(`scored: ${score.verdict}${score.mode ? ` (${score.mode}, n = ${n}, I = ${score.I}, R = ${score.R}, U = ${score.U})` : ''}`);
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
  if (argv.includes('--score')) {
    const sheetPath = argValue(argv, '--score');
    if (!sheetPath || sheetPath.startsWith('--') || !scratch) {
      process.stderr.write(USAGE);
      return 2;
    }
    try {
      return runScore({ scratch, sheetPath: resolve(sheetPath) }, deps);
    } catch (e) {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  if (argv.includes('--from-captures')) {
    const language = argValue(argv, '--language');
    if (!manifestPath || !scratch || !language) {
      process.stderr.write(USAGE);
      return 2;
    }
    try {
      const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as ManifestEntry[];
      const r = runMeasurement({ scratch, language, manifest });
      deps.log(`measured ${r.controls.length} capture(s): verdict ${r.verdict.state}`);
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
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
    const code = await runCapture(
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
    // The same measurement after the walk settles; its failure never touches a saved capture (R6-5).
    const language = argValue(argv, '--language');
    if (code === 0 && language && conventionsFor(language)) {
      try {
        const r = runMeasurement({ scratch, language, manifest });
        deps.log(`measured ${r.controls.length} capture(s): verdict ${r.verdict.state}`);
      } catch (e) {
        deps.log(`measurement failed (saved captures untouched; re-run with --from-captures): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return code;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
