# Attribution deterministic tuning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the deterministic + escalation post-processing from degrading attribution below the raw LLM on the strong model — recover the ch46 (−12.8) and Coalfall (−3.5) escalation losses and the ch44 (−3.0) crossExamine loss — while never silently losing a place a layer currently helps (ch45).

**Architecture:** Three independently-shippable waves. **Wave 1** makes the attribution-eval harness honest (drift excluded from per-family accuracy) and variance-aware (`--runs N` averaging), so the later waves can be measured against noise. **Wave 2** (primary) makes escalation *resolve, not override*: it may fill a genuinely-unresolved placeholder line but must never overwrite a committed named answer with a context-starved re-ask (E-core), and grounds the re-ask with high-confidence neighbour anchors (E1). **Wave 3** (secondary) marks a `tag-name` minted from a beat-only quote-paragraph narration gap as **weak**, so a weak tag that disagrees with the model *flags* instead of force-correcting (A1/A2).

**Tech Stack:** TypeScript (server, Node 20 ESM, `.js` import specifiers), Vitest (server harness, `node` env), the `castwright-server` analyzer pipeline (`server/src/analyzer/dialogue-structure/**` and `server/src/analyzer/attribution-eval/**`).

## Global Constraints

- **Source of truth:** `docs/superpowers/specs/2026-07-21-attribution-deterministic-tuning-design.md` (v3). Every task traces to a spec section; where they disagree, the spec governs — surface the conflict, don't silently deviate.
- **Every code change ships a paired unit test** (fails before / passes after). The averaged eval scorecard is the integration measure, NOT a substitute for unit tests.
- **TypeScript ESM:** relative imports carry the `.js` extension (`./buckets.js`), matching every file in these directories. Server tests run under Vitest `node` env, colocated as `*.test.ts`.
- **`tag-name`-never-overridden stays a hard invariant for a *strong* tag.** Wave 3 introduces a `strength: 'weak'` sub-case; only a weak tag becomes overridable. A tag-name with no `strength` is strong and immutable, exactly as today.
- **No new plumbing into escalation.** Wave 2 works from data already passed to `escalateFlaggedWindows` — `opts.flags[].reason`, `opts.sentences[].characterId/confidence`, and the re-derived alignment. Do not thread new parameters through `attributeChapterStage2`.
- **`strength` is `strength?: 'weak'`** (absence = strong) — an OPTIONAL field on `SpanEvidence.speaker`, NOT a new `EvidenceSource` union member. The `cross-examine.ts` exhaustiveness tripwire (`const _exhaustive: never = source`) must remain compiling and untouched.
- **Escalation runs on every book/language in `'local'` mode** (`analyzer.structure.escalation` default `'local'`). The committed Coalfall guardrail fixture + `escalation.test.ts` bound the blast radius — both must stay green.
- **Measurement command (final acceptance, on-box):** `EVAL_QWEN_MODEL=qwen36-cw-iq4-32k:latest WORKSPACE_DIR=C:/AudiobookWorkspace npm run eval:attribution -- --engine qwen --runs 3`, mean over ≥3 runs. Sub-noise (±2–3%) single-run deltas are not evidence.

---

## File Structure

- `server/src/analyzer/attribution-eval/run-eval.ts` — Wave 1: `familyBreakdown` (new export) rewrites per-family scoring to `correct/attributed/drift`; `StageScore.byFamily` type change; `aggStage`/`aggregateFixture` (+ `StageAgg`/`FixtureAgg` types) for multi-run averaging.
- `server/src/analyzer/attribution-eval/run-eval-cli.ts` — Wave 1: `runEval` gains `runs`; `main` parses `--runs`/`EVAL_RUNS`; `printScorecard` consumes the aggregate and prints mean±range.
- `server/src/analyzer/attribution-eval/run-eval.test.ts` — Wave 1 unit tests: `familyBreakdown` (known-drift line), `aggStage` (missing-family case).
- `server/src/analyzer/dialogue-structure/escalation.ts` — Wave 2: E-core fill-eligibility gate in the apply loop; E1 confident-neighbour context in `buildWindowText`; thread weak strength through the `hasTagName` guard (Wave 3 A2).
- `server/src/analyzer/dialogue-structure/escalation.test.ts` — Wave 2 unit tests: E-core (named answer protected, placeholder filled); E1 (confident neighbour labeled, low-confidence suppressed).
- `server/src/analyzer/dialogue-structure/types.ts` — Wave 3 A1: `speaker.strength?: 'weak'`.
- `server/src/analyzer/dialogue-structure/parser.ts` — Wave 3 A1: mark a beat-only quote-gap narration→tag reclassification as weak; stamp `strength: 'weak'` when anchoring it.
- `server/src/analyzer/dialogue-structure/cross-examine.ts` — Wave 3 A2: weak-tag disagreement keeps model id + flags (`tag-weak-keep-flag`), new `CONFIDENCE.TAG_WEAK_KEEP_FLAG`.
- `server/src/analyzer/dialogue-structure/parser.test.ts`, `cross-examine.test.ts` — Wave 3 unit tests.

---

## Task 1: Wave 1 — per-family honesty (drift excluded from accuracy)

