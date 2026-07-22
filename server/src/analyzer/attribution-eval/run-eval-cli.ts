import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLabelledChapter, type LabelledChapter } from './schema.js';
import { parseRosterSnapshot, type RosterSnapshot } from './roster-schema.js';
import {
  evalFixture,
  aggregateFixture,
  type FixtureResult,
  type FixtureAgg,
  type StageAgg,
  type ReviewAgg,
  type Stat,
} from './run-eval.js';
import { OllamaAnalyzer } from '../ollama.js';
import { GeminiAnalyzer } from '../gemini.js';
import type { Analyzer } from '../index.js';

const DEFAULT_CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url));
const COMMITTED = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

// Fixture: <slug>-ch<NN>.<lang>(.silver)?.labelled.json ; roster (per book): <slug>.roster.json
// The optional `.silver` segment tags a fixture as directional (not gating) —
// see `parseFixtureFilename`/`partitionByTier`.
const FIXTURE_RE = /^(.+)-ch(\d+)\.([a-z]{2})(\.silver)?\.labelled\.json$/;

export function slotLabel(engine: 'qwen' | 'gemma'): string {
  if (engine === 'qwen') return `qwen:${process.env.EVAL_QWEN_MODEL ?? 'qwen3.5:9b'}`;
  return `gemma:${process.env.GEMINI_MODEL ?? 'gemma-4-31b-it'}`;
}

/** Pure — no filesystem access. Parses a fixture filename into its slug/
    chapter/lang/tier. Returns null for anything that doesn't match
    `FIXTURE_RE` (e.g. a `.roster.json` sidecar). `tier` is 'silver' only when
    the optional `.silver` segment is present; otherwise 'gold' — so the
    committed Coalfall guardrail (`coalfall-ch1.en.labelled.json`, no
    `.silver` segment) is 'gold' with no special-casing needed. */
export function parseFixtureFilename(
  name: string,
): { slug: string; chapterId: number; lang: string; tier: 'gold' | 'silver' } | null {
  const m = FIXTURE_RE.exec(name);
  if (!m) return null;
  const [, slug, chap, lang, silverFlag] = m;
  return { slug, chapterId: Number(chap), lang, tier: silverFlag ? 'silver' : 'gold' };
}

interface CorpusItem {
  name: string;
  truth: LabelledChapter;
  roster: RosterSnapshot;
  chapterId: number;
  lang: string;
  tier: 'gold' | 'silver';
}

async function loadDir(dir: string): Promise<CorpusItem[]> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: CorpusItem[] = [];
  for (const f of files) {
    const parsed = parseFixtureFilename(f);
    if (!parsed) continue;
    const { slug, chapterId, lang, tier } = parsed;
    const truth = parseLabelledChapter(JSON.parse(await readFile(join(dir, f), 'utf8')));
    const roster = parseRosterSnapshot(JSON.parse(await readFile(join(dir, `${slug}.roster.json`), 'utf8')));
    out.push({ name: f, truth, roster, chapterId, lang, tier });
  }
  return out;
}

export async function loadCorpus(dir: string): Promise<CorpusItem[]> {
  return loadDir(dir);
}

