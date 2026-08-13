# Dialogue-Convention Invariant + Sound Acceptance Metric — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dialogue-structure engine silently rewriting 879 lines of
character dialogue to `narrator`, and replace plan 247's unsound `flagged ≤ ~500`
acceptance bar with one that cannot be passed by degrading the engine's input.

**Architecture:** One invariant — *a sentence that opens with the language's
dialogue marker is speech by that language's own convention* — applied at the
**two** places the cross-examiner can demote a sentence to narrator. The parser
is not touched, so no book's parse can move. Separately, `EngineReport`'s
`flagged` bucket splits into `flagged` (a genuine model-vs-structure conflict)
and `unresolved` (no evidence either way), because 99.9% of today's `flagged`
is the latter and a bucket with that composition cannot carry a pass/fail bar.

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import specifiers), Vitest,
`tsx` for throwaway replay scripts. All engine code is pure — no I/O, no model
calls — so every behavioural claim in this plan is checkable offline.

**Source spec:** [`docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md`](../specs/2026-08-11-dialogue-convention-invariant-design.md)
**Issues:** `Closes #2253`, `Refs #2254`

## Global Constraints

- **The parser (`server/src/analyzer/dialogue-structure/parser.ts`) is not
  modified by any task in this plan.** Spec §7.2. If a task appears to need a
  parser change, stop and escalate — it is out of scope, not a judgement call.
- **The `flags` array is behaviour, not reporting.** `escalateFlaggedWindows`
  consumes `CrossExamineResult.flags` and `escalation.ts:72-74`'s
  `isFillEligible` keys on the **reason string**. Task 5 moves sentences
  between *report buckets* only — no `decision.flagged` value and no `reason`
  string may change in Task 5.
- **`AnalysisProvenanceReport.unresolved` is an additive OPTIONAL field.**
  `CURRENT_STATE_SCHEMA` does **not** bump (`server/src/workspace/scan.ts:245-247`
  rename-vs-add policy). Old `state.json` files simply lack the key. **Absent
  does not mean zero** — it means the run predates the split, and a reader
  cannot distinguish the two. No reader may default it to 0; nothing reads it
  today, and that must stay true or the ambiguity becomes a bug.
- **This change activates for three languages, not one.** `dialogueOpen` is
  non-null for **ru, es, fr** (`lang/es.ts:5`, `lang/fr.ts:5` — both
  `/^\s*(?:&mdash;|[-–—])\s*/iu`) and null for en/de/ja/zh. Every measurement
  in this plan is Russian: the fixture is ru, the corpus harness's
  `guessLanguage` only ever returns `ru`/`ja`/`en`, and no es/fr book exists in
  the workspace to measure. es/fr therefore ship on **unit coverage only**
  (Task 2 step 1, last case) plus the argument that they use the identical
  paragraph-initial-dash convention. Declare this residual risk in the PR body;
  do not describe the change as verified for es/fr.
- **`dialogueOpen` regexes must not carry the `g` flag.** `ru.dialogueOpen` is
  `/^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu` — no `g`, so `.test()` is stateless. A
  `g`-flagged regex would make `.test()` stateful via `lastIndex` and produce
  alternating results. Do not add one; do not accept one from a caller.
- **New confidence value: none.** The invariant reuses the existing
  `CONFIDENCE.TAG_WEAK_KEEP_FLAG` (0.6). It must stay **below 0.75**, the
  threshold the review UI highlights on (`src/views/manuscript.tsx:415`, `:529`,
  `:1919`), or the recovered lines move a counter without surfacing to the user.
- **Reason string:** `dash-line-keep-flag:<modelId>` — exactly this prefix.
  `evidenceFamily` (Task 6) and the run sheet both key on it.
- **Branch/worktree:** work continues on the existing worktree
  `C:\Claude\Projects\wt-2253-dialogue-turn-segmentation`, branch
  `docs/docs-2253-dialogue-turn-segmentation`. **Rename the branch before the
  first code commit** (Task 2 step 0) — it is no longer a docs branch.
- **Commit convention:** `<type>(<scope>): <subject>`, enforced by
  `.husky/commit-msg`. Scopes used here: `server`, `docs`.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `server/handoff/cache/replay-legibility.mts` | Create (throwaway, gitignored) | 1 |
| `server/src/analyzer/dialogue-structure/cross-examine.ts` | Modify — opts field, invariant helper, two call sites, bucket split | 2, 3, 5 |
| `server/src/analyzer/dialogue-structure/cross-examine.test.ts` | Modify — new unit cases | 2, 3, 5 |
| `server/src/analyzer/dialogue-structure/types.ts` | Modify — `DecisionBucket`, `EngineReport.unresolved` | 5 |
| `server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts` | Modify — bucket enum | 5 |
| `server/src/routes/analysis.ts` | Modify — pass `dialogueOpen`, log line, `aggregateStructureReports` | 4, 6 |
| `server/src/routes/analysis.structure-fixture.test.ts` | Modify — merged-paragraph regressions, tally | 4, 6 |
| `server/src/routes/analysis.test.ts` | Modify — `aggregateStructureReports` cases | 6 |
| `server/src/workspace/scan.ts` | Modify — `AnalysisProvenanceReport.unresolved?` | 6 |
| `server/src/analyzer/attribution-eval/buckets.ts` | Modify — `dash-convention` family | 6 |
| `docs/features/247-dialogue-structure-attribution.md` | Modify — target 1 re-spec | 7 |
| `docs/testing/night-watch-reanalysis-onbox-acceptance.md` | Modify — withdraw §2A.3 refutation, new criteria | 7 |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | Modify — one entry each | 7 |
| `docs/testing/onbox-acceptance-register.md` + live view | Modify — one row | 8 |

**Boundary rationale.** Tasks 2 and 3 patch the same file but are split because
they close **independent** routes to the same defect, and a reviewer can
legitimately accept one and reject the other. Spec §2.1: patching only
`decideSentence` leaves the defect fully intact below the alignment floor, and
**no measurement on the healthy corpus can catch that** — every chapter is above
the floor post-#2187. Task 3 exists so that gap is closed deliberately with its
own test, not folded into Task 2's diff where it would be invisible.

---

## Task 1: Measure the two baselines the metric depends on

The spec leaves two numbers unmeasured. No product code changes in this task.

**The script is written to run TWICE** — once here (baseline) and once in Task 7
step 0 (post-fix, via `POSTFIX=1`). That is not optional polish. Spec §4.2 says
target 1a's threshold is *"calibrated on post-change replay"*, and the fix's
entire mechanism is moving 879 sentences from confidence 0.9 to 0.6 — i.e. from
above the 0.75 threshold to below it. **1a measures exactly the quantity the fix
inflates**, so a threshold set from the baseline alone would be set from the
wrong distribution and would fail on the chapters the fix repairs.

**Files:**
- Create: `server/handoff/cache/replay-legibility.mts` (throwaway; `server/handoff/cache/` is gitignored)
- Modify: `docs/superpowers/plans/2026-08-11-dialogue-convention-invariant.md` (this file — the Measured Baselines appendix at the bottom)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `replay-legibility.mts` itself — Task 7 step 0 re-runs it with `POSTFIX=1`;
  - the **baseline** per-chapter `confidence < 0.75` table, which is the *control*
    against which step 0's post-fix table is read (the threshold comes from the
    post-fix column, never this one);
  - `VICTIM_ERROR_RATE` from the hand-labelled sample, which sets target 1b
    reading 1's bar in Task 7.

**Prerequisites (verify before starting):**
- `C:/Claude/Projects/Audiobook-Generator/server/handoff/cache/mns_oyK7Po6BiT.json`
  exists and is **3,704,853 bytes, dated 2026-08-06 20:49:57**. This is the
  committed analysis cache the whole evidence base rests on. If the size or
  date differs, **stop** — the baseline has been disturbed and every figure in
  the spec needs re-deriving.
- `C:/AudiobookWorkspace/books/Сергей Лукьяненко/The Night Watch Tetralogy/Ночной дозор/manuscript.epub` exists.

- [ ] **Step 1: Write the measurement script**

Create `server/handoff/cache/replay-legibility.mts`:

```ts
/* THROWAWAY (#2253 Task 1). Two numbers the acceptance metric needs:
     LEGIBILITY — per-chapter share of sentences the review UI highlights
                  (confidence < 0.75). Sets target 1a's threshold.
     SAMPLE     — a deterministic 30-victim sample with context, for hand
                  labelling (spec §5). Converts a DISAGREEMENT count into an
                  ERROR rate.
   Run TWICE. Baseline:  cd server && npx tsx handoff/cache/replay-legibility.mts
              Post-fix:  POSTFIX=1 npx tsx handoff/cache/replay-legibility.mts
   POSTFIX=1 threads `dialogueOpen` exactly as production does after Task 4, so
   the second run measures the distribution target 1a is actually graded on. */
import { readFileSync } from 'node:fs';
import { parseManuscript } from '../../src/parsers/index.js';
import { conventionsFor } from '../../src/analyzer/dialogue-structure/lang/index.js';
import { buildNameIndex } from '../../src/analyzer/dialogue-structure/name-matcher.js';
import { parseChapterStructure } from '../../src/analyzer/dialogue-structure/parser.js';
import { resolveWindows } from '../../src/analyzer/dialogue-structure/windows.js';
import { alignSentences } from '../../src/analyzer/dialogue-structure/aligner.js';
import { crossExamine } from '../../src/analyzer/dialogue-structure/cross-examine.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../../src/analyzer/fold-minor-cast.js';

const CACHE = 'C:/Claude/Projects/Audiobook-Generator/server/handoff/cache/mns_oyK7Po6BiT.json';
const NIGHT_WATCH =
  'C:/AudiobookWorkspace/books/Сергей Лукьяненко/The Night Watch Tetralogy/Ночной дозор/manuscript.epub';
const NARRATOR_ID = 'narrator';
const UI_THRESHOLD = 0.75;
const SAMPLE_SIZE = 30;
/* Baseline vs post-fix, and the alignment floor, both via env — NEVER by hand-
   editing this file. It is gitignored, so a forgotten hand edit is invisible to
   git and silently corrupts every later run. */
const POSTFIX = process.env.POSTFIX === '1';
const FLOOR = Number(process.env.FLOOR ?? 80);

const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
const characters = cache.stage1?.characters ?? [];
const conv = conventionsFor('ru')!;
const dashOpen = conv.dialogueOpen!;
const rosterIds = new Set<string>(characters.map((c: any) => c.id));
const unk = new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]);
const gmap = Object.fromEntries(characters.map((c: any) => [c.id, c.gender ?? 'neutral']));
const firstPerson =
  characters.find((c: any) =>
    (c.aliases ?? []).some((a: string) => conv.pronouns.firstPerson?.test(` ${a} `)),
  )?.id ?? null;

const parsed = await parseManuscript({
  buffer: readFileSync(NIGHT_WATCH),
  fileName: 'manuscript.epub',
  sourcePath: NIGHT_WATCH,
});
const bodyById = new Map<number, string>(parsed.chapters.map((c) => [c.id, c.body]));

type Victim = { ch: number; i: number; modelId: string; text: string; prev: string; next: string };
const victims: Victim[] = [];

console.log('LEGIBILITY  ch | sentences | conf<0.75 | share');
let totalN = 0;
let totalLow = 0;
for (const k of Object.keys(cache.chapters)
  .map(Number)
  .sort((a, b) => a - b)) {
  const sentences = cache.chapters[String(k)];
  const body = bodyById.get(k)!;
  const paras = parseChapterStructure(body, buildNameIndex(characters, conv));
  resolveWindows(paras, gmap, firstPerson);
  const ex = crossExamine(alignSentences(sentences, paras, body), {
    rosterIds,
    unknownBucketIds: unk,
    alignmentFloorPct: FLOOR,
    ...(POSTFIX ? { dialogueOpen: conv.dialogueOpen } : {}),
  });
  const low = ex.sentences.filter((s) => s.confidence != null && s.confidence < UI_THRESHOLD).length;
  totalN += ex.sentences.length;
  totalLow += low;
  console.log(
    `            ${String(k).padStart(2)} | ${String(ex.sentences.length).padStart(9)} | ` +
      `${String(low).padStart(9)} | ${((low / ex.sentences.length) * 100).toFixed(1)}%`,
  );
  sentences.forEach((s: any, i: number) => {
    if (!dashOpen.test(s.text ?? '')) return;
    if (s.characterId === NARRATOR_ID) return;
    if (ex.sentences[i]?.characterId !== NARRATOR_ID) return;
    victims.push({
      ch: k,
      i,
      modelId: s.characterId,
      text: s.text,
      prev: sentences[i - 1]?.text ?? '',
      next: sentences[i + 1]?.text ?? '',
    });
  });
}
console.log(
  `LEGIBILITY  BOOK n=${totalN} low=${totalLow} share=${((totalLow / totalN) * 100).toFixed(1)}% ` +
    `mode=${POSTFIX ? 'POSTFIX' : 'baseline'} floor=${FLOOR}`,
);

// Deterministic evenly-spaced sample — no RNG, so the sample is reproducible.
console.log(`\nSAMPLE  ${victims.length} victims total; every ${Math.floor(victims.length / SAMPLE_SIZE)}th\n`);
const stride = Math.max(1, Math.floor(victims.length / SAMPLE_SIZE));
for (let n = 0; n < SAMPLE_SIZE && n * stride < victims.length; n++) {
  const v = victims[n * stride];
  console.log(`--- #${n + 1}  ch${v.ch} idx${v.i}  model=${v.modelId}`);
  console.log(`    prev: ${v.prev.slice(0, 120)}`);
  console.log(`    LINE: ${v.text.slice(0, 160)}`);
  console.log(`    next: ${v.next.slice(0, 120)}`);
}
```

- [ ] **Step 2: Run it and capture the output**

Run: `cd server && npx tsx handoff/cache/replay-legibility.mts > ../scratch-baseline.txt 2>&1 && cat ../scratch-baseline.txt`

Expected: a 9-row LEGIBILITY table, a BOOK line, then `SAMPLE 879 victims total`
and 30 blocks. If the victim total is not **879**, stop — the cache or the EPUB
has changed and the spec's evidence needs re-deriving before continuing.

- [ ] **Step 3: Hand-label the 30 sampled victims**

For each block, read `prev` / `LINE` / `next` and label the LINE:

- `correct` — the model's speaker is right; the engine's `narrator` is wrong.
- `wrong` — `narrator` was right (the "sentence" is a model segmentation
  artefact, or the dash is not a dialogue dash — e.g. a dashed list item or an
  em-dash-led aside).
- `unclear` — cannot tell from three sentences of context.

Record the tally. **Report it honestly, including if it undermines the fix's
headline number.** Then apply this decision rule — it exists so the answer
changes something, rather than being recorded and ignored:

| `wrong` share of 30 | What it means | Action |
|---|---|---|
| 0 | The 879 are real losses. | Target 1b reading 1's bar is `0`. Proceed. |
| 1–5 (≤ ~17%) | Mostly real, with a tail of model segmentation artefacts and non-dialogue dashes. | Bar = the observed share, rounded up, stated with `n=30`. Proceed. |
| > 5 | The trigger is too loose: the fix is manufacturing review stops on lines the narrator held correctly. | **Stop and report before Task 7.** The change direction is still right — a visible uncertainty beats a silent confident error — but the trigger needs narrowing (e.g. requiring the dash be followed by an uppercase letter, or excluding sentences under N characters), and that is a design decision, not an implementation one. |

Note the failure modes to watch for while labelling, since both would inflate
`wrong`: an em-dash opening a *narration* aside rather than a turn, and a
hyphen-initial list item — `ru.dialogueOpen` matches a bare `-` as well as
`–`/`—`.

- [ ] **Step 4: Record both baselines in this plan's appendix**

Fill in the **Measured Baselines** appendix at the bottom of this file: the
9-row legibility table, the book-level share, and the three label counts. These
are the inputs Task 7 reads; leaving them in a scratch file loses them.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-dialogue-convention-invariant.md
git commit -m "docs(docs): record the #2253 legibility baseline and victim sample"
rm ../scratch-baseline.txt
```

---

## Task 2: The convention invariant in `decideSentence`

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts:53-59` (opts), `:204-212` (new helpers above `decideTagSpanOnly`), `:265-274` (the cascade)
- Test: `server/src/analyzer/dialogue-structure/cross-examine.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `CrossExamineOpts.dialogueOpen?: RegExp | null` — optional, so every
    existing caller and test compiles unchanged.
  - Reason string `dash-line-keep-flag:${modelId}` (Task 6 maps it to an
    evidence family; Task 7 names it in the run sheet).
  - Confidence `CONFIDENCE.TAG_WEAK_KEEP_FLAG` (0.6), reused — no new constant.

- [ ] **Step 0: Rename the branch (once, before the first code commit)**

The branch is currently named for a docs change and now carries runtime code.

```bash
cd /c/Claude/Projects/wt-2253-dialogue-turn-segmentation
git branch -m fix/server-2253-dialogue-convention-invariant
```

Then confirm the worktree's hooks are real — a tool-created worktree silently
runs no hooks:

```bash
ls -d .husky/_ && git config core.hooksPath
```

Expected: `.husky/_` exists and `core.hooksPath` prints `.husky/_`. If not, run
`npx husky` in the worktree before committing anything.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/analyzer/dialogue-structure/cross-examine.test.ts`:

```ts
/* #2253 — the dialogue-convention invariant. A sentence that OPENS with the
   language's dialogue marker is speech by that language's own convention;
   tag-only or narration-only structural evidence means the parser failed to
   segment a merged paragraph (#2254), NOT that the line is narration.

   These cases drive the sentence TEXT (not just spans), because the invariant
   is the one rule in this file that reads the text at all. */
