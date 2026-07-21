import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLabelledChapter, type LabelledChapter } from './schema.js';
import { parseRosterSnapshot, type RosterSnapshot } from './roster-schema.js';
import { evalFixture, aggregateFixture, type FixtureResult, type FixtureAgg, type StageAgg } from './run-eval.js';
import { OllamaAnalyzer } from '../ollama.js';
import { GeminiAnalyzer } from '../gemini.js';
import type { Analyzer } from '../index.js';

const DEFAULT_CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url));
const COMMITTED = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

// Fixture: <slug>-ch<NN>.<lang>.labelled.json ; roster (per book): <slug>.roster.json
const FIXTURE_RE = /^(.+)-ch(\d+)\.([a-z]{2})\.labelled\.json$/;

export function slotLabel(engine: 'qwen' | 'gemma'): string {
  if (engine === 'qwen') return `qwen:${process.env.EVAL_QWEN_MODEL ?? 'qwen3.5:9b'}`;
  return `gemma:${process.env.GEMINI_MODEL ?? 'gemma-4-31b-it'}`;
}

interface CorpusItem {
  name: string;
  truth: LabelledChapter;
  roster: RosterSnapshot;
  chapterId: number;
  lang: string;
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
    const m = FIXTURE_RE.exec(f);
    if (!m) continue;
    const [, slug, chap, lang] = m;
    const truth = parseLabelledChapter(JSON.parse(await readFile(join(dir, f), 'utf8')));
    const roster = parseRosterSnapshot(JSON.parse(await readFile(join(dir, `${slug}.roster.json`), 'utf8')));
    out.push({ name: f, truth, roster, chapterId: Number(chap), lang });
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

export async function runEval(opts: {
  engines: Array<'qwen' | 'gemma'>;
  corpusDir?: string;
  runs?: number;
}): Promise<{ skipped: string | null; runs: number; results: Array<{ engine: string; fixtures: FixtureAgg[] }> }> {
  const runs = Math.max(1, opts.runs ?? 1);
  const corpus = await loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS);
  if (corpus.length === 0) {
    return { skipped: 'no corpus fixtures found', runs, results: [] };
  }
  const all = [...corpus, ...(await loadDir(COMMITTED))]; // + committed Coalfall guardrail

  const results: Array<{ engine: string; fixtures: FixtureAgg[] }> = [];
  for (const engine of opts.engines) {
    const analyzer = await buildAnalyzer(engine);
    if (!analyzer) return { skipped: `engine ${engine} unavailable (Ollama down / no GEMINI_API_KEY)`, runs, results: [] };
    const fixtures: FixtureAgg[] = [];
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
          }),
        );
      }
      fixtures.push(aggregateFixture(perRun));
    }
    results.push({ engine: slotLabel(engine), fixtures });
  }
  return { skipped: null, runs, results };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const range = (s: StageAgg['recall'], runs: number) =>
  runs > 1 ? `${pct(s.mean)} [${pct(s.min)}–${pct(s.max)}]` : pct(s.mean);

function famLine(b: StageAgg['byFamily'][string], runs: number): string {
  if (b.sampleRuns === 0) return `— (drift only, ${b.driftMean.toFixed(1)} avg)`;
  const acc = runs > 1 ? `${pct(b.acc.mean)} [${pct(b.acc.min)}–${pct(b.acc.max)}]` : pct(b.acc.mean);
  const driftNote = b.driftMean > 0 ? ` (+${b.driftMean.toFixed(1)} drift)` : '';
  return `${acc} over ${b.sampleRuns} run${b.sampleRuns === 1 ? '' : 's'}${driftNote}`;
}

function printScorecard(results: Array<{ engine: string; fixtures: FixtureAgg[] }>): void {
  for (const { engine, fixtures } of results) {
    console.log(`\n=== engine: ${engine} ===`);
    for (const f of fixtures) {
      console.log(
        `  ${f.fixture}: raw ${range(f.raw.recall, f.runs)} → det ${range(f.deterministic.recall, f.runs)} → final ${range(f.final.recall, f.runs)} (n=${f.final.total}, drift ${f.final.segDriftMean.toFixed(0)}, runs=${f.runs})`,
      );
      for (const fam of Object.keys(f.final.byFamily).sort()) {
        console.log(`      ${fam}: ${famLine(f.final.byFamily[fam], f.runs)}`);
      }
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { skipped, results } = await runEval({ engines: parseEngines(argv), runs: parseRuns(argv) });
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
