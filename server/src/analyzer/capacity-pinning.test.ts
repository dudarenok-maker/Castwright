/* #3084 wave 2 — chunk-budget PINNING lock (spec §6, regression plan 284
   invariant 5). Wave 2 moves every chunk-budget resolver from an engine name
   onto an EngineCapacity descriptor; budgets for today's engines must stay
   byte-identical. The expected values are CAPTURED ONCE from unmodified main
   (CAPACITY_PINNING_CAPTURE=1, which refuses to overwrite an existing
   fixture) — never computed by hand. Only computeBudget() may change when the
   resolver signatures change; the fixture file must not. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStage1ChunkCharBudget } from './stage1-chunk.js';
import { resolveStage2ChunkCharBudget } from './stage2-chunk.js';
import { chapterChunkBudget, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS } from './chapter-chunker.js';
import { countCyrillic } from './token-budget.js';
import { countCjkChars } from '../util/cjk.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import { resolveCapacity, type EngineCapacity } from './capacity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS = resolve(__dirname, '..', '__fixtures__');
const PIN_PATH = resolve(__dirname, '__fixtures__', 'capacity-pinning.json');

type EngineConfig = 'local-qwen3.5:4b@32768' | 'gemini-3.5-flash-lite@12000' | 'unset';
type Resolver =
  | 'stage1'
  | 'stage1+roster'
  | 'stage2'
  | 'chapter:defaults'
  | 'chapter:emotion-instruct'
  | 'chapter:script-review';
type ScriptId = 'latin' | 'cyrillic' | 'han' | 'kana';
interface PinCase {
  id: string;
  resolver: Resolver;
  engine: EngineConfig;
  script: ScriptId;
}

/* `unset` = the `undefined`-capacity path. Pinned ONLY if Step 1's caller grep
   found a production caller that passes no engine; then append 'unset' here
   before capturing. */
const ENGINES: EngineConfig[] = ['local-qwen3.5:4b@32768', 'gemini-3.5-flash-lite@12000'];
const RESOLVERS: Resolver[] = [
  'stage1',
  'stage1+roster',
  'stage2',
  'chapter:defaults',
  'chapter:emotion-instruct',
  'chapter:script-review',
];
const SCRIPT_FILES: Record<ScriptId, string> = {
  latin: 'the-coalfall-commission.md',
  cyrillic: 'the-coalfall-commission.ru.md',
  han: 'the-coalfall-commission.zh.md',
  kana: 'the-coalfall-commission.ja.md',
};

/* Chapter One's body: every line after the first `## ` heading up to the next
   `## ` heading. Split on \r?\n and re-joined with \n so a CRLF checkout pins
   the same values as an LF one. */
function chapterOne(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## '));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
}

const BODIES = Object.fromEntries(
  (Object.entries(SCRIPT_FILES) as Array<[ScriptId, string]>).map(([script, file]) => [
    script,
    chapterOne(readFileSync(resolve(MANUSCRIPTS, file), 'utf8')),
  ]),
) as Record<ScriptId, string>;

/* A 40-entry running roster in the compact shape stage-1's inbox renders. */
const ROSTER: CharacterOutput[] = Array.from({ length: 40 }, (_, i) => ({
  id: `character-${i}`,
  name: `Character Name ${i}`,
  role: 'supporting',
  color: '#ffffff',
}));

const CASES: PinCase[] = [];
for (const engine of ENGINES) {
  for (const resolver of RESOLVERS) {
    if (engine === 'unset' && resolver.startsWith('chapter:')) continue; // chapterChunkBudget requires an engine
    for (const script of Object.keys(SCRIPT_FILES) as ScriptId[]) {
      if (resolver === 'chapter:defaults' && script !== 'latin') continue; // takes no body
      CASES.push({ id: `${resolver}|${engine}|${script}`, resolver, engine, script });
    }
  }
}

