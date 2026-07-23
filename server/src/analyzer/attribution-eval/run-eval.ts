import { scoreAttribution } from './scorer.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import { evidenceFamily } from './buckets.js';
import { attributeChapterStage2 } from '../../routes/analysis.js';
import type { SentenceOutput, Stage1Output, ScriptReviewOp } from '../../handoff/schemas.js';
import type { Analyzer } from '../index.js';
import type { StageCall } from '../index.js';
import { runReviewOverChapter } from './review-run.js';
import { projectToChars } from './char-project.js';
import { scoreCharRecall, diffHelpedHarmed } from './char-score.js';
import { applyOpsToCharArray } from './apply-ops-chars.js';
import { normalizeForMatch } from './review-apply-core.js';
import { buildStructureEvidence } from '../dialogue-structure/evidence.js';
import { configValue } from '../../config/resolver.js';

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
/** Char-level score of the script-review (`reviewed`) stage for ONE run. The
    line stages score attribution by normalised TEXT; this scores char positions
    so a correct split/extract/reattribute op reads as an honest recall lift, not
    a segmentation regression. `opsByClass`/`dump` cover ALL ops (scored
    attribution ops + un-scored classes + off-roster `proposed` reattributes);
    `dump` is the un-scored subset, for human eyeballing. No `byFamily` here. */
export interface ReviewScore {
  charFinal: number;
  charReviewed: number;
  lineFinal: number;
  lineReviewed: number;
  helped: number;
  harmed: number;
  churn: number;
  predictedDropped: number;
  truthDropped: number;
  opsByClass: Record<string, number>;
  dump: Array<{ id: number; op: string; rationale: string; anchor?: string }>;
}

export interface FixtureResult {
  fixture: string;
  raw: StageScore;
  deterministic: StageScore;
  final: StageScore;
  reviewed?: ReviewScore;
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

/** Maps each character's `id → canonicalId`, ONLY for characters with one set —
    lets the scorer treat a duplicate roster id (e.g. `the_torment` ==
    `unknown-male`) as a true positive instead of a miss, without deleting the
    roster entry or touching the name index. */
export function rosterAliasMap(roster: RosterSnapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of roster.characters) if (c.canonicalId) m.set(c.id, c.canonicalId);
  return m;
}

