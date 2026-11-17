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
import { resolveCapacity } from '../src/analyzer/capacity.js';
import { configValue } from '../src/config/resolver.js';

export const USAGE =
  'usage: paragraph-degradation-ab.mts --manifest <file.json> --model <name> --scratch <dir> [--language ru] [--resume]\n';

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
}

export const captureFileName = (chapterId: number): string => `capture-ch${chapterId}.json`;

/** Every saved capture in <scratch>, in no particular order. A missing directory holds none. */
export function readSavedCaptures(scratch: string): Array<{ file: string; saved: SavedCapture }> {
  if (!existsSync(scratch)) return [];
  return readdirSync(scratch)
    .filter((f) => /^capture-ch\d+\.json$/.test(f))
    .map((f) => ({ file: f, saved: JSON.parse(readFileSync(join(scratch, f), 'utf8')) as SavedCapture }));
}

/** Writes via a temp name then a rename, so a capture file is never half-written. */
function writeCaptureFile(scratch: string, saved: SavedCapture): string {
  const file = join(scratch, captureFileName(saved.chapterId));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(saved, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}

function rosterFrom(path: string): RosterSnapshot {
  const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const chars = Array.isArray(j) ? j : (j as { characters?: unknown }).characters;
  if (!Array.isArray(chars)) throw new Error(`roster ${path}: expected a characters array`);
  return buildRosterSnapshot(chars as Parameters<typeof buildRosterSnapshot>[0]);
}

const fmtMs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Returns the process exit code. Refusals return before anything is written. */
export async function runCapture(opts: CaptureRunOptions, deps: RunnerDeps): Promise<number> {
  const scratch = resolve(opts.scratch);

  // One model across every capture: checked before any capture, resume or re-capture.
  const existing = readSavedCaptures(scratch);
  const foreign = existing.filter((e) => e.saved.model !== opts.model);
  if (foreign.length > 0) {
    const names = [...new Set(foreign.map((e) => e.saved.model))].join(', ');
    deps.log(`refused: ${scratch} holds captures made under model ${names}, not ${opts.model}; nothing was written.`);
    return 1;
  }
  if (existing.length > 0 && !opts.resume) {
    deps.log(`refused: ${scratch} already holds ${existing.length} capture(s); pass --resume to continue the run. Nothing was written.`);
    return 1;
  }

  const saved = new Map(existing.map((e) => [e.saved.chapterId, e.saved] as const));
  const todo = opts.manifest.filter((m) => !saved.has(m.chapterId));

  // The budget the whole book shares; a resumed run restores it from the newest saved capture.
  const newest = existing.map((e) => e.saved).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1);
  const structureBudget = {
    remainingWindows: newest ? newest.remainingWindows : configValue<number>('analyzer.structure.maxWindowsPerBook'),
  };

  mkdirSync(scratch, { recursive: true });
  const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const analyzer = deps.makeAnalyzer({ url, model: opts.model });
  const capacity = resolveCapacity({ engine: 'local', model: opts.model });
  const stageCall = { language: opts.language } as StageCall;

  let msPerChar: number | null = null;
  for (let i = 0; i < todo.length; i++) {
    const m = todo[i]!;
    const chapterText = readFileSync(m.chapterTextPath, 'utf8'); // as-is, no normalisation
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
      round: 1,
      wallClockMs,
    };
    const file = writeCaptureFile(scratch, record); // on disk BEFORE anything measures it (R6-5)
    if (deps.afterCapture) await deps.afterCapture(record, file);

    const sr = captured.structureReport;
    deps.log(
      `ch${m.chapterId}: alignedPct=${sr?.alignedPct ?? 'n/a'} flagOnly=${sr?.flagOnly ?? 'n/a'} wall=${fmtMs(wallClockMs)}`,
    );
    if (msPerChar === null && chapterText.length > 0) {
      msPerChar = wallClockMs / chapterText.length;
      const restChars = todo
        .slice(i + 1)
        .reduce((n, r) => n + readFileSync(r.chapterTextPath, 'utf8').length, 0);
      if (restChars > 0) {
        deps.log(`estimate for the remaining ${todo.length - 1 - i} chapter(s): ~${fmtMs(restChars * msPerChar)}`);
      }
    }
  }
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
  try {
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as ManifestEntry[];
    return await runCapture(
      { manifest, model, scratch, language: argValue(argv, '--language'), resume: argv.includes('--resume') },
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