/* ── The ONLY part of this file Task 2.3 changes. ─────────────────────────── */
function capacityArg(engine: EngineConfig): EngineCapacity | undefined {
  if (engine === 'unset') return undefined;
  return engine.startsWith('local')
    ? resolveCapacity({ engine: 'local', model: 'qwen3.5:4b' })
    : resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' });
}
function computeBudget(c: PinCase, body: string): number {
  const capacity = capacityArg(c.engine);
  switch (c.resolver) {
    case 'stage1':
      return resolveStage1ChunkCharBudget(capacity, body);
    case 'stage1+roster':
      return resolveStage1ChunkCharBudget(capacity, body, ROSTER);
    case 'stage2':
      return resolveStage2ChunkCharBudget(capacity, body);
    case 'chapter:defaults':
      return chapterChunkBudget(capacity!);
    case 'chapter:emotion-instruct':
      return chapterChunkBudget(capacity!, 0, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS);
    case 'chapter:script-review':
      return chapterChunkBudget(
        capacity!,
        JSON.stringify(ROSTER).length + 800,
        body,
        OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
      );
  }
}
/* ─────────────────────────────────────────────────────────────────────────── */

/* Every env var that feeds a pinned value. A developer's shell or server/.env
   must not leak into the comparison. */
const PINNED_ENV: Record<string, string | undefined> = {
  ANALYZER_NUM_CTX: '32768',
  ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST: '12000',
  STAGE1_CHUNK_CHAR_BUDGET: undefined,
  STAGE2_CHUNK_CHAR_BUDGET: undefined,
  ANALYZER_STAGE1_LOCAL_INPUT_FRACTION: undefined,
  ANALYZER_STAGE2_LOCAL_INPUT_FRACTION: undefined,
  ANALYZER_GEMINI_OUTPUT_HEAVY_CHUNK_CHARS: undefined,
  GEMINI_TPM_GEMINI_3_5_FLASH_LITE: undefined,
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [name, value] of Object.entries(PINNED_ENV)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface PinnedFile {
  capturedFrom: string;
  cases: Array<PinCase & { value: number }>;
}

describe('capacity pinning — chunk budgets stay byte-identical to main (#3084 wave 2)', () => {
  it('every resolver × engine × script equals the fixture captured from main', () => {
    const actual = CASES.map((c) => ({ ...c, value: computeBudget(c, BODIES[c.script]) }));
    if (process.env.CAPACITY_PINNING_CAPTURE === '1') {
      if (existsSync(PIN_PATH)) {
        throw new Error(
          `${PIN_PATH} already exists — pinning values are captured ONCE, from unmodified main. Never re-capture on a refactor branch.`,
        );
      }
      mkdirSync(dirname(PIN_PATH), { recursive: true });
      const file: PinnedFile = { capturedFrom: process.env.CAPACITY_PINNING_SHA ?? 'unknown', cases: actual };
      writeFileSync(PIN_PATH, `${JSON.stringify(file, null, 2)}\n`);
    }
    const pinned = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as PinnedFile;
    expect(actual).toEqual(pinned.cases);
  });

  it('the extracted bodies are real chapters in the intended scripts (a degenerate body would pin nothing)', () => {
    for (const [script, body] of Object.entries(BODIES)) expect(body.length, script).toBeGreaterThan(1000);
    expect(countCyrillic(BODIES.cyrillic) / BODIES.cyrillic.length).toBeGreaterThan(0.5);
    expect(countCjkChars(BODIES.han) / BODIES.han.length).toBeGreaterThan(0.5);
    expect(countCjkChars(BODIES.kana) / BODIES.kana.length).toBeGreaterThan(0.5);
  });

  it('the pinned cloud budgets are script-sensitive (proves the fixture exercises charsPerTokenForText)', () => {
    const pinned = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as PinnedFile;
    const value = (id: string): number => pinned.cases.find((c) => c.id === id)!.value;
    expect(value('stage1|gemini-3.5-flash-lite@12000|latin')).not.toBe(
      value('stage1|gemini-3.5-flash-lite@12000|cyrillic'),
    );
    expect(value('chapter:script-review|gemini-3.5-flash-lite@12000|latin')).not.toBe(
      value('chapter:script-review|gemini-3.5-flash-lite@12000|han'),
    );
  });
});
