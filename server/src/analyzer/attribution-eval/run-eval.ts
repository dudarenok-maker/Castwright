import { scoreAttribution } from './scorer.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import { evidenceFamily } from './buckets.js';
import { attributeChapterStage2 } from '../../routes/analysis.js';
import type { SentenceOutput, Stage1Output } from '../../handoff/schemas.js';
import type { Analyzer } from '../index.js';
import type { StageCall } from '../index.js';

export interface StageScore {
  recall: number;
  precision: number;
  segMismatch: number;
  total: number;
  byFamily: Record<string, { correct: number; total: number }>;
}
export interface FixtureResult {
  fixture: string;
  raw: StageScore;
  deterministic: StageScore;
  final: StageScore;
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
  const byFamily: StageScore['byFamily'] = {};
  if (reasons) {
    // perLine[0..sentences.length-1] is in predicted (sentence) order, 1:1.
    for (let i = 0; i < sentences.length; i++) {
      const fam = evidenceFamily(reasons[i]?.reason ?? 'other');
      const line = s.perLine[i];
      byFamily[fam] ??= { correct: 0, total: 0 };
      byFamily[fam].total++;
      if (line?.correct) byFamily[fam].correct++;
    }
  }
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
