import { scoreAttribution } from './scorer.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import { evidenceFamily } from './buckets.js';
import { attributeChapterStage2 } from '../../routes/analysis.js';
import type { SentenceOutput, Stage1Output } from '../../handoff/schemas.js';
import type { Analyzer } from '../index.js';
import type { StageCall } from '../index.js';

export interface FamilyBreakdown {
  correct: number;
  attributed: number;
  drift: number;
}

export interface StageScore {
  recall: number;
  precision: number;
  segMismatch: number;
  total: number;
  byFamily: Record<string, FamilyBreakdown>;
}
export interface FixtureResult {
  fixture: string;
  raw: StageScore;
  deterministic: StageScore;
  final: StageScore;
}

/** Per-evidence-family accuracy that EXCLUDES segmentation drift. `perLine[i]`
    (predicted/sentence order, 1:1 with `reasons[i]` for i < n) with
    `truth === null` is a drift line — the analyzer split an utterance
    differently than truth, so its attribution can't be scored — counted as
    `drift`, never `attributed`. */
export function familyBreakdown(
  perLine: Array<{ truth: string | null; correct: boolean }>,
  reasons: Array<{ reason: string }>,
  n: number,
): Record<string, FamilyBreakdown> {
  const out: Record<string, FamilyBreakdown> = {};
  for (let i = 0; i < n; i++) {
    const fam = evidenceFamily(reasons[i]?.reason ?? 'other');
    out[fam] ??= { correct: 0, attributed: 0, drift: 0 };
    const line = perLine[i];
    if (!line || line.truth === null) {
      out[fam].drift++;
      continue;
    }
    out[fam].attributed++;
    if (line.correct) out[fam].correct++;
  }
  return out;
}

export function rosterToStage1(roster: RosterSnapshot, chapterId: number): Stage1Output {
  return {
    characters: roster.characters.map((c) => ({
      id: c.id,
      name: c.name,
      role: 'character',
      color: '#888888',
      ...(c.gender ? { gender: c.gender } : {}),
      ...(c.aliases ? { aliases: c.aliases } : {}),
    })),
    chapters: [{ id: chapterId, title: `Chapter ${chapterId}` }],
  } as Stage1Output;
}

function toPredicted(sentences: SentenceOutput[]): Array<{ text: string; characterId: string }> {
  return sentences.map((s) => ({ text: s.text, characterId: s.characterId }));
}

function scoreStage(
  truth: LabelledChapter,
  sentences: SentenceOutput[],
  reasons?: Array<{ index: number; reason: string }>,
): StageScore {
  const s = scoreAttribution(truth, toPredicted(sentences));
  const total = s.truePositive + s.falseNegative;
  const byFamily: StageScore['byFamily'] = reasons
    ? familyBreakdown(s.perLine, reasons, sentences.length)
    : {};
  return {
    recall: s.recall,
    precision: s.precision,
    segMismatch: s.segMismatch,
    total,
    byFamily,
  };
}

export async function evalFixture(opts: {
  analyzer: Analyzer;
  escalationAnalyzer?: Analyzer | null;
  manuscriptId: string;
  title: string;
  truth: LabelledChapter;
  roster: RosterSnapshot;
  chapterId: number;
  stageCall: StageCall;
  fixtureName?: string;
}): Promise<FixtureResult> {
  const stage1 = rosterToStage1(opts.roster, opts.chapterId);
  let stages: {
    raw: SentenceOutput[];
    deterministic: SentenceOutput[];
    reasons: Array<{ index: number; reason: string; bucket: string }>;
  } | null = null;

  const result = await attributeChapterStage2({
    analyzer: opts.analyzer,
    manuscriptId: opts.manuscriptId,
    title: opts.title,
    stage1,
    chapter: { id: opts.chapterId, title: `Chapter ${opts.chapterId}`, body: opts.truth.chapterText },
    stageCall: opts.stageCall,
    escalationAnalyzer: opts.escalationAnalyzer ?? null,
    onStages: (s) => { stages = s; },
  }); // no `as never` — the opts object is fully typed, so `s` gets its proper type

  // `reasons` align 1:1 to the deterministic snapshot; reused for the final stage
  // because escalation changes ids on already-flagged lines but not the evidence class.
  const reasons = stages!.reasons;
  return {
    fixture: opts.fixtureName ?? `chapter-${opts.chapterId}`,
    raw: scoreStage(opts.truth, stages!.raw),
    deterministic: scoreStage(opts.truth, stages!.deterministic, reasons),
    final: scoreStage(opts.truth, result.sentences, reasons),
  };
}

export interface Stat {
  mean: number;
  min: number;
  max: number;
}

export interface StageAgg {
  recall: Stat;
  segDriftMean: number;
  total: number;
  byFamily: Record<string, { acc: Stat; sampleRuns: number; driftMean: number }>;
}

export interface FixtureAgg {
  fixture: string;
  runs: number;
  raw: StageAgg;
  deterministic: StageAgg;
  final: StageAgg;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stat(xs: number[]): Stat {
  if (xs.length === 0) return { mean: 0, min: 0, max: 0 };
  return { mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs) };
}

/** Average N per-run StageScores. Per-run RATIOS are averaged (recall directly;
    family accuracy = correct/attributed per run). A family absent in a run, or
    present with 0 attributed (all its lines drifted), contributes NO accuracy
    sample — `sampleRuns` records how many runs actually contributed one. */
export function aggStage(stages: StageScore[]): StageAgg {
  const fams = new Set<string>();
  for (const s of stages) for (const k of Object.keys(s.byFamily)) fams.add(k);

  const byFamily: StageAgg['byFamily'] = {};
  for (const fam of fams) {
    const accs: number[] = [];
    const drifts: number[] = [];
    for (const s of stages) {
      const b = s.byFamily[fam];
      if (!b) continue; // family absent this run → no sample of any kind
      drifts.push(b.drift);
      if (b.attributed > 0) accs.push(b.correct / b.attributed);
    }
    byFamily[fam] = { acc: stat(accs), sampleRuns: accs.length, driftMean: mean(drifts) };
  }

  return {
    recall: stat(stages.map((s) => s.recall)),
    segDriftMean: mean(stages.map((s) => s.segMismatch)),
    total: stages[0]?.total ?? 0,
    byFamily,
  };
}

/** Aggregate the N runs of ONE fixture (all same fixture name) into a FixtureAgg. */
export function aggregateFixture(runs: FixtureResult[]): FixtureAgg {
  return {
    fixture: runs[0].fixture,
    runs: runs.length,
    raw: aggStage(runs.map((r) => r.raw)),
    deterministic: aggStage(runs.map((r) => r.deterministic)),
    final: aggStage(runs.map((r) => r.final)),
  };
}