describe('#2253 — dialogue-convention invariant (decideSentence)', () => {
  const RU_DASH = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const DASH_OPTS = { ...BASE_OPTS, dialogueOpen: RU_DASH };

  const mkText = (characterId: string, text: string): SentenceOutput => ({
    id: nextId++,
    chapterId: 1,
    characterId,
    text,
  });

  it('tag-only spans: a dash-opening line keeps the model speaker and flags', () => {
    const s = mkText('anton', '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_WEAK_KEEP_FLAG);
    expect(res.sentences[0].confidence).toBeLessThan(0.75); // the UI must highlight it
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
  });

  it('narration-only spans: the SECOND demote route is closed too', () => {
    // decideNarrationOnly reaches `narrator` without any tag span at all —
    // fixing only the tag route would reroute, not fix (this is why a
    // tag-span length bound measured 879 -> 879).
    const s = mkText('anton', '— Не стоит');
    const res = run([aligned(s, [narrationSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
  });

  it('a dash-opening line the model already calls narrator is untouched', () => {
    const s = mkText('narrator', '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
    expect(res.flags).toEqual([]);
  });

  it('a dash-opening line attributed to an unknown-gender bucket is untouched', () => {
    const s = mkText(MALE_BUCKET_ID, '— Не стоит');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.flags).toEqual([]);
  });

  it('a NON-dash sentence with tag-only spans still demotes (unchanged)', () => {
    const s = mkText('anton', 'сказал Антон, не поднимая головы');
    const res = run([aligned(s, [tagSpan()])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
    expect(res.sentences[0].confidence).toBe(CONFIDENCE.TAG_SPAN);
  });

  it('a quote-only language (dialogueOpen null) is byte-identical to today', () => {
    // en/de/ja/zh all carry `dialogueOpen: null`, so the invariant is inert.
    const NULL_OPTS = { ...BASE_OPTS, dialogueOpen: null };
    const withOpt = run([aligned(mkText('anton', '— Не стоит'), [tagSpan()])], 100, NULL_OPTS);
    const without = run([aligned(mkText('anton', '— Не стоит'), [tagSpan()])], 100, BASE_OPTS);
    expect(withOpt.sentences[0].characterId).toBe('narrator');
    expect(without.sentences[0].characterId).toBe('narrator');
  });

  it('es/fr get the same behaviour from their own marker', () => {
    // The invariant activates for THREE languages. es/fr have no book in the
    // workspace corpus and no fixture, so this unit case is their ONLY
    // coverage — see Global Constraints.
    const ES_DASH = /^\s*(?:&mdash;|[-–—])\s*/iu; // lang/es.ts:5, identical in lang/fr.ts:5
    const ES_OPTS = { ...BASE_OPTS, dialogueOpen: ES_DASH };
    const res = run([aligned(mkText('anton', '—No vale la pena'), [tagSpan()])], 100, ES_OPTS);
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
  });

  it('a speech span still wins — the invariant never overrides real evidence', () => {
    const s = mkText('olga', '— Не стоит');
    const res = run([aligned(s, [speechSpan({ characterId: 'anton', source: 'tag-name' })])], 100, DASH_OPTS);
    expect(res.sentences[0].characterId).toBe('anton'); // strong tag-name still force-corrects
  });

  it('a rescued line has no speech span, so escalation drops it at grouping', () => {
    // This adds ~879 entries to `flags` on the reference book, and `flags` is
    // escalation's input. escalateFlaggedWindows groups via
    //   const span = as?.spans.find((s) => s.kind === 'speech');
    //   if (!span || span.windowId === undefined) continue;
    // so a flag whose sentence has NO speech span never becomes a window and
    // consumes ZERO budget. The absence of a speech span is precisely WHY the
    // line was being demoted, so this is structural, not incidental — pin it
    // here rather than relying on `isFillEligible` one layer further down.
    const as = aligned(mkText('anton', '— Не стоит'), [tagSpan()]);
    const res = run([as], 100, DASH_OPTS);
    expect(res.flags).toContainEqual({ index: 0, reason: 'dash-line-keep-flag:anton' });
    expect(as.spans.some((s) => s.kind === 'speech')).toBe(false);
  });
});
```

**Why this last case matters.** Without it the plan would be resting on spec
§4.4's argument, which reasons from `escalation.ts:72-74`'s `isFillEligible`.
That argument reaches the right conclusion by the wrong route: these lines never
reach `isFillEligible` at all — they are dropped one layer earlier, at window
grouping. If they *were* grouped, 879 new flags would create new escalation
windows, consume `maxWindowsPerBook`, starve the genuinely fillable
`unanchored-narrator` lines, and add hours to plan 247's target 5.

- [ ] **Step 2: Retype the test file's `run()` helper — do this BEFORE running**

`cross-examine.test.ts:45-47` currently reads:

```ts
const BASE_OPTS = { rosterIds: ROSTER, unknownBucketIds: UNKNOWN, alignmentFloorPct: 80 };

function run(list: AlignedSentence[], alignedPct = 100, opts = BASE_OPTS) {
```

`opts` has no declared type, so TypeScript infers it from `BASE_OPTS` — a shape
with **no `dialogueOpen`**. Every fresh object literal carrying the new field
then trips excess-property checking. **Vitest runs on esbuild and does not
typecheck, so the tests would pass green and the failure would not surface until
Task 6's `npm run typecheck`, four commits later.** Fix it now:

```ts
import type { CrossExamineOpts } from './cross-examine.js';
```

```ts
const BASE_OPTS: CrossExamineOpts = { rosterIds: ROSTER, unknownBucketIds: UNKNOWN, alignmentFloorPct: 80 };

function run(list: AlignedSentence[], alignedPct = 100, opts: CrossExamineOpts = BASE_OPTS) {
```

This edit is inert until step 3 adds the field, so it can land in the red phase
without weakening it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts -t "#2253"`

Expected: **FAIL**. Cases 1, 2 and 8 (es/fr) fail with
`expected 'narrator' to be 'anton'`. Cases 3–7 already pass — they pin behaviour
that must NOT change; three red is the red phase here.

Also run `cd /c/Claude/Projects/wt-2253-dialogue-turn-segmentation && npm run typecheck`
once at this point. Expected: it names `dialogueOpen` as unknown on
`CrossExamineOpts`. That is the red phase for the type too — and confirms step 2
did not silently mask it.

- [ ] **Step 4: Add the opts field**

In `server/src/analyzer/dialogue-structure/cross-examine.ts`, extend
`CrossExamineOpts` (currently ending at `alignmentFloorPct` on `:58`):

```ts
export interface CrossExamineOpts {
  rosterIds: Set<string>;
  /** MALE_BUCKET_ID / FEMALE_BUCKET_ID from fold-minor-cast.ts */
  unknownBucketIds: Set<string>;
  /** default 80: below → flagOnly (no corrections) */
  alignmentFloorPct: number;
  /** #2253 — the language's paragraph-start dialogue marker, threaded from the
      `LanguageConventions` the caller already resolved. `null`/absent for
      quote-only languages (en/de/ja/zh) and disables the convention invariant
      entirely. MUST NOT carry the `g` flag: `.test()` on a global regex is
      stateful via `lastIndex` and would alternate true/false across calls. */
  dialogueOpen?: RegExp | null;
}
```

- [ ] **Step 5: Add the invariant helpers**

Insert immediately **above** `decideTagSpanOnly` (currently `:204`):

```ts
/** #2253 — the dialogue-convention invariant.

    A sentence that OPENS with the language's dialogue marker is speech by that
    language's own convention. Structural evidence to the contrary means the
    parser failed to segment a merged paragraph (#2254) — not that the line is
    narration. The engine must not assert a speaker it cannot support, but it
    must also not assert `narrator`, which is exactly as strong a claim.

    Deliberately NOT a length heuristic: tag-span size predicts nothing (three
    chapters of the reference book carry 4,767-6,968-char tag spans and produce
    ZERO mis-voiced lines). This asks whether the text declares its own type.

    Limit worth knowing: this reads the MODEL's sentence text. A victim whose
    model output dropped the leading dash is not recovered. */
function isConventionDialogue(as: AlignedSentence, opts: CrossExamineOpts): boolean {
  return opts.dialogueOpen != null && opts.dialogueOpen.test(as.sentence.text ?? '');
}

/** Keep the model's speaker and flag it below the review UI's 0.75 highlight
    threshold. This FLAGS, it does not ATTRIBUTE — the kept speaker may still be
    wrong, and is surfaced as uncertain rather than asserted. */
function decideConventionDialogue(modelId: string): Decision {
  return {
    characterId: modelId,
    confidence: CONFIDENCE.TAG_WEAK_KEEP_FLAG,
    reason: `dash-line-keep-flag:${modelId}`,
    bucket: 'flagged',
    flagged: true,
  };
}
```

- [ ] **Step 6: Wire it into the cascade**

In `decideSentence`, between the `speechSpan` branch (ends `:269`) and the
`as.spans.some((s) => s.kind === 'tag')` branch (`:271`), insert:

```ts
  /* #2253 — before EITHER demote route. Placed above the tag branch (not
     inside decideTagSpanOnly) so it also covers decideNarrationOnly below:
     "no speech span => narrator" has two producers, and guarding only one
     reroutes traffic instead of fixing the outcome. */
  if (isConventionDialogue(as, opts) && !isNarratorOrUnknown(modelId, opts)) {
    block.active = false;
    return decideConventionDialogue(modelId);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts src/analyzer/dialogue-structure/cross-examine-reasons.test.ts src/analyzer/dialogue-structure/escalation.test.ts`

Expected: **PASS**, all files, no test removed or skipped.

Then `npm run typecheck` from the repo root. Expected: clean — step 2's
retyping plus step 4's field must leave zero errors. Do not defer this to
Task 6.

- [ ] **Step 8: Run the whole analyzer suite for collateral damage**

Run: `cd server && npx vitest run src/analyzer src/routes/analysis.structure-fixture.test.ts`

Expected: **PASS**. Nothing should move — the production call site does not pass
`dialogueOpen` until Task 4, so every existing path still has it `undefined`.
A failure here means something reads the field indirectly; investigate, do not
adjust the assertion.

- [ ] **Step 9: Commit**

```bash
git add server/src/analyzer/dialogue-structure/cross-examine.ts server/src/analyzer/dialogue-structure/cross-examine.test.ts
git commit -m "fix(server): keep the model speaker on dash-opening dialogue lines"
```

---

## Task 3: The same invariant at the `flagOnly` call site

Below the 80% alignment floor, `crossExamine` bypasses `decideSentence`
entirely and calls `decideNarrationOnly` directly. Task 2 does not reach that
path. **No measurement on the healthy corpus can detect this** — every chapter
of the reference book is above the floor post-#2187 — so it needs its own test
that forces the condition.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts:311-320`
- Test: `server/src/analyzer/dialogue-structure/cross-examine.test.ts`

**Interfaces:**
- Consumes: `isConventionDialogue(as, opts)` from Task 2 — same signature.
- Produces: no new names.

- [ ] **Step 1: Write the failing test**

Append to the `describe('#2253 — dialogue-convention invariant (decideSentence)')`
block's sibling scope in `cross-examine.test.ts`:

```ts
describe('#2253 — the invariant also holds BELOW the alignment floor', () => {
  const RU_DASH = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const DASH_OPTS = { ...BASE_OPTS, dialogueOpen: RU_DASH };
  const mkText = (characterId: string, text: string): SentenceOutput => ({
    id: nextId++, chapterId: 1, characterId, text,
  });

  it('flagOnly: a dash-opening narration-aligned line is NOT demoted', () => {
    const s = mkText('anton', '— Не стоит');
    // alignedPct 10 < floor 80 -> flagOnly, which bypasses decideSentence.
    const res = run([aligned(s, [narrationSpan()])], 10, DASH_OPTS);
    expect(res.report.flagOnly).toBe(true); // the branch under test really ran
    expect(res.sentences[0].characterId).toBe('anton');
    expect(res.sentences[0].confidence).toBeLessThan(0.75);
    // Below the floor the line falls through to the flag-only pass-through, NOT
    // to `dash-line-keep-flag`. Assert the REASON, which is stable; the bucket
    // is not (Task 5 moves `flag-only-floor` to `unresolved`).
    expect(res.flags).toEqual([{ index: 0, reason: 'flag-only-floor' }]);
  });

  it('flagOnly: a NON-dash narration-aligned line still demotes (unchanged)', () => {
    const s = mkText('anton', 'он молча поднялся по лестнице');
    const res = run([aligned(s, [narrationSpan()])], 10, DASH_OPTS);
    expect(res.report.flagOnly).toBe(true);
    expect(res.sentences[0].characterId).toBe('narrator');
  });

  it('flagOnly: with no dialogueOpen the floor behaviour is unchanged', () => {
    const s = mkText('anton', '— Не стоит');
    const res = run([aligned(s, [narrationSpan()])], 10, BASE_OPTS);
    expect(res.sentences[0].characterId).toBe('narrator');
  });
});
```

- [ ] **Step 2: Run to verify the first case fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts -t "BELOW the alignment floor"`

Expected: **FAIL** on case 1 — `expected 'narrator' to be 'anton'`. Cases 2 and
3 pass already (they pin unchanged behaviour).

**This failure is the whole justification for the task.** If case 1 *passes*
before the edit, stop and investigate: it would mean Task 2's guard is somehow
reached on this path, and the mental model behind both tasks is wrong.

- [ ] **Step 3: Add the guard**

In `crossExamine`, change the `flagOnly` branch condition (`:315`) from:

```ts
      if (isPureNarrationAligned(as) && as.sentence.characterId !== NARRATOR_ID) {
```

to:

```ts
      /* #2253 — the third conjunct. Without it the defect survives intact
         below the floor, and no chapter of the reference corpus is below the
         floor, so no corpus measurement would ever show it. */
      if (
        isPureNarrationAligned(as) &&
        as.sentence.characterId !== NARRATOR_ID &&
        !isConventionDialogue(as, opts)
      ) {
```

A dash-opening line now falls through to `flagOnlyDecision(as)`, which keeps the
model id at `min(modelConfidence, 0.74)` — below the 0.75 UI threshold, so it
still surfaces.

**Consequence to carry into Task 7's criteria:** below the floor a rescued dash
line carries reason `flag-only-floor`, not `dash-line-keep-flag`, and after
Task 5 it is bucketed `unresolved` rather than `flagged`. That is the honest
answer — below the floor the engine reached no verdict at all — but it means
the same sentence contributes to a different counter depending on its chapter's
alignment. Target 1b must say so, or the two readings will look inconsistent to
whoever runs the acceptance.

- [ ] **Step 4: Run to verify all three pass**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts`

Expected: **PASS**, every case in the file.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/cross-examine.ts server/src/analyzer/dialogue-structure/cross-examine.test.ts
git commit -m "fix(server): apply the dialogue-convention invariant below the alignment floor"
```

---

## Task 4: Thread `dialogueOpen` from production + merged-paragraph regressions

Tasks 2 and 3 are inert until the production caller supplies the regex. This
task wires it and proves the fix end to end through the real
parser → windows → aligner → crossExamine pipeline.

**Files:**
- Modify: `server/src/routes/analysis.ts:2224-2228`
- Test: `server/src/routes/analysis.structure-fixture.test.ts`

**Interfaces:**
- Consumes: `CrossExamineOpts.dialogueOpen` (Task 2).
- Produces: nothing new for later tasks.

**Why two merged variants.** The engine reaches `narrator` by two independent
routes, and a regression covering one would pass while the other stayed broken.
Verified against the real fixture with `parseChapterStructure`:

| body | spans produced | route |
|---|---|---|
| fixture as-is (one paragraph per line) | 28 narration, 13 speech, 9 tag; max tag 19 chars | healthy control |
| all lines joined with a space | **1 narration span** | `decideNarrationOnly` |
| joined, with one quoted fragment injected | 1 narration, 1 speech, **1 tag span of 2,393 chars** | `decideTagSpanOnly` — the *Ночной дозор* ch5 shape |

The second variant needs a quote run because `parser.ts:242` only reclassifies
narration→tag when `runs.length > 0`.

**Deviation from spec §6, stated deliberately.** The spec proposed adding a
merged paragraph to `the-coalfall-commission.ru-dash.md`. This plan instead
**derives** both merged bodies from that same fixture inside the test. Reason:
`analysis.structure-fixture.test.ts:227-235` asserts an exact bucket tally
(`confirmed: 5, corrected: 7, flagged: 2, lumped: 0`) that exists as a canary;
editing the fixture perturbs it and destroys the healthy control in the same
change. Deriving costs no fixture content, keeps the control intact, and
reproduces exactly the §1.3 mechanism.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/analysis.structure-fixture.test.ts`:

```ts
/* #2253/#2254 — the SAME scene with its paragraph breaks destroyed, which is
   what Calibre's txt->html EPUB conversion did to Ночной дозор ch4-8. The
   engine loses every speech span and, before this fix, rewrote each dash line
   to `narrator` as a silent, unflagged `corrected` success.

   Two variants because "no speech span => narrator" has TWO producers:
   without a quote run the whole paragraph is one `narration` span
   (decideNarrationOnly); with one it becomes a single 2,393-char `tag` span
   (decideTagSpanOnly) — the real ch5 shape. */
const MERGED_NARRATION_BODY = CHAPTER_BODY.split('\n').join(' ');
const MERGED_TAG_BODY = MERGED_NARRATION_BODY.replace('Ветер с залива', 'Ветер "с залива"');

/* The model's output over a merged paragraph: it still copies the leading dash
   into each sentence, which is the signal the invariant reads. */
function mergedMockSentences(): SentenceOutput[] {
  return [
    { id: 1, chapterId: 1, characterId: 'mairin', confidence: 0.6, text: '— Здесь холодно' },
    { id: 2, chapterId: 1, characterId: 'tobias', confidence: 0.6, text: '— Тьма — это ещё не конец' },
    { id: 3, chapterId: 1, characterId: 'mairin', confidence: 0.6, text: '— Идём' },
  ];
}

describe('#2253 — a merged (paragraph-degraded) chapter keeps its speakers', () => {
  for (const [label, body] of [
    ['narration route (no quote run)', MERGED_NARRATION_BODY],
    ['tag route (one incidental quote run)', MERGED_TAG_BODY],
  ] as Array<[string, string]>) {
    it(`${label}: dash lines keep the model speaker and surface as low-confidence`, async () => {
      const opts = baseOpts(mergedMockSentences());
      opts.chapter = { ...opts.chapter, body };
      const result = await attributeChapterStage2(opts);

      // GUARD: an UNALIGNED sentence also keeps the model id (reason
      // 'unaligned'), so without this the test could pass vacuously on an
      // alignment failure rather than on the fix.
      expect(result.structureReport?.alignedPct).toBe(100);

      expect(result.sentences.map((s) => s.characterId)).toEqual(['mairin', 'tobias', 'mairin']);
      for (const s of result.sentences) {
        expect(s.confidence).toBeLessThan(0.75); // the UI highlights every one
      }
      // Before the fix all three were bucketed `corrected` (silently narratored).
      expect(result.structureReport?.corrected).toBe(0);
    });
  }
});
```

`baseOpts` (same file, `:123-131`) returns a plain object literal whose
`chapter` is `{ id: 1, title: '…', body: CHAPTER_BODY }`, so the override above
works as written. Do not mock `parseChapterStructure` — the point of this test
is that the real parser runs over a real degraded body.

**Verified before writing this task:** none of the healthy fixture's 14 mock
sentence texts begins with a dash (`analysis.structure-fixture.test.ts:79-108`),
and every one of its dialogue lines carries a speech span — so the invariant
cannot fire on the healthy control, and step 4's "tally unchanged" expectation
is a prediction with a reason behind it, not a hope.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/routes/analysis.structure-fixture.test.ts -t "#2253"`

Expected: **FAIL** on both variants — `expected [ 'narrator', 'narrator', 'narrator' ] to deeply equal [ 'mairin', 'tobias', 'mairin' ]`.

If instead `alignedPct` is not 100, the mock sentence texts do not match the
merged body; fix the texts against the fixture, not the assertion.

- [ ] **Step 3: Pass `dialogueOpen` at the production call site**

In `server/src/routes/analysis.ts`, `conventions` is already in scope from
`:2214`. Change `:2224-2228` from:

```ts
    const examined = crossExamine(alignment, {
      rosterIds,
      unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
      alignmentFloorPct: 80,
    });
```

to:

```ts
    const examined = crossExamine(alignment, {
      rosterIds,
      unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
      alignmentFloorPct: 80,
      /* #2253 — the language's own turn marker, so a merged paragraph (#2254)
         costs the engine its structural evidence but not the speaker. */
      dialogueOpen: conventions.dialogueOpen,
    });
```

- [ ] **Step 4: Run to verify they pass, and the healthy control is untouched**

Run: `cd server && npx vitest run src/routes/analysis.structure-fixture.test.ts`

Expected: **PASS** — both new cases, **and** the pre-existing tally case
(`confirmed: 5, corrected: 7, flagged: 2, lumped: 0`) unchanged. The healthy
fixture's mock sentences carry no leading dash, and its dialogue lines all have
speech spans, so the invariant cannot fire there.

**If the healthy tally moved, stop.** That means the invariant is firing on
structurally-intact dialogue, which it must never do; report it rather than
re-baselining the numbers.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.structure-fixture.test.ts
git commit -m "fix(server): thread dialogue conventions into the cross-examiner"
```

---

## Task 5: Split `flagged` into `flagged` + `unresolved`

99.9% of today's `flagged` is "no evidence either way" (2,442 `unanchored-named`
+ 1,007 `unanchored-narrator` + 597 `unaligned` against **5** genuine
conflicts). A bucket with that composition cannot carry a pass/fail bar.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/types.ts:47-60`
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts:61` (local `Bucket`), `:82-90`, `:94-111`, `:247-256`, `:292-302`
- Modify: `server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts:40`
- Test: `server/src/analyzer/dialogue-structure/cross-examine.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 2–4 (independent), though `dash-line-keep-flag`
  must land in `flagged`.
- Produces:
  - `DecisionBucket` = `'confirmed' | 'corrected' | 'flagged' | 'unresolved' | 'lumped'`
  - `EngineReport.unresolved: number` (required on `EngineReport`; Task 6 makes
    it optional only on the persisted `AnalysisProvenanceReport`)
  - Invariant Task 6 relies on: `flagged + unresolved` equals the old `flagged`.

**Bucket assignment — the complete map:**

| reason | old bucket | new bucket | why |
|---|---|---|---|
| `unanchored-named:*` | flagged | **unresolved** | model named someone, no structural evidence either way |
| `unanchored-narrator` | flagged | **unresolved** | same, with a placeholder answer |
| `unaligned` | flagged | **unresolved** | the engine never saw the sentence |
| `flag-only-floor` | flagged | **unresolved** | the whole chapter is untrusted — no verdict was reached at all |
| `pronoun-keep-flag:*` | flagged | flagged | model contradicts a resolved pronoun |
| `tag-weak-keep-flag:*` | flagged | flagged | model contradicts a beat tag |
| `alt-keep-flag:*` | flagged | flagged | model contradicts alternation |
| `unexpected-source:*` | flagged | flagged | a real invariant breach, must stay loud |
| `dash-line-keep-flag:*` | flagged (new, Task 2) | flagged | convention contradicts structure — a genuine conflict |
| `lumped` | lumped | lumped | unchanged |
| everything else | confirmed/corrected | unchanged | unchanged |

Note `flag-only-floor` overrides `dash-line-keep-flag` below the floor: Task 3
routes a dash line there, and below the floor the engine genuinely reached no
verdict, so `unresolved` is the honest bucket.

- [ ] **Step 1: Write the failing tests**

Append to `cross-examine.test.ts`:

```ts
describe('#2253 — flagged splits into flagged (conflict) and unresolved (no verdict)', () => {
  const RU_DASH = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const mkText = (characterId: string, text: string): SentenceOutput => ({
    id: nextId++, chapterId: 1, characterId, text,
  });

  it('unanchored speech is unresolved, not flagged', () => {
    const res = run([aligned(mkSentence('anton'), [speechSpan()])]);
    expect(res.report.unresolved).toBe(1);
    expect(res.report.flagged).toBe(0);
  });

  it('an unaligned sentence is unresolved', () => {
    const res = run([aligned(mkSentence('anton'), [])]);
    expect(res.report.unresolved).toBe(1);
    expect(res.report.flagged).toBe(0);
  });

  it('below the floor, flag-only pass-through is unresolved', () => {
    const res = run([aligned(mkSentence('anton'), [speechSpan()])], 10);
    expect(res.report.flagOnly).toBe(true);
    expect(res.report.unresolved).toBe(1);
    expect(res.report.flagged).toBe(0);
  });

  it('a genuine conflict stays flagged', () => {
    const res = run([
      aligned(mkSentence('olga'), [speechSpan({ characterId: 'anton', source: 'tag-pronoun' })]),
    ]);
    expect(res.report.flagged).toBe(1);
    expect(res.report.unresolved).toBe(0);
  });

  it('the convention invariant lands in flagged, not unresolved', () => {
    const res = run([aligned(mkText('anton', '— Не стоит'), [tagSpan()])], 100, {
      ...BASE_OPTS,
      dialogueOpen: RU_DASH,
    });
    expect(res.report.flagged).toBe(1);
    expect(res.report.unresolved).toBe(0);
  });

  it('the flags array — escalation input — is unchanged by the split', () => {
    // isFillEligible keys on the REASON string, so escalation must see exactly
    // the same entries it saw before the buckets moved.
    const res = run([
      aligned(mkSentence('narrator'), [speechSpan()]),
      aligned(mkSentence('anton'), []),
    ]);
    expect(res.flags).toEqual([
      { index: 0, reason: 'unanchored-narrator' },
      { index: 1, reason: 'unaligned' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts -t "flagged splits"`

Expected: **FAIL** — `report.unresolved` is `undefined`, so
`expect(undefined).toBe(1)` fails on the first five cases. The last case
(`flags` unchanged) passes already; it is the regression lock, not a red case.

- [ ] **Step 3: Extend the types**

In `server/src/analyzer/dialogue-structure/types.ts`:

```ts
export type DecisionBucket = 'confirmed' | 'corrected' | 'flagged' | 'unresolved' | 'lumped';

export interface EngineReport {
  language: string | null;
  alignedPct: number;
  confirmed: number;
  corrected: number;
  /** #2253 — a genuine CONFLICT: the model contradicts structural evidence
      (pronoun / weak tag / alternation), or the language's dialogue convention
      contradicts the structure. Was 99.9% diluted by `unresolved` below, which
      is why it could not carry an acceptance bar. */
  flagged: number;
  /** #2253 — NO VERDICT: aligned but with no evidence either way (unanchored
      speech), never aligned at all, or a chapter below the alignment floor
      where correction was disabled wholesale. `flagged + unresolved` equals
      the pre-#2253 `flagged`. */
  unresolved: number;
  lumped: number;
  escalated: number;
  escalationAccepted: number;
  /** true when alignment fell below the floor and correction was disabled */
  flagOnly: boolean;
}
```

- [ ] **Step 4: Move the four reasons into the new bucket**

In `cross-examine.ts`:

1. Widen the local alias on `:61`:

```ts
type Bucket = 'confirmed' | 'corrected' | 'flagged' | 'unresolved' | 'lumped';
```

2. `flagOnlyDecision` — change `bucket: 'flagged'` to `bucket: 'unresolved'`.
   Leave `flagged: true` and the reason string alone.

3. `decideUnanchoredSpeech` — change `bucket: 'flagged'` to
   `bucket: 'unresolved'` in **both** the named and the narrator branch.

4. The `as.spans.length === 0` branch in `decideSentence` — change
   `bucket: 'flagged'` to `bucket: 'unresolved'`.

5. Initialise the counter in `crossExamine`'s `report` literal, after `flagged: 0,`:

```ts
    flagged: 0,
    unresolved: 0,
```

Leave `decideAnchoredSpeech`, `decideConventionDialogue`, and the `lumped`
branch untouched.

- [ ] **Step 5: Update the bucket enum in the reasons test**

`server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts:40`:

```ts
      expect(['confirmed', 'corrected', 'flagged', 'unresolved', 'lumped']).toContain(result.reasons[i].bucket);
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/`

Expected: **PASS**, every file in the directory. `escalation.test.ts` in
particular must be green without edits — it asserts on `flags` and reasons, not
buckets.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/dialogue-structure/types.ts server/src/analyzer/dialogue-structure/cross-examine.ts server/src/analyzer/dialogue-structure/cross-examine.test.ts server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts
git commit -m "feat(server): split the flagged bucket into flagged and unresolved"
```

---

## Task 6: Propagate `unresolved` to every consumer

**Files:**
- Modify: `server/src/routes/analysis.ts:2271-2275` (log), `:2334-2366` (aggregate)
- Modify: `server/src/workspace/scan.ts:287-298`
- Modify: `server/src/analyzer/attribution-eval/buckets.ts`
- Test: `server/src/routes/analysis.test.ts:3157-3210`, `server/src/routes/analysis.structure-fixture.test.ts:222-235`

**Interfaces:**
- Consumes: `EngineReport.unresolved` (Task 5), reason `dash-line-keep-flag:*` (Task 2).
- Produces: `AnalysisProvenanceReport.unresolved?: number`; `EvidenceFamily` gains `'dash-convention'`.

**The one non-obvious edit.** `aggregateStructureReports`'s `alignedPct` is a
**weighted** mean with `weight = confirmed + corrected + flagged + lumped` —
"every sentence crossExamine classified". Task 5 moved most of `flagged` into
`unresolved`, so leaving the weight alone silently under-weights every chapter
and skews the book-level `alignedPct`. The weight must gain `unresolved`.

- [ ] **Step 1: Write the failing tests**

First, the helper. `analysis.test.ts:3158-3171` defines

```ts
  function makeReport(overrides: Partial<EngineReport>): EngineReport {
    return {
      language: 'en', alignedPct: 100, confirmed: 0, corrected: 0, flagged: 0,
      lumped: 0, escalated: 0, escalationAccepted: 0, flagOnly: false,
      ...overrides,
    };
  }
```

It is a **fully-typed `EngineReport` literal**, so Task 5's required
`unresolved` field breaks it at compile time. Add `unresolved: 0,` next to
`flagged: 0,` in the defaults. Every existing case then keeps working unchanged.

Then append inside the same `describe('aggregateStructureReports …')` block,
using the helper rather than raw literals:

```ts
  it('#2253 — sums unresolved and counts it toward the alignedPct weight', () => {
    // Chapter A: 100 classified sentences, 90 of them unresolved, 100% aligned.
    // Chapter B: 10 classified sentences, all confirmed, 0% aligned.
    // If `unresolved` is left out of the weight, A weighs 10 instead of 100 and
    // the book reads ~9% aligned instead of ~91% — an inverted headline number.
    const chapterA = makeReport({ alignedPct: 100, confirmed: 10, unresolved: 90 });
    const chapterB = makeReport({ alignedPct: 0, confirmed: 10, flagOnly: true });
    const result = aggregateStructureReports([chapterA, chapterB]);
    expect(result?.unresolved).toBe(90);
    expect(result?.alignedPct).toBeCloseTo((100 * 100 + 0 * 10) / 110, 5);
  });
```

Then update `analysis.structure-fixture.test.ts:222-235`. The fixture's two
flags are both `unanchored-narrator` (the file's own header inventory says Zone
C's trailing untagged turns "stay genuinely unanchored"), so they become
`unresolved`:

```ts
  it('structureReport: corrected > 0 and unresolved > 0, with the exact bucket tally the fixture is designed to produce', async () => {
    const result = await attributeChapterStage2(baseOpts(mockSentences()));

    expect(result.structureReport?.corrected).toBeGreaterThan(0);
    // #2253 — the fixture's two flags are both `unanchored-narrator`, i.e. "no
    // evidence either way", which is now `unresolved` rather than `flagged`.
    expect(result.structureReport?.unresolved).toBeGreaterThan(0);
    expect(result.structureReport).toMatchObject({
      language: 'ru',
      alignedPct: 100,
      confirmed: 5,
      corrected: 7,
      flagged: 0,
      unresolved: 2,
      lumped: 0,
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "aggregateStructureReports" src/routes/analysis.structure-fixture.test.ts -t "structureReport"`

Expected: **FAIL** — `result?.unresolved` is `undefined` in the aggregate case;
the fixture case fails on `flagged: 0, unresolved: 2`.

- [ ] **Step 3: Update `aggregateStructureReports`**

In `server/src/routes/analysis.ts:2334-2366`, add the accumulator, the sum, the
weight term, and the output field:

```ts
  let flagged = 0;
  let unresolved = 0;
```

```ts
    flagged += r.flagged;
    unresolved += r.unresolved;
    escalated += r.escalated;
    escalationAccepted += r.escalationAccepted;
    /* #2253 — `unresolved` was carved out of `flagged`; omitting it here would
       silently shrink each chapter's weight and skew the book alignedPct. */
    const weight = r.confirmed + r.corrected + r.flagged + r.unresolved + r.lumped;
```

```ts
    confirmed,
    corrected,
    flagged,
    unresolved,
    escalated,
    escalationAccepted,
```

Also update the doc comment above the function (`:2328-2329`), which enumerates
the plain-sum fields, to include `unresolved`.

- [ ] **Step 4: Update the operator log line**

`server/src/routes/analysis.ts:2272-2274` — this is the only operator-visible
surface for these counters:

```ts
        `confirmed=${examined.report.confirmed} corrected=${examined.report.corrected} ` +
        `flagged=${examined.report.flagged} unresolved=${examined.report.unresolved} ` +
```

- [ ] **Step 5: Add the persisted field**

`server/src/workspace/scan.ts`, in `AnalysisProvenanceReport`:

```ts
  flagged: number;
  /* #2253 — "no verdict" sentences, split out of `flagged`. Additive OPTIONAL
     field: `CURRENT_STATE_SCHEMA` does NOT bump (see the rename-vs-add policy
     above), state.json files written before this landed simply lack the key,
     and no reader may require it. Always written by
     `aggregateStructureReports` going forward. */
  unresolved?: number;
```

- [ ] **Step 6: Give the new reason an evidence family**

`server/src/analyzer/attribution-eval/buckets.ts` — without this,
`dash-line-keep-flag:*` lands in `other` and the eval's per-family accuracy
cannot separate it:

```ts
export type EvidenceFamily =
  | 'tag' | 'pronoun' | 'alternation' | 'unanchored' | 'narration'
  | 'dash-convention' | 'lumped' | 'unaligned' | 'other';

export function evidenceFamily(reason: string): EvidenceFamily {
  if (reason.startsWith('tag-')) return 'tag';
  if (reason.startsWith('pronoun-')) return 'pronoun';
  if (reason.startsWith('alt-')) return 'alternation';
  if (reason.startsWith('unanchored')) return 'unanchored';
  if (reason.startsWith('narration')) return 'narration';
  // #2253 — the dialogue-convention invariant: the language's turn marker
  // contradicted the (parser-degraded) structural evidence.
  if (reason.startsWith('dash-line-')) return 'dash-convention';
  if (reason === 'lumped') return 'lumped';
  if (reason === 'unaligned') return 'unaligned';
  return 'other';
}
```

- [ ] **Step 7: Run to verify they pass, then typecheck**

Run: `cd server && npx vitest run src/routes/analysis.test.ts src/routes/analysis.structure-fixture.test.ts src/analyzer/`

Expected: **PASS**.

Run: `cd /c/Claude/Projects/wt-2253-dialogue-turn-segmentation && npm run typecheck`

Expected: clean. The full set of `EngineReport`-shaped literals in the tree was
enumerated before this plan was written, so there should be no surprises:

| site | shape | breaks? |
|---|---|---|
| `analysis.test.ts:3158` `makeReport` | typed `EngineReport` | **yes** — fixed in step 1 |
| `analysis.structure-fixture.test.ts:227` | `toMatchObject` | no — partial match |
| `analysis.structure-engine.test.ts:99` | `toMatchObject` | no — partial match |
| `analysis.test.ts:3398`, `:3599`, `book-state.reparse.test.ts:605` | `AnalysisProvenanceReport` | no — field is optional |
| `cross-examine.ts` `report` literal | typed `EngineReport` | **yes** — fixed in Task 5 step 4 |

Any error *outside* that table is a consumer this enumeration missed — fix it
and declare it in the PR body rather than casting it away.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts server/src/routes/analysis.structure-fixture.test.ts server/src/workspace/scan.ts server/src/analyzer/attribution-eval/buckets.ts
git commit -m "feat(server): report unresolved separately from flagged"
```

---

## Task 7: Re-spec plan 247 target 1, and correct the run sheet

The metric work #2253 was actually filed about. Also corrects a published
refutation computed on the wrong column.

**Files:**
- Modify: `docs/features/247-dialogue-structure-attribution.md:267-269`
- Modify: `docs/testing/night-watch-reanalysis-onbox-acceptance.md:239`, `:303-324`
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: Task 1's baseline table, the **post-fix** table from step 0 below,
  and the hand-label tally.
- Produces: the acceptance criteria the next on-box run is judged against.

- [ ] **Step 0: Measure post-fix legibility — 1a cannot be set without it**

All the code is landed as of Task 6, so re-run Task 1's script in post-fix mode:

Run: `cd server && POSTFIX=1 npx tsx handoff/cache/replay-legibility.mts`

Expected: the BOOK line reads `mode=POSTFIX`, and the book-level `low` count is
**higher than Task 1's baseline by roughly 879** — the rescued lines moved from
0.9 to 0.6, which is from above the 0.75 threshold to below it.

**This is the whole reason the step exists.** Target 1a is the share of
sentences under 0.75; the fix inflates that share by construction. Calibrating
1a on the baseline table would set the bar from a distribution this change
demolishes, and the chapters the fix repairs would then fail the target — a
metric that punishes the correct change, which is the same class of defect
#2253 was filed about.

Record the post-fix table in the appendix beside the baseline one, and note the
delta per chapter. Expect ch1/ch2/ch3/ch9 **unchanged** (0 victims each) and
ch4–8 up.

- [ ] **Step 1: Replace plan 247's target 1**

In `docs/features/247-dialogue-structure-attribution.md`, replace target 1
(currently "Flagged sentences land at triage scale — target ≤ ~500 …") with:

```markdown
1. **Legibility and engine health, replacing the original absolute `flagged
   ≤ ~500` bar** (re-specified 2026-08-11 via #2253; the original was unsound —
   it was absolute over chapters varying 3× in length, and a chapter could pass
   it by giving the engine LESS to see. Design of record:
   `docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md`).

   **1a — Legibility.** Share of a chapter's sentences with `confidence < 0.75`
   — the set the review UI actually highlights (`src/views/manuscript.tsx:415`,
   `:529`, `:1919`) — at or below **<THRESHOLD>%**. Defined over confidence, not
   over a report bucket, because nothing in `src/` or `openapi.yaml` reads
   `structureReport` at all; a bucket-defined 1a would report ~0.03% while the
   UI coloured a quarter of the chapter.

   **What a 1a breach means.** 1a grades the *manuscript's* legibility, not the
   engine's correctness — the two are separable and this criterion is
   deliberately the former. A chapter whose source lost its paragraph structure
   (#2254) will breach 1a **because the engine is correctly refusing to guess**,
   and that breach is the intended signal: it says *re-convert this source*, not
   *the engine regressed*. A breach is therefore a real failure with a specific
   remedy, never grounds for widening the threshold. The threshold is set from
   structurally-intact chapters precisely so a degraded one cannot hide inside
   it.

   **1b — Engine health.** Three readings, interpreted together, never alone:
   1. **Victim rate ≤ <VICTIM_BAR>%** — sentences opening with the language's
      dialogue marker that the engine demoted to `narrator` against the model,
      as a share of dialogue-marker-opening sentences. Stated as a rate with a
      named denominator so it cannot be passed by shrinking the numerator's
      population.
   2. **`unresolved` share** — the coverage disclosure that separates "few
      conflicts because attribution is confident" from "few conflicts because
      nothing was examined".
   3. **`alignedPct` and `flagOnly`** — because reading 1 and reading 2 land in
      *different counters* depending on the chapter. Above the alignment floor a
      rescued dialogue line is `dash-line-keep-flag`, bucket `flagged`. Below
      it, the whole chapter is `flag-only-floor`, bucket `unresolved` — the
      engine reached no verdict at all, so the conflict was never adjudicated.
      Same sentence, different counter. Reading `flagged` without `flagOnly`
      beside it will look like the conflict count collapsed when in fact the
      chapter was never examined.

   **Explicitly rejected: a "narrator delta ≈ 0" invariant.** Below the
   alignment floor `flagOnly` passes the model's id through verbatim on every
   sentence carrying a speech span, so the engine column equals the model column
   and the delta is 0 by construction — and turning `analyzer.structure.enabled`
   off gives 0 too. It reproduced the exact flaw it was written to close.
```

Replace `<THRESHOLD>` from **step 0's POSTFIX table, not Task 1's baseline**:
take the worst structurally-intact chapter (ch1/2/3/9 — the four with zero
victims, whose share the fix does not move), round up to the next whole
percent, add 5 points of headroom. Write the derivation in one sentence beside
the number, naming which chapter set it, so the next person can tell a
recalibration from a fudge.

Sanity check before writing it: ch1/2/3/9's post-fix shares must equal their
baseline shares. If any moved, the invariant is firing on a structurally-intact
chapter and Task 4's control assumption is wrong — stop and investigate rather
than taking the higher number.

Replace `<VICTIM_BAR>` with `0` if Task 1's hand-label tally found no `wrong`
labels, otherwise the labelled `wrong` share rounded up — and say which, with
the sample size (30) alongside, so the bar is legible as an estimate rather
than a measurement.

Also update the plan-header note at `:11` and the "Target 1 … is not yet
re-measured end to end" paragraph at `:378-382` to point at the new criteria.

- [ ] **Step 2: Withdraw the run sheet's refutation**

`docs/testing/night-watch-reanalysis-onbox-acceptance.md:318-324` currently
reads *"Refuted, and recorded so it is not re-proposed: the hypothesis that (3)
causes the known 28.2% narrator collapse."* That was computed on the **model's**
`characterId` column — the engine's *input*. Replace the whole block with:

```markdown
**Withdrawn (2026-08-11).** This section previously recorded that finding (3)
was refuted as a cause of the narrator collapse (`corr = −0.073`). That
correlation was computed on the **model's** `characterId` column, which is the
engine's *input*, not its output. Re-measured on the engine's output column,
ch5's dash lines are **69.7% narrator against the model's 11.4%**, and the
degradation drives the collapse directly: **879 lines book-wide** are rewritten
character→narrator, unflagged, and booked as `corrected` successes. Zero on
every structurally-intact chapter, 58.3% on ch5.

Fixed by the dialogue-convention invariant in `cross-examine.ts` (#2253);
design of record
`docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md`.
A tag-span length bound was also prototyped and measured a **complete no-op**
(879 → 879) — un-tagging a span leaves it `narration`, which demotes too. Do
not re-propose it.
```

Then update the acceptance row at `:239` (`| `flagged` | **≤ ~500** …`) to the
1a/1b criteria from step 1, and add a `unresolved` row beside it.

- [ ] **Step 3: Release notes, both files**

Append to `docs/release-notes-next.md` under the in-progress version section:

```markdown
- **Dialogue lines in badly-converted EPUBs no longer silently become narration.**
  When a source file loses its paragraph breaks, the structure engine loses the
  speech spans it reasons from and used to rewrite every affected dialogue line
  to `narrator` as an unflagged correction — 879 lines on the reference book.
  A line that opens with the language's own dialogue marker now keeps its
  speaker and is surfaced as low-confidence instead. (#2253, PR #NNNN)
- **`structureReport` splits `flagged` into `flagged` and `unresolved`** so a
  genuine model-vs-structure conflict is countable separately from "no evidence
  either way", which was 99.9% of the old bucket. Additive optional field on
  `analysisProvenance.report`; no schema bump. (#2253, PR #NNNN)
```

And to the in-progress version section at the top of `RELEASE_NOTES.md`:

```markdown
- Books converted from plain text sometimes arrive with their paragraph breaks
  missing. Castwright used to read those chapters as narration and quietly
  reassign the dialogue to the narrator. Now it keeps the speaker it found and
  marks the line for your review instead — so a rough conversion costs you a
  read-through, not your cast.
```

Replace `#NNNN` with the PR number once Task 8 opens it.

- [ ] **Step 4: Commit**

```bash
git add docs/features/247-dialogue-structure-attribution.md docs/testing/night-watch-reanalysis-onbox-acceptance.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): re-specify plan 247 target 1 and withdraw the refuted finding"
```

---

## Task 8: Corpus verification, acceptance row, follow-ups, PR

**Files:**
- Modify: `docs/testing/onbox-acceptance-register.md`
- Modify: `docs/testing/onbox-acceptance-register-live-view.html`
- Create: two GitHub issues

**Interfaces:**
- Consumes: everything.
- Produces: the merged PR.

- [ ] **Step 1: Verify the corpus gate and the harm signature**

The 17-book structure hash cannot be a repo test — it needs the workspace
EPUBs, which are not in the repo. Run the existing harness instead:

Run: `cd server && npx tsx handoff/cache/replay-experiment.mts`

Expected, against the shipped (post-roster-fix) values — see the "Measured
Baselines" appendix below, not spec §2.3's pre-roster-fix table:
- `HARM TOTAL victims=41` (was 879) — not 0: the rescue guard also requires
  roster membership, and 41 lines carry off-roster ids
  (`борис-игнатьевич` ×17, `егор` ×24) that demote to `narrator` downstream
  regardless, so they were never actually recoverable
- controls ch1 / ch2 / ch3 / ch9 still `victims=0`
- every one of the 17 `GATE` hashes **identical** to the baseline. This is
  guaranteed by construction — no task in this plan touches the parser — so any
  moved hash means something outside this plan's scope changed. Stop and
  investigate rather than re-baselining.

Then prove Task 3 actually closed the bypass, which nothing else in this plan
does at corpus level. **Do not hand-edit the floor** — the harness is gitignored,
so a forgotten edit is invisible to git and silently corrupts every later run.
Make it an env read instead, matching `replay-legibility.mts`: change
`alignmentFloorPct: 80` to `alignmentFloorPct: Number(process.env.FLOOR ?? 80)`
once, then:

Run: `cd server && FLOOR=100 npx tsx handoff/cache/replay-experiment.mts`

Expected: `HARM TOTAL victims=41` (not 0, same roster-membership reason as
above) with every chapter in `flagOnly`. Post-#2187 no
chapter of this book is below the floor naturally, so **this run is the only
evidence Task 3 has**.

**What these two runs can and cannot show.** `GATE` never calls `crossExamine` —
it hashes parser output with an empty roster, so it is unchanged by this fix
*whether or not the fix is correct*. It detects out-of-scope parser drift and
nothing else. `HARM` is therefore the only cross-examine-level corpus
measurement in the plan, and it covers **one Russian book**. Spanish and French
are activated by Task 4 and measured by nothing — see Global Constraints, and
say so in the PR body.

Record all four numbers (victims, controls, hashes, forced-floor victims) in the
PR body.

- [ ] **Step 2: Run the local gate**

Run: `cd /c/Claude/Projects/wt-2253-dialogue-turn-segmentation && npm run verify:fast:branch`

Expected: green. This is the same battery pre-push runs.

- [ ] **Step 3: Add the on-box acceptance row**

This PR ships engine behaviour proven only by offline replay over one book's
cached analysis. What replay cannot prove: that a real end-to-end analysis run
produces the same buckets, and that `escalated`/`escalationAccepted` behave
with the new bucket split. Add one row to
`docs/testing/onbox-acceptance-register.md` under the "real analyzer + real
book" hardware group:

- **What to observe:** re-run Ночной дозор analysis; `[analysis:structure]`
  log lines show `unresolved=` populated and `flagged=` at conflict scale
  (order 10²/book, not 10³); ch5's dash-opening sentences are no longer
  narrator; `state.json`'s `analysisProvenance.report` carries `unresolved`.
- **Hardware prerequisites:** local Ollama with `qwen36-cw-iq4-32k`, ~14 GB
  VRAM free, sidecar suppressed (`DISABLE_AUTOSTART_SIDECAR=1`).
- **Where the criteria live:** `docs/testing/night-watch-reanalysis-onbox-acceptance.md`
  (add a §2A.5 for it), and plan 247's re-specified target 1.

Then update `docs/testing/onbox-acceptance-register-live-view.html` — the
hand-authored styled page, **not** a render of the markdown — recomputing the
owed count, group counts and oldest debt.

Run: `npm run check:onbox-register`

Expected: green.

Before publishing, save the page currently live at the URL in the register
header to a local file and run:

`npm run check:onbox-register -- --against-published <file>`

Stop if it disagrees. Then publish the **HTML file** with the register's
recorded `url`, never a fresh publish and never the `.md`.

- [ ] **Step 4: File the two follow-ups**

Both are real deferrals the spec argues for, and both are lost if they live only
in a spec section.

1. **Is *Unlocked* (English) actually harmed?** Spec §3. Only its *exposure* is
   measured (49.6% of tag text in >500-char spans, max 2,765); it has never
   been analysed, so it has no model column and its victim count is
   **unmeasurable from what is on disk**. §1.4 proves exposure does not imply
   harm. Acceptance: analyse it, run the two-column comparison, and only then
   decide whether an English arm (leading-`quotePairs` opener) is warranted.
   Labels `type:feature`, `area:srv`, `moscow:` left unset.
2. **Intra-paragraph turn segmentation — recovery, not just flagging.** Spec
   §7.2, "deferred, not forbidden". #2253 flags the 879 lines; it does not
   recover their speakers. Segmentation is the only route that does, and it
   carries corpus-wide risk (`windows.ts:92-101` assigns speakers by index
   parity, so a boundary error mis-voices a run of dialogue silently rather
   than flagging it). Needs its own evidence and its own regression gate.
   Labels `type:feature`, `area:srv`.

For each `type:feature` issue, re-run `npm run backlog:sync` so its row lands in
`docs/BACKLOG.md`.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin fix/server-2253-dialogue-convention-invariant
gh pr create --title "fix(server): keep dialogue speakers when a paragraph loses its structure" --body-file <path>
```

The body must contain:
- `Closes #2253` and `Refs #2254` (literal, not backticked — a backticked
  `Closes` does not auto-close).
- The measured before/after table from spec §2.3, plus this run's Step 1
  numbers.
- The **deviation from spec §6** declared in Task 4 (derived merged bodies
  rather than an edited fixture) and why.
- The two follow-up issue numbers from Step 4.
- Any incidental fixes made in passing, per CLAUDE.md's report-judge-dispatch
  protocol ("Also fixed, found in passing: …").

- [ ] **Step 6: Run the mandatory review gate**

Invoke the `pr-review-gate` skill at **`medium`** effort — this is a
single-scope `fix` PR by CONTRIBUTING.md's commit-type split. It is not
docs-only, so the exemption does not apply. Triage and fold findings before
merge; never auto-apply.

- [ ] **Step 7: Merge**

Merge with the "Create a merge commit" button once `verify.yml` and
`pr-issue-link` are green. Then tear the worktree down: drop the
`node_modules` junctions first (`[System.IO.Directory]::Delete($p, $false)`),
then remove the worktree.

---

## Measured Baselines

*Baseline half filled in by Task 1 (2026-08-11). Post-fix columns, the worst-
structurally-intact-chapter line, and the target 1a threshold line are left for
Task 7 step 0 — this is the pre-fix distribution the post-fix run is read
against, never the threshold source itself. Measured on the committed cache
`mns_oyK7Po6BiT.json` (3,704,853 bytes, 2026-08-06 20:49:57) against
`Ночной дозор/manuscript.epub`, via `server/handoff/cache/replay-legibility.mts`
(baseline mode, `FLOOR=80` default).*

### Legibility — `confidence < 0.75` share per chapter

Two runs. The **post-fix** column is the one target 1a is derived from; the
baseline is kept beside it so the fix's effect on the metric is visible rather
than assumed.

| ch | sentences | baseline conf<0.75 | baseline share | post-fix conf<0.75 | post-fix share | delta |
|---|---|---|---|---|---|---|
| 1 | 2777 | 729 | 26.3% | 729 | 26.3% | 0 |
| 2 | 2111 | 822 | 38.9% | 822 | 38.9% | 0 |
| 3 | 850 | 315 | 37.1% | 315 | 37.1% | 0 |
| 4 | 892 | 199 | 22.3% | 207 | 23.2% | +8 |
| 5 | 1736 | 355 | 20.4% | 745 | 42.9% | +390 |
| 6 | 1682 | 407 | 24.2% | 625 | 37.2% | +218 |
| 7 | 1867 | 416 | 22.3% | 499 | 26.7% | +83 |
| 8 | 1543 | 532 | 34.5% | 645 | 41.8% | +113 |
| 9 | 1611 | 483 | 30.0% | 483 | 30.0% | 0 |

Book baseline: 15069 / 4258 / 28.3%
Book post-fix: 15069 / 5070 / 33.6% — delta **+812**, against the pipeline's
838 rescued lines (879 dash-convention lines minus the 41 off-roster/unknown-
bucket ids the PR #2266 review-gate fix wave sends back to `narrator`, see
below). Mechanism, not a discrepancy: `decideNarrationOnly`
(`server/src/analyzer/dialogue-structure/cross-examine.ts:272-287`) clamps
the first sentence of a contiguous demoted run to
`Math.min(CONFIDENCE.NARRATION_DEMOTE, 0.5)` = 0.5, so that sentence was
already below the 0.75 threshold in the baseline and stays below it (rescued
at 0.6) post-fix — it is one of the 838 rescued lines but contributes 0 to
the threshold-crossing delta. `decideTagSpanOnly` always returns 0.9, so
tag-routed victims do cross and are counted, which is the majority case.
The gap is therefore structural and one-directional — it can only make the
delta smaller than 838, never larger — so +812 is the expected shape, not a
number to re-investigate.

**2026-08-11, review-gate fix wave (PR #2266):** the review found the
convention rescue kept two classes of id it shouldn't — narrator/unknown-
gender-bucket ids below the alignment floor (finding 1), and ids absent
from `stage1.characters` at both call sites (finding 2) — since
`reconcileSentenceCharacterIds` demotes an off-roster id to `narrator`
downstream regardless, so keeping it rescues nothing and only inflates
`demotedCount`. Fixing both (a single shared `isConventionRescue` helper,
`server/src/analyzer/dialogue-structure/cross-examine.ts`) sends 41 of the
original 879 rescued lines (`борис-игнатьевич` ×17, `егор` ×24, both
off-roster) back to `narrator`. `HARM TOTAL victims` therefore now reads
**41**, not 0 — the correct result, not a regression: those 41 lines were
never actually recoverable. The table above and the book totals reflect
this fix; the 44% threshold below was re-checked against the new numbers
and is unaffected (ch5, the new maximum among the five degraded chapters,
still sits under it).

Control check: ch1/2/3/9 delta is **0** each, as required — sanity check
passed, not BLOCKED.

Worst structurally-intact chapter post-fix (ch1/2/3/9): 38.9% (ch2). Target 1a
threshold therefore 44% (38.9% rounded up to 39%, +5 points headroom).

> **Superseded 2026-08-12 (#2267) — do not reuse this derivation.** The 44%
> threshold it produces was withdrawn. Two things above are now known to be
> false. (1) **ch1/2/3/9 are not structurally intact.** That label came from
> those chapters having zero *dash-invariant victims*, which is a fact about
> victims and was silently reused as a claim about paragraph structure.
> Measured directly on the source, ch2 holds **64** merged dialogue turns
> inside one 8,604-char paragraph and ch1 holds **87** inside a 10,651-char
> one; ch3 is the only chapter of the nine that reads clean. So the threshold
> was calibrated from a degraded chapter. (2) **The confidence share does not
> track paragraph structure at all** — it misses every degraded chapter of this
> book and flags three structurally-healthy chapters of an English one
> (#2264). Target 1a is now "review burden" and carries no bar; the structural
> criterion is target **1c**. See
> [`docs/superpowers/specs/2026-08-12-merged-turn-legibility-design.md`](../specs/2026-08-12-merged-turn-legibility-design.md).
> The rest of this appendix — the victim numbers, the 879→41 renumber, the
> hand-labelled sample — is unaffected and still stands.

### Hand-labelled victim sample (30 of 879, deterministic stride)

Sample: `SAMPLE 879 victims total; every 29th`, 30 blocks, ch4/ch5/ch6/ch7/ch8
(no ch1/2/3/9 victims in the sampled stride). One victim (#8, ch5 idx876,
model=`anton-gorodetsky`) was a quote-tag fragment ("- мрачно отозвался я." —
"gloomily responded I", the *tag* half of a "- Quote, - tag." pair, no actual
spoken words) where `narrator` was in fact right. The other 29 all carry real
spoken content — including several one-word replies ("- Да.", "- Днем.",
"- Идиот,", "- Ольга.") — and `narrator` was wrong on all of them. Full
per-item labels + one-line justifications: task-1-report.md.

| label | count | share |
|---|---|---|
| correct (model right, engine wrong) | 29 | 96.7% |
| wrong (narrator was right) | 1 | 3.3% |
| unclear | 0 | 0% |

Decision-rule row: 1–5 wrong (≤~17%) → bar = observed share, rounded up,
n=30. Proceed (no stop).

Target 1b reading 1 bar therefore **≤ 4%** (1/30 = 3.3%, rounded up; n=30).

---

## Traceability — spec section → task

| Spec section | Covered by |
|---|---|
| §2 the invariant, §2.1 two call sites, §2.2 prototype | Tasks 2, 3 |
| §2.3 measured result (879→41 shipped — see the dated correction in the design doc and the "Measured Baselines" appendix; spec's own table reads 879→0, pre-roster-fix — 17 hashes, forced floor) | Task 8 step 1 |
| §2.4 flags-not-attributes (confidence below 0.75) | Task 2 step 1, asserted |
| §3 *Unlocked* — analyse before building an English arm | Task 8 step 4, issue 1 |
| §4.1 the bucket split | Tasks 5, 6 |
| §4.2 target 1a over confidence, *"calibrated on post-change replay"* | Task 1 (baseline), **Task 7 step 0 (post-fix — the calibration input)**, Task 7 step 1 |
| §4.3 target 1b, narrator-delta rejected | Task 7 step 1 |
| §4.4 known consumers (all six) | Task 6 (five) + Task 5 (`cross-examine-reasons.test.ts`) |
| §4.4 `escalation.ts` unchanged, deliberately | Task 5 step 1, last case |
| §5 hand-label 30 victims | Task 1 step 3 |
| §6 unit / regression / controls / corpus | Tasks 2, 3, 4, 8 |
| §6 fixture | Task 4 — **deviation declared**, derived not edited |
| §7.1 tag-span bound refuted | Task 7 step 2, recorded so it is not re-proposed |
| §7.2 parser segmentation deferred | Task 8 step 4, issue 2 |
| §8 out of scope — no parser change | Global Constraints |
| §10 open questions 1–3 | Task 1 + Task 7 step 0 (Q1), Task 1 step 3 (Q3), Task 8 step 4 (Q2) |

---

## Review findings folded in (assumption-checker, 2026-08-11)

Recorded so a later reader can tell which parts of this plan are the product of
a failed first draft rather than a first-pass design.

| # | Finding | Resolution |
|---|---|---|
| 1 | **Target 1a was calibrated on the pre-fix baseline** — but the fix moves 879 sentences from 0.9 to 0.6, i.e. across the very 0.75 threshold 1a measures. The bar would have been set from a distribution the change demolishes, failing the chapters the fix repairs. Contradicted the source spec's own §4.2. | Task 1's script gained a `POSTFIX=1` mode; **Task 7 step 0** is a new mandatory post-fix measurement, and the threshold is now derived from it. The appendix carries both columns and a control check. |
| 2 | **The proposed tests would not compile.** `cross-examine.test.ts:47` infers `run()`'s `opts` from an untyped `BASE_OPTS`, so fresh literals carrying `dialogueOpen` trip excess-property checking. Vitest does not typecheck, so this would have run green for four commits and surfaced only at Task 6. | **Task 2 step 2** retypes `BASE_OPTS`/`run` against `CrossExamineOpts` before anything else, and Task 2 steps 3 and 7 both run `npm run typecheck` explicitly. |
| 3 | **The `unresolved` blast radius was under-listed**, with a hedge ("any remaining error is a consumer this plan missed") standing in for a checkable enumeration. `analysis.test.ts:3158`'s `makeReport` is a typed `EngineReport` literal and breaks. | Task 6 step 1 names `makeReport` and gives its edit; step 7 carries a full enumeration of every `EngineReport`-shaped literal in the tree, with break/no-break per site. |
| 4 | **Escalation safety rested on the wrong reason.** Spec §4.4 argued from `isFillEligible`; the actual protection is one layer earlier — a rescued line has no speech span, so `escalateFlaggedWindows` drops it at window grouping and it consumes zero budget. | Reason corrected and **pinned by a test** (Task 2 step 1, last case) on the structural property itself, not on the downstream predicate. |
| 5 | **es/fr are activated but measured by nothing.** `lang/es.ts:5` and `lang/fr.ts:5` both carry a non-null `dialogueOpen`, so Task 4 switches the invariant on for them; the fixture is ru, and the corpus harness's `guessLanguage` can only return ru/ja/en. | Declared in Global Constraints as a named residual risk, given unit coverage (Task 2 step 1), and required in the PR body. The change is **not** to be described as verified for es/fr. |
| 6 | **The below-floor bucket asymmetry was undocumented.** Above the floor a rescued line is `dash-line-keep-flag`/`flagged`; below it, `flag-only-floor`/`unresolved`. Same sentence, different counter. | Documented at Task 3 step 3, asserted by reason (not bucket, which moves in Task 5) at Task 3 step 1, and written into target 1b as reading 3. |
| 7 | **The forced-floor check was a hand edit to a gitignored file with a manual revert** — invisible to git if forgotten, silently corrupting later runs. | Replaced with a `FLOOR` env read in Task 8 step 1, matching `replay-legibility.mts`. |
| 8 | **`GATE` was presented as verification but cannot fail for this change** — it hashes parser output and never reaches `crossExamine`. | Task 8 step 1 now states plainly what each corpus run can and cannot show, and that `HARM` over one Russian book is the only cross-examine-level corpus evidence. |
| 9 | **`AnalysisProvenanceReport.unresolved` absent vs zero was ambiguous.** | Global Constraints: absent means "predates the split", no reader may default it to 0, and nothing reads it today. |