// Exported for a focused unit test on the aliasMap threading into scoreAttribution
// (internal eval tooling, not part of the public analyzer surface).
export function scoreStage(
  truth: LabelledChapter,
  sentences: SentenceOutput[],
  reasons?: Array<{ index: number; reason: string }>,
  aliasMap?: Map<string, string>,
): StageScore {
  const s = scoreAttribution(truth, toPredicted(sentences), aliasMap);
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

/** An op is "scored" — i.e. reflected in the reviewed char array — only when
    it's an accepted char-affecting attribution op (mirrors applyOpsToCharArray:
    reattribute-with-id, split, extract_dialogue). Everything else (other
    classes, off-roster `proposed` reattributes) is un-scored → dumped. */
function isCharAffecting(op: ScriptReviewOp): boolean {
  if (op.op === 'reattribute') return op.characterId != null;
  return op.op === 'split' || op.op === 'extract_dialogue';
}

/** Pairs the projection's spans back to their source sentence ids so accepted
    ops (keyed by sentence id) can be applied. `projectToChars` walks sentences
    in order and emits a span only for a matched one, so a dropped sentence
    consumes no span — we advance the span pointer only when the current span's
    original slice normalises back to the sentence text. An op targeting a
    dropped (span-less) sentence then finds no span and is skipped by
    applyOpsToCharArray. */
function pairSpansToSentences(
  chapterText: string,
  sentences: SentenceOutput[],
  spans: Array<{ start: number; end: number; speakerId: string }>,
): Array<{ id: number; start: number; end: number }> {
  const out: Array<{ id: number; start: number; end: number }> = [];
  let j = 0;
  for (const s of sentences) {
    const sp = spans[j];
    if (sp && normalizeForMatch(chapterText.slice(sp.start, sp.end)) === normalizeForMatch(s.text)) {
      out.push({ id: s.id, start: sp.start, end: sp.end });
      j += 1;
    }
  }
  return out;
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
  review?: boolean;
  engine?: 'qwen' | 'gemma';
  language?: string;
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
  const aliasMap = rosterAliasMap(opts.roster);
  const base: FixtureResult = {
    fixture: opts.fixtureName ?? `chapter-${opts.chapterId}`,
    raw: scoreStage(opts.truth, stages!.raw, reasons, aliasMap),
    deterministic: scoreStage(opts.truth, stages!.deterministic, reasons, aliasMap),
    final: scoreStage(opts.truth, result.sentences, reasons, aliasMap),
  };

  // OPT-IN reviewed stage. Omitting `review` leaves base (raw/det/final) byte-identical.
  if (!opts.review) return base;

  const finalSentences = result.sentences;
  const chunkEngine = opts.engine === 'qwen' ? 'local' : 'gemini';

  // Roster carrying gender/aliases (no `role` — RosterSnapshot has no such field,
  // and production's stringified cast has no per-character role either; see
  // review-run.ts's `roster` param, typed `role?: string`) — the SAME object
  // feeds both the gemini chunk-budget (via JSON.stringify length inside
  // runReviewOverChapter) and the inbox, so eval chunk boundaries approximate
  // production's CastCharacterSlim.
  const reviewRoster = opts.roster.characters.map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.gender ? { gender: c.gender } : {}),
    ...(c.aliases ? { aliases: c.aliases } : {}),
  }));

  // Evidence — eval-native (NOT getOrHydrateManuscript, which has no body for the
  // synthetic eval manuscript). Gated on the SAME config key the route uses; the
  // full roster (gender/aliases) is what the structure builder needs.
  const evidence = configValue<boolean>('analyzer.structure.enabled')
    ? buildStructureEvidence(opts.truth.chapterText, finalSentences, opts.roster.characters, opts.language ?? 'en')
    : undefined;

  const { ops, accepted } = await runReviewOverChapter({
    analyzer: opts.analyzer,
    engine: chunkEngine,
    manuscriptId: opts.manuscriptId,
    chapterId: opts.chapterId,
    sentences: finalSentences,
    roster: reviewRoster,
    ...(opts.truth.priorExchange ? { priorExchange: opts.truth.priorExchange } : {}),
    evidence,
    call: opts.stageCall,
  });

  // char adapter: SentenceOutput.characterId → projectToChars's speakerId (precedent: toPredicted).
  // Truth lines are the corrected/re-segmented labels; the raw chapterText carries
  // inline `[...]` tags they don't, so strip tags from the truth basis to keep
  // tag-only-divergent truth lines in the recall denominator (tag positions stay
  // null → invisible to the metric). finalSentences derive from chapterText and
  // match verbatim, so the final projection needs no stripping and is unchanged.
  const truthProj = projectToChars(opts.truth.chapterText, opts.truth.lines, { stripTags: true });
  const finalProj = projectToChars(
    opts.truth.chapterText,
    finalSentences.map((s) => ({ text: s.text, speakerId: s.characterId })),
  );

  const finalSpans = pairSpansToSentences(opts.truth.chapterText, finalSentences, finalProj.spans);
  const reviewedByChar = applyOpsToCharArray(finalProj.speakerByChar, finalSentences, finalSpans, accepted);
  // scoreCharRecall reads only predicted.speakerByChar (spans/dropped unused for the predicted side).
  const reviewedProj = { speakerByChar: reviewedByChar, spans: finalProj.spans, dropped: finalProj.dropped };

  const finalScore = scoreCharRecall(truthProj, finalProj, aliasMap);
  const reviewedScore = scoreCharRecall(truthProj, reviewedProj, aliasMap);
  const { helped, harmed, churn } = diffHelpedHarmed(
    finalProj.speakerByChar,
    reviewedByChar,
    truthProj.speakerByChar,
    aliasMap,
  );

  const opsByClass: Record<string, number> = {};
  for (const op of ops) opsByClass[op.op] = (opsByClass[op.op] ?? 0) + 1;
  const scoredSet = new Set(accepted.filter(isCharAffecting));
  const dump = ops
    .filter((op) => !scoredSet.has(op))
    .map((op) => ({
      id: op.id,
      op: op.op,
      rationale: op.rationale,
      ...(op.anchor !== undefined ? { anchor: op.anchor } : {}),
    }));

  const reviewed: ReviewScore = {
    charFinal: finalScore.charRecall,
    charReviewed: reviewedScore.charRecall,
    lineFinal: finalScore.lineRecall,
    lineReviewed: reviewedScore.lineRecall,
    helped,
    harmed,
    churn,
    predictedDropped: finalProj.dropped,
    truthDropped: truthProj.dropped,
    opsByClass,
    dump,
  };
  return { ...base, reviewed };
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

