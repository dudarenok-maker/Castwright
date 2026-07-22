# Target C — Stage-2 attribution prompt enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, language-safe attribution rules-block to the stage-2 line→speaker prompt so the model's first full-context (raw) pass is explicitly instructed, and make the eval harness able to measure it honestly across three model targets.

**Architecture:** One module-level constant `STAGE2_ATTRIBUTION_RULES` in `server/src/routes/analysis.ts`, injected into both stage-2 inbox builders (`buildStage2ChapterInbox`, `buildStage2ChunkInbox`) after the roster block and before the first-person/body blocks. Two small eval-harness changes make the acceptance gate trustworthy: the scorecard labels the actual model id (not just the engine slot), and the `raw` stage gets its per-evidence-family breakdown populated. No behavioural code changes to the attribution pipeline itself — this is a prompt-content change plus two observability tweaks.

**Tech Stack:** TypeScript (Node ESM), Vitest (server harness, node env).

**Design of record:** `docs/superpowers/specs/2026-07-21-target-c-stage2-attribution-prompt-design.md`
**Regression plan to update on ship:** `docs/features/265-attribution-eval-tuning.md`

## Global Constraints

- **Branch:** `feat/server-stage2-attribution-prompt` (already cut off latest `main`, in the `analyzer-eval-telemetry` worktree which holds the gitignored PwF eval corpus). Do NOT cut a new worktree — the corpus lives only here.
- **Never `--no-verify`.** Pre-commit runs `verify:fast:scoped`; the server-test leg triggers a venv bootstrap that prints scary-but-harmless ROCm-wheel fallback lines and can take ~2 min. That is expected — let the hook run.
- **Commit convention:** `<type>(server): <subject>`, subject ≤100 chars. Task 1 is `feat(server):`; Tasks 2–3 are `test(server):`/`chore(server):` or `feat(server):` as noted per task.
- **Rules-block text is verbatim** — copy the block in Task 1 exactly as written here (it is the tuned artifact from the spec). Do not paraphrase, reorder, or "improve" the wording.
- **The first-person block is left byte-for-byte as-is** in both builders — it is already tuned. Only the rules-block is inserted around it.
- **Acceptance is English-only and on-box** (live models, not CI). The three-engine eval is a manual gate the controller/human runs after the code is green; implementers are NOT expected to run it.
- **No new JSON output fields, no few-shot examples, no per-engine prompt branching.** Scope is the shared block + two harness tweaks + their unit tests.

---

### Task 1: The shared `STAGE2_ATTRIBUTION_RULES` block, injected into both builders

**Files:**
- Modify: `server/src/routes/analysis.ts` (add the constant near the other stage-2 builders ~line 1520; inject into `buildStage2ChapterInbox` ~1572 and `buildStage2ChunkInbox` ~1645)
- Test: `server/src/routes/analysis.test.ts` (extend the existing `describe('stage-2 prompt first-person anchor (RC3)')` block area near line 3462; add `buildStage2ChunkInbox` to the import at line ~34)

**Interfaces:**
- Consumes: nothing new.
- Produces: `STAGE2_ATTRIBUTION_RULES` is module-private (not exported); it is asserted indirectly through the two builders' rendered output. No signature changes to either builder.

- [ ] **Step 1: Write the failing tests**

Add `buildStage2ChunkInbox` to the existing import block in `analysis.test.ts` (it currently imports `buildStage2ChapterInbox` at line ~34). Then append this `describe` block after the existing `stage-2 prompt first-person anchor (RC3)` block (~line 3481):

