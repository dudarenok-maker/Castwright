import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLabelledChapter, type LabelledChapter } from './schema.js';
import { parseRosterSnapshot, type RosterSnapshot } from './roster-schema.js';
import { evalFixture, type FixtureResult } from './run-eval.js';
import { OllamaAnalyzer } from '../ollama.js';
import { GeminiAnalyzer } from '../gemini.js';
import type { Analyzer } from '../index.js';

const DEFAULT_CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url));
const COMMITTED = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

// Fixture: <slug>-ch<NN>.<lang>.labelled.json ; roster (per book): <slug>.roster.json
const FIXTURE_RE = /^(.+)-ch(\d+)\.([a-z]{2})\.labelled\.json$/;

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
}): Promise<{ skipped: string | null; results: Array<{ engine: string; fixtures: FixtureResult[] }> }> {
  const corpus = await loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS);
  if (corpus.length === 0) {
    return { skipped: 'no corpus fixtures found', results: [] };
  }
  const all = [...corpus, ...(await loadDir(COMMITTED))]; // + committed Coalfall guardrail

  const results: Array<{ engine: string; fixtures: FixtureResult[] }> = [];
  for (const engine of opts.engines) {
    const analyzer = await buildAnalyzer(engine);
    if (!analyzer) return { skipped: `engine ${engine} unavailable (Ollama down / no GEMINI_API_KEY)`, results: [] };
    const fixtures: FixtureResult[] = [];
    for (const c of all) {
      fixtures.push(
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
    results.push({ engine, fixtures });
  }
  return { skipped: null, results };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printScorecard(results: Array<{ engine: string; fixtures: FixtureResult[] }>): void {
  for (const { engine, fixtures } of results) {
    console.log(`\n=== engine: ${engine} ===`);
    for (const f of fixtures) {
      console.log(
        `  ${f.fixture}: raw ${pct(f.raw.recall)} → det ${pct(f.deterministic.recall)} → final ${pct(f.final.recall)} (n=${f.final.total}, seg-drift ${f.final.segMismatch})`,
      );
      for (const fam of Object.keys(f.final.byFamily).sort()) {
        const b = f.final.byFamily[fam];
        const driftNote = b.drift > 0 ? ` (+${b.drift} drift)` : '';
        console.log(`      ${fam}: ${b.correct}/${b.attributed}${driftNote}`);
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

async function main(): Promise<void> {
  const { skipped, results } = await runEval({ engines: parseEngines(process.argv.slice(2)) });
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