/** Aggregate of the reviewed stage over N runs. Recalls/counts reuse stat()
    (mean/min/max); opsByClass is the mean count per class across runs; dump is
    representative (run-0's — dumps are illustrative, not aggregated). */
export interface ReviewAgg {
  charFinal: Stat;
  charReviewed: Stat;
  lineFinal: Stat;
  lineReviewed: Stat;
  helped: Stat;
  harmed: Stat;
  churn: Stat;
  predictedDropped: Stat;
  truthDropped: Stat;
  opsByClass: Record<string, number>;
  dump: ReviewScore['dump'];
}

export interface FixtureAgg {
  fixture: string;
  runs: number;
  raw: StageAgg;
  deterministic: StageAgg;
  final: StageAgg;
  reviewed?: ReviewAgg;
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

/** Average the per-run reviewed scores. Ratios/counts go through stat();
    opsByClass is the mean count per class across ALL runs (a class absent in a
    run counts as 0); dump is run-0's (representative, not aggregated). */
export function aggReview(scores: ReviewScore[]): ReviewAgg {
  const classes = new Set<string>();
  for (const s of scores) for (const k of Object.keys(s.opsByClass)) classes.add(k);
  const opsByClass: Record<string, number> = {};
  for (const cls of classes) opsByClass[cls] = mean(scores.map((s) => s.opsByClass[cls] ?? 0));

  return {
    charFinal: stat(scores.map((s) => s.charFinal)),
    charReviewed: stat(scores.map((s) => s.charReviewed)),
    lineFinal: stat(scores.map((s) => s.lineFinal)),
    lineReviewed: stat(scores.map((s) => s.lineReviewed)),
    helped: stat(scores.map((s) => s.helped)),
    harmed: stat(scores.map((s) => s.harmed)),
    churn: stat(scores.map((s) => s.churn)),
    predictedDropped: stat(scores.map((s) => s.predictedDropped)),
    truthDropped: stat(scores.map((s) => s.truthDropped)),
    opsByClass,
    dump: scores[0]?.dump ?? [],
  };
}

/** Aggregate the N runs of ONE fixture (all same fixture name) into a FixtureAgg. */
export function aggregateFixture(runs: FixtureResult[]): FixtureAgg {
  const reviewedScores = runs
    .map((r) => r.reviewed)
    .filter((r): r is ReviewScore => r !== undefined);
  return {
    fixture: runs[0].fixture,
    runs: runs.length,
    raw: aggStage(runs.map((r) => r.raw)),
    deterministic: aggStage(runs.map((r) => r.deterministic)),
    final: aggStage(runs.map((r) => r.final)),
    ...(reviewedScores.length > 0 ? { reviewed: aggReview(reviewedScores) } : {}),
  };
}