```ts
describe('stage-2 attribution rules block (Target C)', () => {
  const stage1 = {
    characters: [
      { id: 'anton', name: 'Anton', role: 'Colleague' },
      { id: 'egor', name: 'Egor', role: 'Protagonist' },
    ],
  } as any;
  const chapter = { id: 1, title: 'Ch1', body: '"Get out." Anton turned away.' };

  it('renders the rules block in the chapter builder, after the roster and before the body', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, null);
    expect(prompt).toContain('## Attribution rules');
    expect(prompt).toContain('A dialogue tag is decisive');
    expect(prompt).toContain('The addressee is not the speaker');
    // Order: Characters roster → Attribution rules → Chapter body.
    const roster = prompt.indexOf('## Characters (from stage 1)');
    const rules = prompt.indexOf('## Attribution rules');
    const body = prompt.indexOf('## Chapter 1 —');
    expect(roster).toBeGreaterThanOrEqual(0);
    expect(rules).toBeGreaterThan(roster);
    expect(body).toBeGreaterThan(rules);
  });

  it('renders the rules block in the chunk builder, before context/first-person/section body', () => {
    const prompt = buildStage2ChunkInbox(
      'm', 'Title', stage1, chapter, 'section text', 'prior tail', null,
    );
    const rules = prompt.indexOf('## Attribution rules');
    const context = prompt.indexOf('## Preceding context');
    const section = prompt.indexOf('## Section to attribute');
    expect(rules).toBeGreaterThan(prompt.indexOf('## Characters (from stage 1)'));
    expect(context).toBeGreaterThan(rules);
    expect(section).toBeGreaterThan(context);
  });

  it('still renders the first-person block after the rules block when a first-person id is present', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, 'anton');
    const rules = prompt.indexOf('## Attribution rules');
    const firstPerson = prompt.indexOf('## First-person narrator');
    expect(rules).toBeGreaterThan(0);
    expect(firstPerson).toBeGreaterThan(rules);
    expect(prompt).toContain('`anton`');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "attribution rules block"`
Expected: FAIL — `## Attribution rules` not found (block not injected yet).

- [ ] **Step 3: Add the constant**

Insert this module-level constant in `analysis.ts` immediately before `export function buildStage2ChapterInbox` (~line 1522). Copy the block text verbatim:

```ts
/* Target C — the shared stage-2 attribution rules, injected into both the
   whole-chapter and the chunked stage-2 inbox builders. Language-/quote-agnostic
   by construction (see the lead line) so it does not misfire on «…» / „…" or
   non-English text. Kept deliberately short — every rule earns its tokens. */
const STAGE2_ATTRIBUTION_RULES = `## Attribution rules

Apply these when assigning each sentence's speaker. They hold whatever
quotation marks the text uses — \`"…"\`, \`«…»\`, \`„…"\`, \`“…”\` — and in any
language:

1. A dialogue tag is decisive. When a quote carries an explicit speech tag —
   \`"…," said X\` / \`"…," X asked\` / \`"…," whispered X\` — the speaker is X,
   whatever the surrounding lines suggest.
2. An action beat names the speaker. A quote sharing a paragraph with a
   character's action belongs to that character: \`X folded her arms. "Get
   out."\` and \`"Get out." X turned away.\` are both spoken by X.
3. Untagged quotes continue, and two-handers alternate. An untagged quote keeps
   the last established speaker. In a sustained back-and-forth between exactly
   two characters, untagged quotes alternate between them.
4. Narration is the narrator. Non-dialogue prose — description, action,
   scene-setting — is \`narrator\`, even between two characters' lines. Only words
   inside quote marks belong to a character (unless the whole chapter is a
   first-person document).
5. The addressee is not the speaker. A name spoken to someone ("Careful,
   Anton.") marks who is addressed, not who speaks — never attribute the line to
   the person being addressed.`;
```

- [ ] **Step 4: Inject into `buildStage2ChapterInbox`**

In `buildStage2ChapterInbox`, the template currently ends the roster JSON fence and goes straight to the first-person block + body:

```ts
\`\`\`

${firstPersonBlock}## Chapter ${chapter.id} — ${chapter.title}
```

Insert the rules block between the closing fence and `${firstPersonBlock}`:

```ts
\`\`\`

${STAGE2_ATTRIBUTION_RULES}

${firstPersonBlock}## Chapter ${chapter.id} — ${chapter.title}
```

- [ ] **Step 5: Inject into `buildStage2ChunkInbox`**

In `buildStage2ChunkInbox`, the template currently goes from the roster fence to `${contextBlock}${firstPersonBlock}## Section…`:

```ts
\`\`\`

${contextBlock}${firstPersonBlock}## Section to attribute (Chapter ${chapter.id} — ${chapter.title})
```

Insert the rules block before `${contextBlock}` so the order is Characters → Attribution rules → preceding context → first-person → section:

```ts
\`\`\`

${STAGE2_ATTRIBUTION_RULES}

${contextBlock}${firstPersonBlock}## Section to attribute (Chapter ${chapter.id} — ${chapter.title})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "attribution rules block"`
Expected: PASS (3/3). Also re-run the neighbouring first-person block to confirm no regression: `-t "first-person anchor"` → PASS (2/2).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): add stage-2 attribution rules block to both inbox builders"
```

---

### Task 2: Model-label honesty in the eval scorecard

**Files:**
- Modify: `server/src/analyzer/attribution-eval/run-eval-cli.ts` (add `slotLabel`, use it in `runEval`'s results push ~line 99)
- Test: `server/src/analyzer/attribution-eval/run-eval-cli.test.ts`

**Why:** both Cloud models run through the single `gemma` engine slot keyed by `GEMINI_MODEL`, so `gemini-3.1-flash-lite` prints under the bare label `"gemma"` — misleading in the durable record. The scorecard should name the actual model id.

**Note (naming):** `server/src/routes/analysis.ts` already has an unrelated two-arg `engineLabel(engine, model)`. To avoid a same-name shadow that would confuse a reviewer, the harness helper is named **`slotLabel`** (different module, no import path between them). Do not name it `engineLabel`.

**Interfaces:**
- Produces: `export function slotLabel(engine: 'qwen' | 'gemma'): string` — returns `qwen:<EVAL_QWEN_MODEL|default>` / `gemma:<GEMINI_MODEL|default>`. Used only for the display label in `runEval`'s returned `results[].engine`; the raw `'qwen'|'gemma'` value still drives `buildAnalyzer` and the skip messages.

- [ ] **Step 1: Write the failing test**

In `run-eval-cli.test.ts`, **merge** `slotLabel` into the existing top import (it currently reads `import { runEval } from './run-eval-cli.js';` — change it to `import { runEval, slotLabel } from './run-eval-cli.js';`; do NOT add a second `import` line — a duplicate import trips the lint leg in cloud `verify.yml`). Then append:

```ts
describe('slotLabel', () => {
  it('labels qwen with the resolved model id', () => {
    const prev = process.env.EVAL_QWEN_MODEL;
    process.env.EVAL_QWEN_MODEL = 'qwen36-cw-iq4-32k';
    try {
      expect(slotLabel('qwen')).toBe('qwen:qwen36-cw-iq4-32k');
    } finally {
      if (prev === undefined) delete process.env.EVAL_QWEN_MODEL;
      else process.env.EVAL_QWEN_MODEL = prev;
    }
  });

  it('labels gemma with the resolved GEMINI_MODEL so flash-lite is not printed as bare "gemma"', () => {
    const prev = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
    try {
      expect(slotLabel('gemma')).toBe('gemma:gemini-3.1-flash-lite');
    } finally {
      if (prev === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prev;
    }
  });

  it('falls back to the default gemma model id when GEMINI_MODEL is unset', () => {
    const prev = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    try {
      expect(slotLabel('gemma')).toBe('gemma:gemma-4-31b-it');
    } finally {
      if (prev !== undefined) process.env.GEMINI_MODEL = prev;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval-cli.test.ts -t slotLabel`
Expected: FAIL — `slotLabel` is not exported.

- [ ] **Step 3: Add `slotLabel` and use it**

In `run-eval-cli.ts`, add near the top (after imports), keeping the same defaults `buildAnalyzer` uses:

```ts
export function slotLabel(engine: 'qwen' | 'gemma'): string {
  if (engine === 'qwen') return `qwen:${process.env.EVAL_QWEN_MODEL ?? 'qwen3.5:9b'}`;
  return `gemma:${process.env.GEMINI_MODEL ?? 'gemma-4-31b-it'}`;
}
```

In `runEval`, change the results push (currently `results.push({ engine, fixtures })` ~line 99) to label the model while leaving the loop variable `engine` untouched for `buildAnalyzer`/skip:

```ts
    results.push({ engine: slotLabel(engine), fixtures });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval-cli.test.ts -t slotLabel`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/attribution-eval/run-eval-cli.ts server/src/analyzer/attribution-eval/run-eval-cli.test.ts
git commit -m "feat(server): label eval scorecard with the resolved model id, not the engine slot"
```

---

### Task 3: Populate the `raw` stage's per-family breakdown and print it

**Files:**
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts` (`evalFixture` raw `scoreStage` call ~line 126)
- Modify: `server/src/analyzer/attribution-eval/run-eval-cli.ts` (`printScorecard` — print raw's `byFamily` too, ~line 118)
- Test: `server/src/analyzer/attribution-eval/run-eval.test.ts` (extend the existing `describe('evalFixture')`)

**Why:** `raw` is currently scored WITHOUT `reasons`, so `raw.byFamily = {}` and only `final`'s family split prints. A rule that redistributes errors between evidence families (e.g. rule #4 lifting untagged lines while over-attributing tagged dialogue to `narrator`) could net flat aggregate raw recall and pass the gate invisibly. The evidence-family classification is a property of the line's text, identical for raw and deterministic (cross-examine changes ids, not segmentation), so the same `reasons` array that already scores `deterministic`/`final` aligns 1:1 to `raw`.

**Interfaces:**
- Consumes: `stages!.reasons` (already captured in `evalFixture` ~line 123).
- Produces: `FixtureResult.raw.byFamily` is now populated; `FixtureAgg.raw.byFamily` therefore aggregates in `aggStage` with no code change (it already loops all families present).

- [ ] **Step 1: Write the failing test**

In `run-eval.test.ts`, extend the `describe('evalFixture')` block with a case asserting raw now carries a family split (the fixture's two lines are a tag line + narrator prose, so a `tag` family appears):

```ts
  it('populates raw.byFamily so the per-family gate has data (Target C)', async () => {
    const res = await evalFixture({
      analyzer: fakeAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
    });
    // Before Target C this was {} (raw scored without reasons).
    expect(Object.keys(res.raw.byFamily).length).toBeGreaterThan(0);
    // Same family set as deterministic, since evidence family is a property of the text.
    expect(Object.keys(res.raw.byFamily).sort()).toEqual(
      Object.keys(res.deterministic.byFamily).sort(),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts -t "populates raw.byFamily"`
Expected: FAIL — `res.raw.byFamily` is `{}` (length 0).

- [ ] **Step 3: Wire reasons into the raw scoreStage call**

In `run-eval.ts` `evalFixture`, change the raw line (currently `raw: scoreStage(opts.truth, stages!.raw),` ~line 126) to pass the same `reasons` the deterministic/final calls use:

```ts
    raw: scoreStage(opts.truth, stages!.raw, reasons),
```

- [ ] **Step 4: Print raw's per-family split in the scorecard**

In `run-eval-cli.ts` `printScorecard`, after the existing `final.byFamily` loop (~line 122), the raw family split should be visible in the deciding metric. Change the per-fixture body so raw's families print under a `raw ·` prefix. Replace the single `final.byFamily` loop with both:

```ts
      for (const fam of Object.keys(f.raw.byFamily).sort()) {
        console.log(`      raw · ${fam}: ${famLine(f.raw.byFamily[fam], f.runs)}`);
      }
      for (const fam of Object.keys(f.final.byFamily).sort()) {
        console.log(`      ${fam}: ${famLine(f.final.byFamily[fam], f.runs)}`);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts`
Expected: PASS — the new case plus the existing `evalFixture`/`familyBreakdown`/`aggStage` cases all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/attribution-eval/run-eval.ts server/src/analyzer/attribution-eval/run-eval-cli.ts server/src/analyzer/attribution-eval/run-eval.test.ts
git commit -m "feat(server): populate and print the eval raw per-family breakdown"
```

---

## On-box acceptance (controller/human, after all tasks green — NOT part of the SDD task loop)

Run from this worktree (corpus present); export `GEMINI_API_KEY` first (it lives in the main checkout's `server/.env`). Six runs total — baseline (current `main` prompt) and treatment (this branch), each × three targets, `--runs 3`:

1. **Local Qwen:** `EVAL_QWEN_MODEL=qwen36-cw-iq4-32k npx tsx server/src/analyzer/attribution-eval/run-eval-cli.ts --engine qwen --runs 3`
2. **Cloud Gemma:** `GEMINI_MODEL=gemma-4-31b-it npx tsx …/run-eval-cli.ts --engine gemma --runs 3`
3. **Cloud Flash-lite:** `GEMINI_MODEL=gemini-3.1-flash-lite npx tsx …/run-eval-cli.ts --engine gemma --runs 3`

**Gate (English-scoped, per the spec):**
- **Regression (blocks ship):** treatment mean `raw` < baseline `raw` **min** on any fixture on any target (Coalfall guardrail included).
- **Win:** treatment mean `raw` ≥ baseline `raw` **max** on ch45/ch46 (local Qwen headline).
- **Neutral:** overlapping bands — acceptable.
- **Per-family:** no single raw evidence-family regresses below its baseline min while aggregate raw stays flat (the rule-#4-backfire signature — now visible via Task 3).
- **Secondary:** `det`/`final` don't regress vs. the post-#1752 baseline.
- If a fixture's baseline band spread > ~3 pts, bump that target's `--runs` before judging (local Qwen is cheap).

**Ship logic:** no-regression across all three → ship. Regresses one target only → per-lever bisect or (last resort) per-engine branch. Regresses everywhere → discard/redesign the block.

## After acceptance passes

- **Whole-branch `code-review`** (Premium tier — `feat` multi-file, medium/high effort), fold findings.
- **PR** `feat(server): …` with `Closes #<new issue>` (file a `type:feature`/`area:srv` issue if none exists — the auto-file gate). Fill `## Summary` + `## Test plan` (the three unit tests + the on-box eval numbers).
- **Docs:** update `docs/features/265-attribution-eval-tuning.md` with the Target C cycle and the captured numbers; append the two release-notes entries (a raw-attribution lift is a user-visible delta).
- **Tracked follow-up (same round):** file the RU/DE non-English eval fixture issue (hand-label one Russian + one German chapter, re-run the gate) + its thin `docs/BACKLOG.md` row.

## Self-Review

- **Spec coverage:** rules-block constant + both-builder injection (Task 1) ✓; language-safe block wording verbatim (Task 1 Step 3) ✓; model-label honesty harness change (Task 2) ✓; raw per-family breakdown harness change (Task 3) ✓; English-scoped on-box gate + three-invocation procedure (acceptance section) ✓; RU/DE follow-up (after-acceptance section) ✓. The spec's "manual per-family eyeball fallback" is NOT needed — the families ARE cleanly available at raw-scoring time (reasons align 1:1 raw↔det, confirmed by Opus plan-review against `aligner.ts`/`cross-examine.ts`), which Task 3's second assertion pins; noted so the reviewer knows the primary path was taken deliberately.
- **Test coverage — precise scope:** Task 1's three builder tests and Task 2's three `slotLabel` tests fully cover their production changes. Task 3's unit test covers the **data** change (`run-eval.ts` populating `raw.byFamily`); the **display** change (Task 3 Step 4's `raw ·`-prefixed loop in `printScorecard`) is display-only and stays untested, consistent with the already-untested `printScorecard`/`famLine`/`range` — call this out in the PR body rather than adding a console-capture test.
- **Placeholder scan:** every code step shows the exact code; no TBD/TODO.
- **Type consistency:** `slotLabel(engine: 'qwen'|'gemma'): string` used consistently (named `slotLabel`, not `engineLabel`, to avoid shadowing the existing `analysis.ts` helper); `scoreStage`'s optional third arg `reasons?: Array<{index:number;reason:string}>` matches `stages!.reasons` (`{index,reason,bucket}` — structurally compatible); `printScorecard` reads `f.raw.byFamily` which Task 3 populates.