async function buildAnalyzer(engine: 'qwen' | 'gemma'): Promise<Analyzer | null> {
  if (engine === 'qwen') {
    const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
    } catch {
      return null;
    }
    return new OllamaAnalyzer({ url, model: process.env.EVAL_QWEN_MODEL ?? 'qwen3.5:9b' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GeminiAnalyzer({ apiKey, model: process.env.GEMINI_MODEL ?? 'gemma-4-31b-it' });
}

/** A FixtureAgg tagged with its corpus tier, for the CLI's gold/silver
    partition. Kept as a CLI-local intersection type rather than a change to
    `FixtureAgg` itself — the eval core (run-eval.ts) has no notion of tiers. */
export type ScoredFixture = FixtureAgg & { tier: 'gold' | 'silver' };

export async function runEval(opts: {
  engines: Array<'qwen' | 'gemma'>;
  corpusDir?: string;
  runs?: number;
  review?: boolean;
}): Promise<{ skipped: string | null; runs: number; results: Array<{ engine: string; fixtures: ScoredFixture[] }> }> {
  const runs = Math.max(1, opts.runs ?? 1);
  const corpus = await loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS);
  if (corpus.length === 0) {
    return { skipped: 'no corpus fixtures found', runs, results: [] };
  }
  const all = [...corpus, ...(await loadDir(COMMITTED))]; // + committed Coalfall guardrail

  const results: Array<{ engine: string; fixtures: ScoredFixture[] }> = [];
  for (const engine of opts.engines) {
    const analyzer = await buildAnalyzer(engine);
    if (!analyzer) return { skipped: `engine ${engine} unavailable (Ollama down / no GEMINI_API_KEY)`, runs, results: [] };
    const fixtures: ScoredFixture[] = [];
    for (const c of all) {
      const perRun: FixtureResult[] = [];
      for (let i = 0; i < runs; i++) {
        perRun.push(
          await evalFixture({
            analyzer,
            manuscriptId: `eval-${c.name}`,
            title: c.name,
            truth: c.truth,
            roster: c.roster,
            chapterId: c.chapterId,
            stageCall: { language: c.lang } as never,
            fixtureName: c.name,
            review: opts.review,
            engine,
            language: c.lang,
          }),
        );
      }
      fixtures.push({ ...aggregateFixture(perRun), tier: c.tier });
    }
    results.push({ engine: slotLabel(engine), fixtures });
  }
  return { skipped: null, runs, results };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const range = (s: Stat, runs: number) =>
  runs > 1 ? `${pct(s.mean)} [${pct(s.min)}–${pct(s.max)}]` : pct(s.mean);
// Line-level ratios get an `l%` suffix (vs. char-level `%`) so the two scales
// in `formatReviewLine`'s combined line aren't confused for each other.
const lrange = (s: Stat, runs: number) => {
  const fmt = (n: number) => `${(n * 100).toFixed(1)}l%`;
  return runs > 1 ? `${fmt(s.mean)} [${fmt(s.min)}–${fmt(s.max)}]` : fmt(s.mean);
};
// Counts (helped/harmed/churn/predictedDropped) — whole numbers print bare;
// a fractional mean (runs>1 averaging different per-run integer counts) gets
// one decimal.
const countFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const crange = (s: Stat, runs: number) =>
  runs > 1 ? `${countFmt(s.mean)} [${countFmt(s.min)}–${countFmt(s.max)}]` : countFmt(s.mean);

function famLine(b: StageAgg['byFamily'][string], runs: number): string {
  if (b.sampleRuns === 0) return `— (drift only, ${b.driftMean.toFixed(1)} avg)`;
  const acc = runs > 1 ? `${pct(b.acc.mean)} [${pct(b.acc.min)}–${pct(b.acc.max)}]` : pct(b.acc.mean);
  const driftNote = b.driftMean > 0 ? ` (+${b.driftMean.toFixed(1)} drift)` : '';
  return `${acc} over ${b.sampleRuns} run${b.sampleRuns === 1 ? '' : 's'}${driftNote}`;
}

/** Pure — renders the reviewed-stage char/line summary line for one fixture's
    ReviewAgg, plus (when applicable) the coverage-health warning. Ranges
    (`[min–max]`) are shown only when `runs > 1`; a single run just prints the
    mean. `predictedDropped.mean > 0` means some truth-aligned char span in
    the FINAL projection couldn't be matched back to a sentence span (see
    `pairSpansToSentences` in run-eval.ts) — reviewed char coverage over that
    fixture is therefore incomplete, not necessarily wrong. */
export function formatReviewLine(agg: ReviewAgg, runs: number): string {
  const deltaPct = (agg.charReviewed.mean - agg.charFinal.mean) * 100;
  const delta = `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}pp`;
  let line =
    `final(char) ${range(agg.charFinal, runs)} → reviewed(char) ${range(agg.charReviewed, runs)} ` +
    `(Δ ${delta} | line ${lrange(agg.lineFinal, runs)}→${lrange(agg.lineReviewed, runs)} | ` +
    `helped ${crange(agg.helped, runs)} harmed ${crange(agg.harmed, runs)} churn ${crange(agg.churn, runs)})`;
  if (agg.predictedDropped.mean > 0) {
    line += `\n      ⚠ ${countFmt(agg.predictedDropped.mean)} predicted units unlocated — char coverage incomplete`;
  }
  return line;
}

/** Pure — splits a corpus-ordered fixture list into gold (including the
    committed Coalfall guardrail, which is untagged → 'gold') vs. silver,
    preserving each partition's relative order. Silver fixtures are
    directional signal only — never gating. */
export function partitionByTier<T extends { tier: 'gold' | 'silver' }>(
  fixtures: T[],
): { gold: T[]; silver: T[] } {
  return {
    gold: fixtures.filter((f) => f.tier === 'gold'),
    silver: fixtures.filter((f) => f.tier === 'silver'),
  };
}

function printFixtureBlock(f: ScoredFixture, marker: string): void {
  console.log(
    `  ${f.fixture}${marker}: raw ${range(f.raw.recall, f.runs)} → det ${range(f.deterministic.recall, f.runs)} → final ${range(f.final.recall, f.runs)} (n=${f.final.total}, drift ${f.final.segDriftMean.toFixed(0)}, runs=${f.runs})`,
  );
  for (const fam of Object.keys(f.raw.byFamily).sort()) {
    console.log(`      raw · ${fam}: ${famLine(f.raw.byFamily[fam], f.runs)}`);
  }
  for (const fam of Object.keys(f.final.byFamily).sort()) {
    console.log(`      ${fam}: ${famLine(f.final.byFamily[fam], f.runs)}`);
  }
  if (!f.reviewed) return;
  console.log(`      ${formatReviewLine(f.reviewed, f.runs)}`);
  const classes = Object.keys(f.reviewed.opsByClass).sort();
  if (classes.length > 0) {
    const byClass = classes.map((c) => `${c}=${f.reviewed!.opsByClass[c].toFixed(1)}`).join(', ');
    console.log(`      ops by class: ${byClass}`);
  }
  if (f.reviewed.dump.length > 0) {
    // NOTE: this dump is the un-scored op classes + off-roster reattributes —
    // NOT an exhaustive list of ops that changed nothing. A split/extract that
    // passed planApply but was silently no-op'd by applyOpsToCharArray's
    // defensive guards is counted as "scored" and won't appear here.
    console.log(`      op-dump (un-scored ops, illustrative):`);
    for (const d of f.reviewed.dump) {
      const anchor = d.anchor !== undefined ? ` (anchor: ${d.anchor})` : '';
      console.log(`        #${d.id} ${d.op} — ${d.rationale}${anchor}`);
    }
  }
}

function printScorecard(results: Array<{ engine: string; fixtures: ScoredFixture[] }>): void {
  for (const { engine, fixtures } of results) {
    console.log(`\n=== engine: ${engine} ===`);
    const { gold, silver } = partitionByTier(fixtures);
    for (const f of gold) printFixtureBlock(f, '');
    if (silver.length > 0) {
      console.log(`  --- silver (directional, not gating) ---`);
      for (const f of silver) printFixtureBlock(f, ' [directional]');
    }
  }
}

function parseEngines(argv: string[]): Array<'qwen' | 'gemma'> {
  const i = argv.indexOf('--engine');
  const v = i >= 0 ? argv[i + 1] : 'both';
  if (v === 'qwen') return ['qwen'];
  if (v === 'gemma') return ['gemma'];
  return ['qwen', 'gemma'];
}

function parseRuns(argv: string[]): number {
  const i = argv.indexOf('--runs');
  const fromArg = i >= 0 ? Number(argv[i + 1]) : NaN;
  const fromEnv = Number(process.env.EVAL_RUNS);
  const n = Number.isFinite(fromArg) ? fromArg : Number.isFinite(fromEnv) ? fromEnv : 1;
  return Math.max(1, Math.floor(n));
}

function parseReview(argv: string[]): boolean {
  if (argv.includes('--review')) return true;
  const v = process.env.EVAL_REVIEW;
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { skipped, results } = await runEval({
    engines: parseEngines(argv),
    runs: parseRuns(argv),
    review: parseReview(argv),
  });
  if (skipped) {
    console.log(`[SKIP] attribution eval: ${skipped}`);
    process.exit(0);
  }
  printScorecard(results);
}

// Run only when invoked directly (not when imported by tests). Normalise both
// sides with resolve() — a bare string compare is Windows-brittle (drive-letter
// casing / slash direction), matching the repo precedent (capture-cli.ts).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