Spec §5.1. `scoreStage.byFamily` today counts a drift line (segmentation split; `perLine[i].truth === null`) in a family's `total` but never its `correct`, so a family's accuracy is silently deflated by drift. Report each family as **`correct / attributed / drift`**, drift excluded from the accuracy denominator.

**Files:**
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts`
- Modify: `server/src/analyzer/attribution-eval/run-eval-cli.ts:107-110` (`printScorecard` family line)
- Test: `server/src/analyzer/attribution-eval/run-eval.test.ts`

**Interfaces:**
- Consumes: `evidenceFamily` (`./buckets.js`), `scoreAttribution` (`./scorer.js`, `perLine[i].truth === null` marks a drift line).
- Produces: `export interface FamilyBreakdown { correct: number; attributed: number; drift: number }`; `export function familyBreakdown(perLine, reasons, n): Record<string, FamilyBreakdown>`; `StageScore.byFamily: Record<string, FamilyBreakdown>` (consumed by Task 2's `aggStage`).

- [ ] **Step 1: Write the failing test**

Add to `run-eval.test.ts`:

```ts
import { familyBreakdown } from './run-eval.js';

describe('familyBreakdown', () => {
  it('excludes a drift line (truth === null) from attributed, counts it as drift', () => {
    // 3 tag lines: one correct, one wrong, one drift (segmentation split).
    const perLine = [
      { truth: 'alice', correct: true },
      { truth: 'bob', correct: false },
      { truth: null, correct: false },
    ];
    const reasons = [
      { reason: 'tag-confirm:alice' },
      { reason: 'tag-correct:bob' },
      { reason: 'tag-confirm:alice' },
    ];
    const fam = familyBreakdown(perLine, reasons, 3);
    expect(fam.tag).toEqual({ correct: 1, attributed: 2, drift: 1 });
  });

  it('buckets by evidence family and tolerates a missing reason (→ other)', () => {
    const perLine = [{ truth: 'x', correct: true }, { truth: 'y', correct: true }];
    const reasons = [{ reason: 'unanchored-narrator' }];
    const fam = familyBreakdown(perLine, reasons, 2);
    expect(fam.unanchored).toEqual({ correct: 1, attributed: 1, drift: 0 });
    expect(fam.other).toEqual({ correct: 1, attributed: 1, drift: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts -t familyBreakdown`
Expected: FAIL — `familyBreakdown` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `run-eval.ts`, change the `StageScore` interface's `byFamily` type and add the exported helper + `FamilyBreakdown`. Replace the `byFamily` accumulation inside `scoreStage`.

```ts
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
```

Then in `scoreStage`, replace the `if (reasons) { ... }` block that builds `byFamily` with:

```ts
  const byFamily: StageScore['byFamily'] = reasons
    ? familyBreakdown(s.perLine, reasons, sentences.length)
    : {};
```

- [ ] **Step 4: Update `printScorecard`**

In `run-eval-cli.ts`, replace the family loop body (currently `${fam}: ${b.correct}/${b.total}`):

```ts
      for (const fam of Object.keys(f.final.byFamily).sort()) {
        const b = f.final.byFamily[fam];
        const driftNote = b.drift > 0 ? ` (+${b.drift} drift)` : '';
        console.log(`      ${fam}: ${b.correct}/${b.attributed}${driftNote}`);
      }
```

(Task 2 rewrites this whole function for aggregates; this interim edit keeps `run-eval-cli.ts` compiling against the new `byFamily` type in the meantime.)

- [ ] **Step 5: Run the test to verify it passes + typecheck**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts && npm run -s typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/attribution-eval/run-eval.ts server/src/analyzer/attribution-eval/run-eval-cli.ts server/src/analyzer/attribution-eval/run-eval.test.ts
git commit -m "feat(server): attribution-eval per-family accuracy excludes segmentation drift"
```

---

## Task 2: Wave 1 — multi-run averaging (`--runs N`)

Spec §5.1. raw stage-2 is non-deterministic (±2–3% run-to-run). Add `--runs N` (env `EVAL_RUNS`): each fixture runs N times per engine; report **mean and range** per stage and per family, averaging **per-run ratios** (not pooled counts — denominators shift run-to-run under drift). A family absent in a run contributes NO sample (not a zero). Default N=1; acceptance uses N≥3.

**Files:**
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts` (aggregation helpers + types)
- Modify: `server/src/analyzer/attribution-eval/run-eval-cli.ts` (`runEval` gains `runs`; `main` parses `--runs`/`EVAL_RUNS`; `printScorecard` rewritten for aggregates)
- Test: `server/src/analyzer/attribution-eval/run-eval.test.ts`

**Interfaces:**
- Consumes: `StageScore` / `FamilyBreakdown` (Task 1), `evalFixture` (unchanged, one run → one `FixtureResult`).
- Produces: `StageAgg`, `FixtureAgg`, `aggStage(stages: StageScore[]): StageAgg`, `aggregateFixture(runs: FixtureResult[]): FixtureAgg`. `runEval` returns `results: Array<{ engine: string; fixtures: FixtureAgg[] }>` and `runs: number`.

- [ ] **Step 1: Write the failing test**

Add to `run-eval.test.ts`:

```ts
import { aggStage, type StageScore } from './run-eval.js';

const mkStage = (recall: number, byFamily: StageScore['byFamily'], seg = 0): StageScore => ({
  recall, precision: 1, segMismatch: seg, total: 10, byFamily,
});

describe('aggStage (multi-run averaging)', () => {
  it('averages per-run recall and reports the range', () => {
    const agg = aggStage([mkStage(0.60, {}), mkStage(0.66, {}), mkStage(0.63, {})]);
    expect(agg.recall.mean).toBeCloseTo(0.63);
    expect(agg.recall.min).toBeCloseTo(0.60);
    expect(agg.recall.max).toBeCloseTo(0.66);
  });

  it('averages per-run family accuracy; a family absent in a run contributes NO sample', () => {
    // Run 1: tag 1/2. Run 2: tag has no lines at all (family absent).
    const agg = aggStage([
      mkStage(0.5, { tag: { correct: 1, attributed: 2, drift: 0 } }),
      mkStage(0.5, {}),
    ]);
    // mean over the ONE run that had tag samples = 0.5, from 1 sampling run (not 0.25 over 2).
    expect(agg.byFamily.tag.acc.mean).toBeCloseTo(0.5);
    expect(agg.byFamily.tag.sampleRuns).toBe(1);
  });

  it('a family present but with 0 attributed (all drift) contributes NO accuracy sample', () => {
    const agg = aggStage([mkStage(0.5, { tag: { correct: 0, attributed: 0, drift: 3 } })]);
    expect(agg.byFamily.tag.sampleRuns).toBe(0);
    expect(agg.byFamily.tag.driftMean).toBeCloseTo(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts -t aggStage`
Expected: FAIL — `aggStage` is not exported.

- [ ] **Step 3: Write the aggregation helpers**

Append to `run-eval.ts`:

```ts
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
```

- [ ] **Step 4: Run the reducer test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts -t aggStage`
Expected: PASS.

- [ ] **Step 5: Wire `runs` through `runEval` and `main`, rewrite `printScorecard`**

In `run-eval-cli.ts`:

Import the new symbols:

```ts
import { evalFixture, aggregateFixture, type FixtureResult, type FixtureAgg, type StageAgg } from './run-eval.js';
```

Change `runEval`'s signature and body (the per-fixture loop now runs N times and aggregates):

```ts
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
    results.push({ engine, fixtures });
  }
  return { skipped: null, runs, results };
}
```

Rewrite `printScorecard` to consume aggregates. `range()` prints `[min–max]` only when N>1 and the range is non-trivial:

```ts
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
```

Add `--runs`/`EVAL_RUNS` parsing and pass it through `main`:

```ts
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
```

- [ ] **Step 6: Run the full harness suite + typecheck**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/ && npm run -s typecheck`
Expected: PASS (incl. the existing `runEval gating` SKIP test — `res.skipped` is still present). Typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/attribution-eval/run-eval.ts server/src/analyzer/attribution-eval/run-eval-cli.ts server/src/analyzer/attribution-eval/run-eval.test.ts
git commit -m "feat(server): attribution-eval --runs N multi-run mean/range averaging"
```

---

## Task 3: Wave 2 E-core — resolve, not override (PRIMARY)

Spec §5.2. Escalation may **fill** a genuinely-unresolved placeholder line (`unanchored-narrator`) but must **never overwrite a named answer** — `unanchored-named:*` or the structurally-contested `pronoun-keep-flag:*` / `alt-keep-flag:*` classes — with a bare re-ask. This alone is expected to recover ch46 (all 8 det→final losses were `unanchored-named:stephanie-edgley` overwritten) and Coalfall. The existing `tag-name`-never-override guard stays.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/escalation.ts` (apply loop, ~223-239)
- Test: `server/src/analyzer/dialogue-structure/escalation.test.ts`

**Interfaces:**
- Consumes: `opts.flags[].reason` (already passed; the crossExamine decision provenance), `opts.rosterIds`.
- Produces: no signature change. A new module-private `isFillEligible(reason: string): boolean`.

- [ ] **Step 1: Write the failing test**

The existing fixture flags both unanchored lines as `unanchored-narrator`. Add a variant where one flagged line is `unanchored-named` and pin that E-core protects it while still filling the placeholder. Add to `escalation.test.ts` (reuses the imports already at the top of the file):

```ts
/** Same body/paras as buildFixture, but sentence id 4 (index 3) carries a
    NAMED model id ('anton') on its unanchored line → crossExamine flags it
    `unanchored-named:anton`. Sentence id 5 stays 'narrator' →
    `unanchored-narrator`. Lets us pin E-core: the named line is protected,
    the placeholder line is filled. */
function buildNamedFixture() {
  const enIdx = buildNameIndex(
    [
      { id: 'anton', name: 'Anton' },
      { id: 'olga', name: 'Olga' },
      { id: 'boris', name: 'Boris' },
    ],
    conventionsFor('en')!,
  );
  const body = [
    'He waited quietly.',
    '"Ready?" said Anton.',
    '"Ready," said Olga.',
    '"Confirmed," said Boris.',
    '"Then let\'s go."',
    '"After you."',
    'She smiled and walked ahead.',
  ].join('\n');
  const paras = parseChapterStructure(body, enIdx);
  resolveWindows(paras, { anton: 'male', olga: 'female', boris: 'male' }, null);
  const sentences: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'anton', text: 'Ready?' },
    { id: 2, chapterId: 1, characterId: 'olga', text: 'Ready,' },
    { id: 3, chapterId: 1, characterId: 'boris', text: 'Confirmed,' },
    { id: 4, chapterId: 1, characterId: 'anton', text: "Then let's go." }, // NAMED guess
    { id: 5, chapterId: 1, characterId: 'narrator', text: 'After you.' }, // placeholder
  ];
  const alignment = alignSentences(sentences, paras, body);
  const examined = crossExamine(alignment, {
    rosterIds: new Set(ROSTER),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  });
  expect(examined.flags).toEqual([
    { index: 3, reason: 'unanchored-named:anton' },
    { index: 4, reason: 'unanchored-narrator' },
  ]);
  return { body, paras, sentences: examined.sentences, flags: examined.flags };
}

describe('escalateFlaggedWindows — E-core (resolve, not override)', () => {
  it('NEVER overwrites a named answer (unanchored-named) but DOES fill a placeholder (unanchored-narrator)', async () => {
    const { body, paras, sentences, flags } = buildNamedFixture();
    const analyzer = fakeAnalyzer(() => ({
      assignments: [
        { line: 4, characterId: 'olga' }, // tries to overwrite the NAMED 'anton' → must be REJECTED
        { line: 5, characterId: 'boris' }, // fills the placeholder → applied
      ],
    }));

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(outcome.applied).toBe(1);
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'anton' }); // untouched
    expect(sentences.find((s) => s.id === 5)).toMatchObject({ characterId: 'boris', confidence: 0.8 });
    // the protected named line's flag stays; the filled placeholder's flag is cleared
    expect(flags).toEqual([{ index: 3, reason: 'unanchored-named:anton' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/escalation.test.ts -t "E-core"`
Expected: FAIL — line 4 is currently overwritten to `olga` (applied would be 2), because the apply loop has no fill-eligibility gate.

- [ ] **Step 3: Add the fill-eligibility gate**

In `escalation.ts`, add the predicate near the top-level constants (after `SHORT_NARRATION_MAX_LEN`):

```ts
/** E-core (spec §5.2): escalation may only FILL a genuinely-unresolved
    placeholder line. `unanchored-narrator` is the sole flag class whose
    current answer is a non-committal placeholder; every other escalatable
    class (`unanchored-named:*`, `pronoun-keep-flag:*`, `alt-keep-flag:*`,
    `alt-correct-flag:*`) already carries a named/structural answer that a
    context-starved re-ask must never overwrite. */
function isFillEligible(reason: string): boolean {
  return reason === 'unanchored-narrator';
}
```

Then, in the apply loop, gate on the flag's reason. Replace the block from `const as = alignment.aligned[idx];` through the `outcome.applied += 1;` (currently escalation.ts:229-238) with:

```ts
      const flagPos = opts.flags.findIndex((f) => f.index === idx);
      if (flagPos === -1) continue; // defensive: not currently flagged
      if (!isFillEligible(opts.flags[flagPos].reason)) continue; // E-core: never overwrite a named answer

      const as = alignment.aligned[idx];
      const hasTagName = as.spans.some((s) => s.kind === 'speech' && s.speaker?.source === 'tag-name');
      if (hasTagName) continue; // never override tag-name — the one hard invariant

      opts.sentences[idx].characterId = assignment.characterId;
      opts.sentences[idx].confidence = ESCALATED_CONFIDENCE;
      opts.flags.splice(flagPos, 1);
      appliedIdx.add(idx);
      outcome.applied += 1;
```

(This folds the pre-existing `flagPos` lookup — previously computed just before the splice — up to the top of the guard chain, so the reason check and the splice share one lookup.)

- [ ] **Step 4: Run the full escalation suite to verify green**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/escalation.test.ts`
Expected: PASS — the new E-core test passes; every pre-existing test (a)–(f), (c), (d) still green (their flags are `unanchored-narrator`, still fill-eligible; the adversarial tag-name line is blocked by both the new gate and the surviving `hasTagName` guard).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/escalation.ts server/src/analyzer/dialogue-structure/escalation.test.ts
git commit -m "fix(server): escalation fills only unresolved placeholders, never overwrites a named answer"
```

---

## Task 4: Wave 2 E1 — confident-neighbour re-ask context (revertible)

Spec §5.2 E1 + §7. When building the re-ask window, surface the **high-confidence deterministic** anchors of neighbouring lines and **suppress** the flagged lines' own low-confidence guesses, so the re-ask isn't primed with the model's possibly-wrong answers. Circularity risk is explicit (§7): this task is **revertible** — if the on-box averaged eval (final acceptance) shows no gain over E-core alone, revert this commit before merge.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/escalation.ts` (`buildWindowText`)
- Test: `server/src/analyzer/dialogue-structure/escalation.test.ts`

**Interfaces:**
- Consumes: `sentences[].confidence` (crossExamine-derived), the re-derived `aligned` spans.
- Produces: no signature change. A module-private `CONFIDENT_ANCHOR_MIN` threshold and inline `[speaker]` labels in the window text; flagged lines' own ids no longer seeded into `participantIds`.

- [ ] **Step 1: Write the failing test**

A confident tag-name neighbour (`said Anton`, confidence 0.95) must appear labeled `[anton]` in the window text; the flagged placeholder lines must stay unlabeled and their own current id must not leak into the candidate list. Add to `escalation.test.ts`:

```ts
describe('escalateFlaggedWindows — E1 (confident-neighbour context)', () => {
  it('labels a confident neighbour line with its resolved speaker, leaves flagged lines unlabeled', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    let capturedPrompt = '';
    const analyzer = fakeAnalyzer((prompt) => {
      capturedPrompt = prompt;
      return { assignments: [] };
    });

    await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    const windowText = capturedPrompt.split('Text (>>N<< marks the lines to resolve):\n')[1];
    // Confident tag-confirmed neighbours are surfaced as resolved anchors...
    expect(windowText).toContain('[anton]');
    expect(windowText).toContain('[boris]');
    // ...the flagged placeholder lines are marked (>>id<<), never labeled with a guess.
    expect(windowText).toContain('>>4<<');
    expect(windowText).not.toContain('[narrator]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/escalation.test.ts -t "E1"`
Expected: FAIL — no `[anton]` labels are emitted today.

- [ ] **Step 3: Implement confident-neighbour labeling in `buildWindowText`**

In `escalation.ts`, add the threshold constant near the other constants:

```ts
/** E1 (spec §5.2): a neighbour line resolved by crossExamine at or above this
    confidence is a high-confidence deterministic anchor (tag-confirm 0.95 /
    tag-correct 0.9 / pronoun-confirm 0.85 / pronoun-correct 0.8 / alt-confirm
    0.8) surfaced to ground the re-ask; below it (unanchored 0.5–0.65, keep-flag
    guesses 0.6–0.7) is a guess and is suppressed. Starting value; TDD-pinned. */
const CONFIDENT_ANCHOR_MIN = 0.8;
```

Inside `buildWindowText`, after `markersByPara` is built (just before `renderPara`), build a per-paragraph label map for confident NON-member neighbours, and make `renderPara` emit the label. Then stop seeding `participantIds` with the flagged members' own ids.

```ts
  // E1: label confident non-member neighbour dialogue lines with their resolved
  // speaker; the flagged members stay unlabeled (they're what we're asking about).
  const memberSet = new Set(memberIdx);
  const labelsByPara = new Map<number, string>();
  for (let idx = 0; idx < sentences.length; idx++) {
    if (memberSet.has(idx)) continue;
    const sent = sentences[idx];
    if ((sent.confidence ?? 0) < CONFIDENT_ANCHOR_MIN) continue;
    if (sent.characterId === NARRATOR_ID) continue; // a narrator label adds no attribution signal
    const span = aligned[idx].spans.find((s) => s.kind === 'speech');
    if (!span) continue;
    const pIdx = corePara.find((k) => paras[k].start <= span.start && span.start < paras[k].end);
    if (pIdx === undefined) continue;
    if (!labelsByPara.has(pIdx)) labelsByPara.set(pIdx, sent.characterId); // first confident speaker wins
  }

  const renderPara = (pIdx: number): string => {
    const markers = markersByPara.get(pIdx) ?? [];
    const prefix = markers.map((id) => `>>${id}<<`).join('') + (markers.length ? ' ' : '');
    const label = labelsByPara.get(pIdx);
    const labelPrefix = label ? `[${label}] ` : '';
    return prefix + labelPrefix + body.slice(paras[pIdx].start, paras[pIdx].end);
  };
```

(Delete the pre-existing `const renderPara = ...` definition it replaces.)

Then change the `participantIds` construction at the end of `buildWindowText` — remove the line that seeds it with the flagged members' current (low-confidence) ids:

```ts
  const participantIds = new Set<string>();
  for (const pIdx of corePara) {
    for (const span of paras[pIdx].spans) {
      if (span.kind === 'speech' && span.windowId === windowId && span.speaker) {
        participantIds.add(span.speaker.characterId);
      }
    }
  }
  // E1: do NOT seed participants from the flagged members' own ids — those are
  // the low-confidence guesses the re-ask must not be primed with.
  participantIds.delete(NARRATOR_ID);
```

- [ ] **Step 4: Run the full escalation suite to verify green**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/escalation.test.ts`
Expected: PASS — new E1 test green; the pre-existing `(b)`/`(b2)` prompt-content tests stay green (`anton`/`olga`/`boris` still reach the prompt via span-speaker participants and the new labels; `narrator` still excluded).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/escalation.ts server/src/analyzer/dialogue-structure/escalation.test.ts
git commit -m "feat(server): ground escalation re-ask with confident neighbour anchors (E1, revertible)"
```

---

## Task 5: Wave 3 A1 — weak tag strength on beat-only quote gaps

Spec §5.3. A `tag-name` minted from a **top-level quote-paragraph narration gap** reclassified on a **beat** verb *only* (e.g. `"Stop." Anton frowned.`) is **weak**; a speech-verb tag (`"Hi," Anton said.`) and the dash/quote-interior beat tag the Russian/German cases rely on (`— Да, — кивнул Антон`) stay **strong**. Weak ≠ delete — weak means "flag on model disagreement" (Task 6).

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/types.ts` (`speaker.strength?: 'weak'`)
- Modify: `server/src/analyzer/dialogue-structure/parser.ts` (`parseQuoteParagraph` reclassification; `anchorSpansFromTags.applyTag` stamping)
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:**
- Consumes: `conv.speechVerbStems`, `conv.beatVerbStems`.
- Produces: `SpanEvidence.speaker.strength?: 'weak'` (read by Task 6's cross-examine + escalation).

- [ ] **Step 1: Write the failing test**

Add to `parser.test.ts` (match the file's existing import of `parseChapterStructure`, `buildNameIndex`, `conventionsFor`; a helper to fetch the first speaker with `strength`):

```ts
describe('A1 — weak tag strength (beat-only quote gaps)', () => {
  const enIdx = () =>
    buildNameIndex([{ id: 'anton', name: 'Anton' }], conventionsFor('en')!);

  const firstSpeaker = (paras: ReturnType<typeof parseChapterStructure>) =>
    paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech' && s.speaker)?.speaker;

  it('a beat-only quote-gap tag is marked strength: weak', () => {
    const paras = parseChapterStructure('"Stop." Anton frowned.', enIdx());
    expect(firstSpeaker(paras)).toMatchObject({ characterId: 'anton', source: 'tag-name', strength: 'weak' });
  });

  it('a speech-verb quote tag stays strong (no strength field)', () => {
    const paras = parseChapterStructure('"Hi," Anton said.', enIdx());
    const sp = firstSpeaker(paras);
    expect(sp).toMatchObject({ characterId: 'anton', source: 'tag-name' });
    expect(sp?.strength).toBeUndefined();
  });

  it('a dash-interior beat tag stays strong (Russian кивнул path)', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const paras = parseChapterStructure('— Да, — кивнул Антон.', ruIdx);
    const sp = firstSpeaker(paras);
    expect(sp).toMatchObject({ characterId: 'anton', source: 'tag-name' });
    expect(sp?.strength).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts -t "A1"`
Expected: FAIL — no `strength` is ever set; the first assertion fails.

- [ ] **Step 3: Add `strength` to the type**

In `types.ts`, change the `speaker` field:

```ts
  /** set on speech spans only. `strength: 'weak'` marks a low-confidence
      tag-name (a beat-only quote-gap reclassification) that Wave 3 lets the
      model contest; absence = strong (the immutable tag-name invariant). */
  speaker?: { characterId: string; source: EvidenceSource; strength?: 'weak' };
```

- [ ] **Step 4: Mark beat-only quote-gap reclassifications, stamp weak on anchor**

In `parser.ts`, rewrite the reclassification loop in `parseQuoteParagraph` (currently the `if (runs.length > 0) { ... }` block, lines 239-244) so a gap reclassified on a BEAT verb *only* (no speech verb) is tagged with a transient `weakTag` marker:

```ts
  if (runs.length > 0) {
    for (const s of spans) {
      if (s.kind !== 'narration') continue;
      const gap = line.slice(s.start - base, s.end - base);
      const hasSpeechVerb = hasStem(gap, conv.speechVerbStems);
      const hasBeatVerb = hasStem(gap, conv.beatVerbStems);
      if (!hasSpeechVerb && !hasBeatVerb) continue;
      s.kind = 'tag';
      // A beat-only reclassification is weak evidence: an English "Anton
      // frowned." adjacent to a quote is a plausible beat attribution, but not
      // an authoritative speech tag. A speech-verb tag stays strong.
      if (!hasSpeechVerb) (s as SpanEvidence & { weakTag?: boolean }).weakTag = true;
    }
  }
  anchorSpansFromTags(spans, line, base, index);
```

Then in `anchorSpansFromTags`, have `applyTag` propagate that marker onto the anchored `tag-name` speaker (transient-property pattern already used for `pendingPronoun`):

```ts
  const applyTag = (tag: SpanEvidence, sp: SpanEvidence | null) => {
    if (!sp || sp.speaker || 'pendingPronoun' in sp) return;
    const text = line.slice(tag.start - base, tag.end - base);
    const name = findRosterName(text, index);
    if (name) {
      const weak = 'weakTag' in tag; // set only on beat-only quote-gap tags (parseQuoteParagraph)
      sp.speaker = { characterId: name, source: 'tag-name', ...(weak ? { strength: 'weak' as const } : {}) };
    } else {
      const { pronoun } = classifyPronoun(text, conv.pronouns);
      if (pronoun) (sp as SpanEvidence & { pendingPronoun?: ParsedTag['pronoun'] }).pendingPronoun = pronoun;
    }
  };
```

(The dash path — `parseDialogueSpans` → `anchorSpansFromTags` — never sets `weakTag`, so its tags stay strong.)

- [ ] **Step 5: Run parser tests + typecheck**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/parser.test.ts && npm run -s typecheck`
Expected: PASS — the three A1 cases green; every pre-existing parser test (incl. Russian/German dash beat tags) green (they never assert on `strength`, which is optional and absent for them).

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/dialogue-structure/types.ts server/src/analyzer/dialogue-structure/parser.ts server/src/analyzer/dialogue-structure/parser.test.ts
git commit -m "feat(server): mark beat-only quote-gap tag-name evidence as weak"
```

---

## Task 6: Wave 3 A2 — weak-tag disagreement flags, not force-corrects

Spec §5.3. A **weak** tag that disagrees with the model **keeps the model id and flags** (bucket `flagged`, mirroring `pronoun-keep-flag`/`alt-keep-flag`) — removing the ch44 `tag-correct` false-positive corruption where a beat-gap stamped the wrong speaker onto a correct model answer. Thread strength through `escalation.ts`'s `hasTagName` guard so the two enforcers agree. A weak tag the model **agrees** with still confirms (the correct-beat guard, spec §6).

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts` (`decideAnchoredSpeech` tag-name case; `CONFIDENCE`)
- Modify: `server/src/analyzer/dialogue-structure/escalation.ts` (`hasTagName` → strong-only)
- Test: `server/src/analyzer/dialogue-structure/cross-examine.test.ts`

**Interfaces:**
- Consumes: `span.speaker.strength` (Task 5).
- Produces: reason `tag-weak-keep-flag:<modelId>-vs-<x>` (evidenceFamily → `tag`), `CONFIDENCE.TAG_WEAK_KEEP_FLAG`.

- [ ] **Step 1: Write the failing test**

Add to `cross-examine.test.ts` (mirror the file's existing helpers for building an `AlignmentResult`; if it constructs `AlignedSentence` fixtures inline, follow that shape — a speech span with `speaker: { characterId: 'anton', source: 'tag-name', strength: 'weak' }`):

```ts
describe('A2 — weak tag-name is contestable', () => {
  const opts = {
    rosterIds: new Set(['anton', 'olga', 'narrator']),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  };
  const weakSpeechSpan = { kind: 'speech' as const, start: 0, end: 5, speaker: { characterId: 'anton', source: 'tag-name' as const, strength: 'weak' as const } };

  it('a weak tag the model DISAGREES with keeps the model id and flags (no force-correct)', () => {
    const aligned = alignedWith('olga', [weakSpeechSpan]); // model said olga, weak tag says anton
    const res = crossExamine({ alignedPct: 100, aligned: [aligned] } as any, opts);
    expect(res.sentences[0].characterId).toBe('olga');
    expect(res.flags).toContainEqual({ index: 0, reason: 'tag-weak-keep-flag:olga-vs-anton' });
  });

  it('a weak tag the model AGREES with still confirms to the right speaker (correct-beat guard)', () => {
    const aligned = alignedWith('anton', [weakSpeechSpan]);
    const res = crossExamine({ alignedPct: 100, aligned: [aligned] } as any, opts);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.flags).toEqual([]); // confirmed, not flagged
  });

  it('a STRONG tag disagreement still force-corrects (unchanged invariant)', () => {
    const strong = { ...weakSpeechSpan, speaker: { characterId: 'anton', source: 'tag-name' as const } };
    const aligned = alignedWith('olga', [strong]);
    const res = crossExamine({ alignedPct: 100, aligned: [aligned] } as any, opts);
    expect(res.sentences[0].characterId).toBe('anton'); // strong tag wins
    expect(res.flags).toEqual([]);
  });
});
```

> **Implementer note:** `alignedWith(modelId, spans)` is the file's existing pattern for a minimal `AlignedSentence` (`{ sentence: { id, chapterId, characterId: modelId, text }, spans, lumped: false }`). Reuse the existing builder in `cross-examine.test.ts`; do not invent a new one. If none exists, add a tiny local one in this describe block — do not change other tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts -t "A2"`
Expected: FAIL — a weak tag disagreement currently returns `tag-correct` (force-correct to `anton`), so the first case's `characterId` is `anton`, not `olga`.

- [ ] **Step 3: Add the confidence constant + weak-tag branch**

In `cross-examine.ts`, add to the `CONFIDENCE` block (place it next to the other keep-flags, e.g. after `PRONOUN_KEEP_FLAG`):

```ts
  TAG_WEAK_KEEP_FLAG: 0.6,
```

Then rewrite the `case 'tag-name':` in `decideAnchoredSpeech`:

```ts
    case 'tag-name':
      if (modelId === x) {
        return { characterId: x, confidence: CONFIDENCE.TAG_CONFIRM, reason: `tag-confirm:${x}`, bucket: 'confirmed', flagged: false };
      }
      // A WEAK tag (beat-only quote-gap, Wave 3) is contestable: on model
      // disagreement keep the model id and flag, mirroring pronoun-keep-flag —
      // do NOT force-correct to a plausible-but-unauthoritative beat attribution.
      if (span.speaker!.strength === 'weak') {
        return {
          characterId: modelId,
          confidence: CONFIDENCE.TAG_WEAK_KEEP_FLAG,
          reason: `tag-weak-keep-flag:${modelId}-vs-${x}`,
          bucket: 'flagged',
          flagged: true,
        };
      }
      return { characterId: x, confidence: CONFIDENCE.TAG_CORRECT, reason: `tag-correct:${x}`, bucket: 'corrected', flagged: false };
```

- [ ] **Step 4: Thread strength through the escalation `hasTagName` guard**

In `escalation.ts`, make the never-override guard apply only to a STRONG tag-name (so a weak tag isn't treated as the immutable invariant). Change the `hasTagName` line inside the apply loop:

```ts
      const as = alignment.aligned[idx];
      const hasStrongTagName = as.spans.some(
        (s) => s.kind === 'speech' && s.speaker?.source === 'tag-name' && s.speaker.strength !== 'weak',
      );
      if (hasStrongTagName) continue; // never override a STRONG tag-name — the one hard invariant
```

> **Note:** under E-core (Task 3) the fill-eligibility gate already blocks escalation from overwriting a `tag-weak-keep-flag` line (it is not `unanchored-narrator`), so this change does not alter eval outcomes — it keeps the invariant semantically precise (a weak tag is not the hard tag-name invariant) and keeps the cross-examine and escalation enforcers in agreement, per spec §5.3.

- [ ] **Step 5: Run cross-examine + escalation suites + typecheck**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts src/analyzer/dialogue-structure/escalation.test.ts && npm run -s typecheck`
Expected: PASS — A2 cases green; all pre-existing cross-examine + escalation tests green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/dialogue-structure/cross-examine.ts server/src/analyzer/dialogue-structure/escalation.ts server/src/analyzer/dialogue-structure/cross-examine.test.ts
git commit -m "feat(server): weak tag-name disagreement flags instead of force-correcting"
```

---

## Final acceptance (on-box, controller step — not a subagent task)

Spec §6. After all six tasks land and `npm run test:server` is green, run the variance-averaged eval on the box that has the local Qwen model. This is the integration measure; it needs the GPU + `qwen36-cw-iq4-32k:latest` and the git-ignored PwF corpus at `C:/AudiobookWorkspace`, so it is a controller/human step, not a headless subagent task.

```
EVAL_QWEN_MODEL=qwen36-cw-iq4-32k:latest WORKSPACE_DIR=C:/AudiobookWorkspace npm run eval:attribution -- --engine qwen --runs 3
```

Gate on the mean over ≥3 runs:

- **Primary recovery:** ch46 and Coalfall mean `final` within noise (±2–3%) of their esc-OFF `det` — the −12.8 / −3.5 escalation losses removed.
- **No silent regression (per fixture):** **every** fixture's mean `final` ≥ its recorded **esc-ON** baseline − noise (baselines: ch43 78.7, ch44 79.9, ch45 62.5, ch46 51.3, Coalfall 72.4). This is the check that catches losing ch45's escalation gain or a correct beat-gap fix.
- **ch44 improvement:** ch44 mean `final` moves toward `raw` (the `tag-correct` false-positive corruption removed by A1/A2).
- **Coalfall guardrail:** mean `final ≥ raw` (75.9%).
- **E1 keep/revert decision:** compare the run WITH Task 4 against a run with Task 4 reverted (`git revert` the E1 commit locally). If E1 shows no mean gain over E-core alone, **revert it before merge** (spec §5.2/§7 — E1 is explicitly droppable).

If a gate fails, that is diagnostic signal (per spec §7), not a silent pass — surface it and iterate; do not merge on a red integration gate.

---

## Self-Review

**Spec coverage:** §5.1 harness honesty → Task 1; §5.1 `--runs` averaging → Task 2; §5.2 E-core → Task 3; §5.2 E1 → Task 4; §5.2 E2 → **deferred by design, no task** (correct — spec defers it); §5.3 A1 → Task 5; §5.3 A2 → Task 6; §6 acceptance → Final acceptance section + the per-task unit guards (correct-beat guard in Task 6 step 1 case 2). §8 Target C → out of scope (spec §3). All covered.

**Placeholder scan:** every code step carries complete code; no TBD/TODO; test steps show real assertions; the one prose-only note (Task 6 `alignedWith`) points at an existing test helper rather than hand-waving.

**Type consistency:** `StageScore.byFamily` changes to `Record<string, FamilyBreakdown>` in Task 1 and is consumed by `aggStage` in Task 2 with the same `{correct, attributed, drift}` shape. `strength?: 'weak'` is defined in Task 5 (types.ts) and read in Task 6 (`span.speaker!.strength === 'weak'`, `s.speaker.strength !== 'weak'`) — consistent. `isFillEligible` (Task 3) and `CONFIDENT_ANCHOR_MIN` (Task 4) are module-private, no cross-task signature coupling. `runEval` return type gains `runs` and `fixtures: FixtureAgg[]`; the only external consumer (`run-eval-cli.test.ts`) reads `.skipped`, still present.
