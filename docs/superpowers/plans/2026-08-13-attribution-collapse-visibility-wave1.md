# Attribution collapse visibility, Wave 1 — measure — Implementation Plan

> ## ✅ APPROVED — revision 8, 2026-08-13. Dispatched.
>
> Revision 8 of
> `docs/superpowers/specs/2026-08-06-attribution-collapse-visibility-design.md`
> is approved. Of the five owner decisions in spec §Open questions, three are
> answered and two remain open without blocking this plan:
>
> | # | Decision | Answer |
> |---|---|---|
> | 1 | **Does `SentenceOutput.priorCharacterId` land?** (spec D18) | **Answered 2026-08-13: yes.** Tasks 1 and 6 are in scope; acceptance criterion 5 is in scope |
> | 4 | **Is `parseChapterStructure`'s speech/tag split the D15 rule?** | **Answered 2026-08-13: yes.** Task 3 keeps its planned shape; Wave 1 measures and reports how far `tagTotal` moves against the case heuristic |
> | 2 | Does D13's banner scope land? | **Answered 2026-08-13: yes** — Wave 2 only, does not block this plan. Its numbers are re-measured under the current unit in this wave regardless (§D13 re-gated) |
> | 3 | Is Wave 2's surface still right at this size? | **Still open.** Wave 2 only. Does not block this plan |
> | 5 | **Does `unanswered` become a sixth state?** (spec R-9C4) | **Still open.** Wave 2 only. Does not block this plan — Task 8 prints `unattributedSpeech` either way, and that column is what the decision gets made from |
>
> **Revision 8 went through the Premium adversarial gate and did not survive its
> first draft — five Criticals.** All are folded into both documents; spec
> §Review findings round 8 records them. **Three land squarely in this plan**
> and are already applied below, but read them before Task 1 rather than
> trusting the steps: D18's write sites were the wrong two (R-9C1, Task 1);
> criterion 3's mutation control was inert (R-9C2, Task 5); and the
> punctuation-invariance property asserted something `alignSentences` cannot
> deliver (R-9C3, Task 6).
>
> **Read the spec before Task 1.** In particular §Revision 8 rebaseline, which
> lists thirteen revision-7 claims this plan must not carry forward, and §D13
> re-gated.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute, for every book in the library, what share of its dialogue is
being read by the narrator — from a denominator the analyzer's model cannot
move — and print it. **Wave 1 ships no threshold, no UI and no badge.**

**Architecture:** One new pure module
(`server/src/store/attribution-health.ts`), one new impure resolver beside it
(`attribution-health-io.ts`), one read-only script
(`scripts/measure-attribution.mjs`), and one additive optional field on
`SentenceOutput`. The metric **imports** the dialogue-structure engine's own
parser and aligner rather than re-deriving "what is dialogue" — that
re-derivation is what produced four of this spec's seven failed review rounds.

**Tech Stack:** TypeScript (Node, ESM), Vitest (server suite), Node for the
script with Vitest for its pure helpers.

**Design of record:**
[`docs/superpowers/specs/2026-08-06-attribution-collapse-visibility-design.md`](../specs/2026-08-06-attribution-collapse-visibility-design.md),
revision 8.

**Issue:** [#1984](https://github.com/dudarenok-maker/Castwright/issues/1984).

---

## Global Constraints

### The five acceptance criteria, verbatim

These are the repo owner's own words
([#1984#issuecomment-5275487278](https://github.com/dudarenok-maker/Castwright/issues/1984#issuecomment-5275487278),
[#1984#issuecomment-5275507915](https://github.com/dudarenok-maker/Castwright/issues/1984#issuecomment-5275507915)).
They are reproduced unedited and they govern this plan. A task that satisfies
its own steps and violates one of these has failed.

> 1. Denominator comes from the **source prose**, never from the model's returned
>    text; the join to model output is dash-insensitive.
> 2. Speech halves and tag halves are reported **separately**, per the book's
>    language conventions.
> 3. A regression test that feeds the metric a run with leading dashes stripped
>    from tag halves and asserts the score **does not move** — that is the exact
>    false-recovery in §1, and without it the metric can be gamed by a
>    punctuation change.
> 4. A test that a sentence absent from stage-2's output is visible to the metric
>    as absent rather than as a denominator that quietly shrank.
> 5. **The panel distinguishes model-assigned `narrator` from engine-demoted
>    `narrator`.** These are different defects with different fixes — the first is
>    a prompt/model problem, the second is `applyNarratorDefault` firing on text
>    it cannot read — and they are indistinguishable in the final `characterId`
>    alone. #1984 exists to make collapse visible; a figure that shows collapse
>    without saying which of the two produced it tells the user something is
>    wrong and nothing about what to do. The demotion site already knows:
>    `analysis.ts:2287` runs after stage-2, so the pre-demotion assignment is
>    available at that point.

### Constraints that follow from them

- **No new "is this dialogue" predicate is written, anywhere, for any reason.**
  The repo has exactly one, `isSpokenLine` (`narrator-default.ts:34`, made
  conventions-driven by #2245), and one structural parser,
  `parseChapterStructure` (`parser.ts:89`). This plan uses the parser and does
  **not** call `isSpokenLine` at all. Spec F2.
- **`isSpokenLine` is a surface this metric MEASURES, not a tool it CALLS.**
  Any import of it from `attribution-health.ts` is a defect, not a shortcut.
- **Every count is a count of SOURCE SPANS**, never of model sentences. If a
  field's value can change when the model re-punctuates its output without
  changing any attribution, that field is wrong.
- **`computeAttributionMeasurement` is pure: no `fs`, no `await`, no config
  read.** Both file reads — the analysis cache and the manuscript record — live
  in `attribution-health-io.ts`. Revision 5 of the spec put the language chain
  inside the pure module and the round-5 gate caught it (R-6M1); revision 8 adds
  a *second* read and must not repeat it.
- **Three columns from revision 7 do not exist and must not be reintroduced:**
  `pipelineSpoken`, `blindSpoken`, `overcountSpoken`. #2245 merged the two
  definitions they measured the gap between, so all three are identically zero
  forever. Spec F3/F4/F5.
- **An absent `priorCharacterId` is `unknownOriginNarrator`, never
  `modelNarrator`.** Defaulting it to "the model said so" reports 100%
  model-assigned on every historical book, confidently, from no evidence. Spec
  D18. This is the single most likely defect in this plan.
- **Neutralisation proof on every assertion, not only thresholds.** Each new
  assertion is mutated on its own line and observed to go red; the proof is
  recorded in the PR body. Two known placebo shapes from this spec's history
  apply here: the `excludeFromSynthesis` fixture must contain a sentence that is
  **quoted**, and the cast-resolver fixture must retire **`char-narrator` →
  `narrator`**, not an ordinary character.
- **`C:\AudiobookWorkspace` is READ-ONLY.** The script writes nothing to any
  book, ever. Its JSON report goes to the scratch path. Task 8's on-box
  invariance check writes its mutated cache copies to the scratch path too.
- **Commit convention:** `<type>(<scope>): <subject>`, subject ≤ 100 chars.
  Scope is `server` for the module, `scripts` for the script, `docs` for docs.
- **Branch:** cut a fresh worktree + branch `feat/server-1984-wave1` off latest
  `origin/main` before Task 1, per CLAUDE.md's branching workflow. **The design
  worktree (`wt-1984-spec`) is docs-only and is NOT the implementation tree.**

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `openapi.yaml` | API contract, type source of truth | Add optional `priorCharacterId` to the sentence schema. **Edited first**, then `npm run openapi:types` |
| `server/src/handoff/schemas.ts` | zod mirror of the contract (`:117-142`) | Add `priorCharacterId: z.string().optional()` |
| `server/src/analyzer/narrator-default.ts` | the demote-only heuristic | `applyNarratorDefault` (`:77`) records `priorCharacterId` on each demotion |
| `server/src/analyzer/dialogue-structure/cross-examine.ts` | the engine's correction pass | records `priorCharacterId` on each correction |
| `server/src/store/attribution-health.ts` | **NEW** — the pure metric | `computeAttributionMeasurement`, `AttributionMeasurement` |
| `server/src/store/attribution-health.test.ts` | **NEW** — unit + mutation suite | |
| `server/src/store/attribution-health.criteria.test.ts` | **NEW** — the five criteria, one describe each | |
| `server/src/store/attribution-health-io.ts` | **NEW** — the impure caller | `resolveBookLanguage`, `loadMeasurementInputs`, `resolveAttributionState` |
| `server/src/store/attribution-health-io.test.ts` | **NEW** — state-sequence fixtures | |
| `scripts/measure-attribution.mjs` | **NEW** — read-only library walk | |
| `scripts/tests/measure-attribution.test.mjs` | **NEW** — pure helpers, matching `build-companion-apk.test.mjs` | |
| `docs/testing/onbox-acceptance-register.md` + its live view | acceptance debt | One row added (Task 9) |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | release register | One entry each |

---

### Task 1: Record the pre-overwrite attribution (`priorCharacterId`)

**Gated on owner decision 1.** If declined, skip to Task 2 and delete Task 6's
criterion-5 block.

The origin of a `narrator` id is knowable only at the moment of overwrite.
**FIVE sites overwrite a model attribution, and the two the owner's criterion 5
points at both produce ZERO on the default configuration** (spec R-9C1). Read
spec §D18's write sites before writing any code here — the site list below is
the corrected one, and the obvious-looking pair is the wrong pair.

| # | Site | Runs by default? | Produces `narrator` on a speech span? |
|---|---|---|---|
| 1 | `reconcileSentenceCharacterIds` `analysis.ts:1423` (called `:5286`, `:6787`) | **yes, both paths, knob-independent** | **yes — and it is the #1984 incident's own mechanism** |
| 2 | `escalateFlaggedWindows` `escalation.ts:277` | **yes** (`analyzer.structure.escalation` defaults `'local'`) | no, but it INVALIDATES the field |
| 3 | `crossExamine` `cross-examine.ts:393` | yes (engine on) | **no** — proven in the spec |
| 4 | `applyNarratorDefault` `analysis.ts:2287` | **no** — it is the `else` of a knob defaulting `true` | yes, when the engine is off |
| 5 | `recoverTaggedNarratorLines` `flipQ` | yes | no, but it INVALIDATES the field |

**Site 1 is the one that matters and it needs no new plumbing.** Its `onDemote`
hook is already `(info: { sentence: SentenceOutput; originalId: string }) => void`
(`analysis.ts:1428`) — `originalId` **is** `priorCharacterId`.

**Code to the property, not to this table**, because a table is what got the
first draft wrong:

> Every path that assigns a `characterId` a stage-2 response did not return must
> leave `priorCharacterId` correct for the value it just wrote — set to the id
> being replaced, or **cleared** when the write is not a demotion. A path that
> changes `characterId` and leaves `priorCharacterId` alone is a defect.

**Files:**
- Modify: `openapi.yaml`, `server/src/handoff/schemas.ts:117-142`
- Modify: `server/src/analyzer/narrator-default.ts:77-96` (`applyNarratorDefault`)
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts` (the correction site)
- Test: `server/src/analyzer/narrator-default.test.ts`, `.../cross-examine.test.ts`

**Interfaces:**
- Produces: `SentenceOutput.priorCharacterId?: string` — the `characterId` the
  sentence carried *before* this overwrite. Absent on every sentence neither
  site touched.

- [ ] **Step 1: Edit `openapi.yaml` first, then regenerate**

`openapi.yaml` is the type source of truth (CLAUDE.md). Add to the sentence
schema, alongside `excludeFromSynthesis`:

```yaml
priorCharacterId:
  type: string
  description: >-
    The characterId this sentence carried before a post-stage-2 step
    overwrote it. Absent when nothing overwrote it. Written only by
    applyNarratorDefault and by the dialogue-structure engine's
    correction pass; never by the model.
```

Then `npm run openapi:types` and confirm `src/lib/api-types.ts` moved.

- [ ] **Step 2: Mirror it in the zod schema**

`server/src/handoff/schemas.ts`, in `sentenceSchema` (`:117-142`):

```ts
priorCharacterId: z.string().optional(),
```

- [ ] **Step 3: RED — assert `applyNarratorDefault` records it**

```ts
// server/src/analyzer/narrator-default.test.ts
describe('applyNarratorDefault — priorCharacterId (#1984 D18)', () => {
  const ru = conventionsFor('ru')!;
  it('records the overwritten id on a demotion, and nothing on a spoken line', () => {
    const out = applyNarratorDefault(
      [
        { id: 's1', chapterId: 1, text: 'сказал Егор.',   characterId: 'egor'  },
        { id: 's2', chapterId: 1, text: '— Ничего нет,',  characterId: 'anton' },
        { id: 's3', chapterId: 1, text: 'Он ушёл.',       characterId: 'narrator' },
      ] as SentenceOutput[],
      ru,
    );
    expect(out[0].characterId).toBe('narrator');
    expect(out[0].priorCharacterId).toBe('egor');      // demoted — recorded
    expect(out[1].priorCharacterId).toBeUndefined();   // spoken — untouched
    expect(out[2].priorCharacterId).toBeUndefined();   // already narrator — NOT an override
  });
});
```

**`s3` is the assertion that matters.** `applyNarratorDefault` already returns a
pre-existing-narrator sentence **by reference** and explicitly calls it "not an
override" (`narrator-default.ts:86`). Recording `priorCharacterId: 'narrator'`
there would classify every legitimately-narrated line as engine-demoted and
invert criterion 5's headline number. Run: expect three failures.

- [ ] **Step 4: GREEN — record it at the demotion branches only**

Two branches in `applyNarratorDefault` construct a new object; both gain
`priorCharacterId: s.characterId`. The `return s` paths are not touched.

- [ ] **Step 4b: RED then GREEN — site 1, `reconcileSentenceCharacterIds`**

**Do this before site 3 or 4.** It is the only one that moves the number on a
default-configuration book, and it is the one the acceptance run checks.

```ts
it('records the roster-shrink demotion, which is the #1984 incident mechanism', () => {
  const r = reconcileSentenceCharacterIds(
    [{ id: 's1', chapterId: 1, text: '— Никого здесь не было.', characterId: 'dropped-char' }] as SentenceOutput[],
    new Set(['egor', 'narrator']),
  );
  expect(r.sentences[0].characterId).toBe('narrator');
  expect(r.sentences[0].priorCharacterId).toBe('dropped-char');
  expect(r.demotedCount).toBe(1);
});
```

**Mutation:** instrument sites 3 and 4 only, leaving this one bare, and the
acceptance run reports `demotedNarrator: 0` on every book while the collapse is
real. That mutation is what the first draft of this plan actually specified.

- [ ] **Step 4c: RED then GREEN — sites 2 and 5 must not leave a STALE field**

`escalateFlaggedWindows` (`escalation.ts:277`) writes `characterId` **in place**
and runs by default; `recoverTaggedNarratorLines`' `flipQ` does the same. Neither
is a demotion, so both must **clear** `priorCharacterId` when they change the id.

```ts
it('clears a stale priorCharacterId when escalation re-assigns the sentence', () => {
  // a sentence the validator demoted, which escalation then re-attributes
  const s = { characterId: 'narrator', priorCharacterId: 'dropped-char', /* ... */ };
  // after escalation assigns 'egor':
  expect(after.characterId).toBe('egor');
  expect(after.priorCharacterId).toBeUndefined();   // NOT 'dropped-char'
});
```

**Without this the field is *wrong* rather than merely absent** — a sentence
correctly attributed by escalation reads as an engine demotion, and
`demotedNarrator` over-reports on exactly the books escalation helped most.

- [ ] **Step 5: RED then GREEN — sites 3 and 4, for the knob-off configuration**

**Verified 2026-08-13: there is exactly one application site**, and it is
`server/src/analyzer/dialogue-structure/cross-examine.ts:393`:

```ts
sentences.push({ ...as.sentence, characterId: decision.characterId, confidence: decision.confidence });
```

Five `decide*` helpers produce a verdict (`:144`, `:151`, `:166`, `:261`,
`:286` are the `bucket: 'corrected'` returns) but all of them converge here, so
one edit covers every correction path. **Record the field on the value test, not
on the bucket:**

```ts
const overwritten = decision.characterId !== as.sentence.characterId;
sentences.push({
  ...as.sentence,
  characterId: decision.characterId,
  confidence: decision.confidence,
  ...(overwritten ? { priorCharacterId: as.sentence.characterId } : {}),
});
```

**Keying on `bucket === 'corrected'` would be wrong in both directions** and is
the obvious-looking mistake here: a `corrected` verdict can re-affirm the same
id (`decideNarrationOnly` at `:274` returns `NARRATOR_ID` for a sentence already
narrator), and a non-`corrected` bucket is not a guarantee the id is unchanged.
The question the column answers is "was this id overwritten", so the test is
whether it changed.

Paired assertion: a sentence whose verdict equals its incoming id carries **no**
`priorCharacterId`. Mutate to `bucket === 'corrected'` and that assertion goes
red.

- [ ] **Step 6: Assert nothing else moved**

`npm run test:server` — the existing `narrator-default` and `cross-examine`
suites must stay green. The field is additive and optional; a red elsewhere
means something was reading the object identity that `return s` preserves.

- [ ] **Step 7: Commit** — `feat(server): record the pre-overwrite attribution as priorCharacterId`

---

### Task 2: `resolveBookLanguage` — the impure language resolver

Split out first because Task 3's denominator cannot be built without a
`LanguageConventions`, and because putting this chain inside the pure module is
the exact defect the round-5 gate found (R-6M1).

**Files:**
- Create: `server/src/store/attribution-health-io.ts`
- Test: `server/src/store/attribution-health-io.test.ts`

**Interfaces:**
- Produces: `resolveBookLanguage(bookDir, chapters): Promise<{ language: string | null; languageSource: 'declared' | 'detected' | 'unknown' }>`
- Consumes: `detectManuscriptLanguage`, `selectBodyChapters` (`server/src/tts/detect-language.ts:105`)

- [ ] **Step 1: RED — a declared language wins and is read RAW**

```ts
it('reads state.language raw, and does NOT default an absent one to en', async () => {
  const declared = await resolveBookLanguage(dirWith({ language: 'ru' }), chapters);
  expect(declared).toEqual({ language: 'ru', languageSource: 'declared' });

  const undeclared = await resolveBookLanguage(dirWith({}), russianChapters);
  expect(undeclared.languageSource).toBe('detected');   // NOT 'declared'
  expect(undeclared.language).toBe('ru');               // NOT 'en'
});
```

**The second half is the trap** (spec R-5M3). The in-tree accessor
`bookStateLanguage` (`scan.ts:314`) delegates to `normaliseBookLanguage`
(`tts/language.ts:23`), which returns `DEFAULT_LANGUAGE` for an absent value —
so an implementer following the documented convention gets `'en'` for every book
with no language and detection **never runs at all**. This module is the one
place that needs the difference between "declared English" and "nothing
declared". Read the field raw and leave a comment saying why.

- [ ] **Step 2: GREEN — implement the chain, detection over BODIES**

Detection samples `selectBodyChapters(chapters)` — front/back matter is dropped
from the voting pool (#2263), and it keys on `{ title, body }`, which the
analysis cache does not carry. This is a second reason the metric needs the
manuscript record and not only the cache.

- [ ] **Step 3: RED then GREEN — `fallback` and the surrender branches**

Assert `detectManuscriptLanguage` sets `fallback: true` on **both** surrender
branches — `detect-language.ts:81` (`letters === 0`) and `:98` (the `franc`
miss) — and `false` on a real match, with the zero-letter case exercised by a
sample of pure punctuation and numerals. **These pin behaviour #2246 already
shipped**, and that is the point: this module consumes the field, so a
regression in it is a regression here. An implementation reading `supported`
instead of `fallback` passes every other test in this plan and reproduces R-5C3
one level downstream.

- [ ] **Step 4: Commit** — `feat(server): resolve a book's language for the attribution metric`

---

### Task 3: The source-anchored denominator (criteria 1 and 2)

The heart of the plan. `spokenTotal` and `tagTotal` come from
`parseChapterStructure(ch.body, index)` and from nothing else.

**Files:**
- Create: `server/src/store/attribution-health.ts`
- Test: `server/src/store/attribution-health.test.ts`

**Interfaces:**
- Produces: `computeAttributionMeasurement(input): AttributionMeasurement` — pure.
- Consumes: `parseChapterStructure` (`parser.ts:89`), `buildNameIndex`
  (`name-matcher.ts:23`), `conventionsFor` (`lang/index.ts:14`).

- [ ] **Step 1: RED — a dash paragraph is ONE speech span and ONE tag span**

```ts
// server/src/store/attribution-health.test.ts
const RU_BODY = '— Ничего нет, — сказал Егор.\n— Значит, ищем дальше.\n';

it('counts source spans, not model sentences', () => {
  const m = compute({ language: 'ru', bodies: { 1: RU_BODY }, sentences: [], roster });
  expect(m.spokenTotal).toBe(2);   // two speech spans
  expect(m.tagTotal).toBe(1);      // one tag span
});
```

**Note what this fixture proves and what revision 7 would have scored.** Under
the old design these three model sentences were *two* dash-opening sentences in
the denominator and the tag half sat in it too. Under D14 they are two speech
spans and one tag span, and `sentences: []` — the model contributed nothing at
all and the denominator is still 2. That is criterion 1 stated as a test.

**These numbers are measured, not predicted.** Run against the real modules
2026-08-13:

```
paras dialogue,dialogue | speech 2 | tag 1
  speech:"Ничего нет,"  tag:" — сказал Егор."  speech:"Значит, ищем дальше."
```

So `expect(m.spokenTotal).toBe(2)` and `expect(m.tagTotal).toBe(1)` are the
right assertions and will not need adjusting on first run. If they do, something
changed in `parser.ts` and that is the finding.

- [ ] **Step 2: GREEN — walk paragraphs, count spans by kind**

Excluded chapters are removed from the body map by the caller (Task 7), not
here — the pure module receives only the bodies it should measure.

- [ ] **Step 3: RED — the roster-independence control**

```ts
it('scores identically with an empty roster — the denominator is not model-derived', () => {
  const withRoster  = compute({ ...base, roster: [{ id: 'egor', name: 'Егор' }] });
  const withoutAny  = compute({ ...base, roster: [] });
  expect(withoutAny.spokenTotal).toBe(withRoster.spokenTotal);
  expect(withoutAny.tagTotal).toBe(withRoster.tagTotal);
});
```

**This is the direct proof of D14's independence claim and it can genuinely
fail.** `buildNameIndex` is built from `stage1.characters`, which **is** model
output, and `parseChapterStructure` takes the index.

**Measured 2026-08-13 against the real modules — it holds today:**

```
withRoster  | paras dialogue,dialogue | speech 2 | tag 1
emptyRoster | paras dialogue,dialogue | speech 2 | tag 1
```

The roster reaches only `SpanEvidence.speaker`, via `anchorSpansFromTags` →
`findRosterName`/`findSubjectName`; span kinds are cut by the language's
`TAG_OPEN`/`SPEECH_RESUME` and validated against
`conv.speechVerbStems`/`beatVerbStems`. **Nothing in the tree enforces that
today, which is why this test exists.** If it ever goes red, the denominator has
acquired a model dependency and F1 is back.

Add the same assertion at the **anchored tier** (Task 4 step 2) and for at least
one quote-convention language, since the roster reaches quote paragraphs through
a different path (`parseQuoteParagraph`).

- [ ] **Step 4: RED — per-language coverage**

One case per convention family, because a property that holds for dash
languages says nothing about quote languages: `ru` (dash), `en` (quote-only,
`dialogueOpen: null`), `de` (quote-only, `»…«` **written naturally**, with a
mid-line `sagte` and a two-turn sentence — the shapes the pre-#2245
`isSpokenLine` got wrong), `ja` (`「…」`, kana-dominant).

**The German case's constraint is inverted from the spec's earlier revisions**
and the reason is in spec §Testing: R-6C5's "exactly one `»` and one `«`, no
mid-line attribution" existed to keep a mutation control alive against a rule
#2245 deleted. Writing it naturally is now the regression that matters.

- [ ] **Step 5: Commit** — `feat(server): count dialogue from source prose spans`

---

### Task 4: The join, and what it cannot reach (criterion 4)

**Files:**
- Modify: `server/src/store/attribution-health.ts`
- Test: `server/src/store/attribution-health.test.ts`

**Interfaces:**
- Consumes: `alignSentences` (`aligner.ts:310`) → `AlignedSentence { sentence, spans, lumped }`
- Produces: `unattributedSpeech`, `splitSpeech`, `lumpedSpeech`, and a
  span→attribution map for Task 5.

- [ ] **Step 1: RED — an omitted sentence is `unattributedSpeech`, not a smaller denominator**

```ts
it('reports a stage-2 omission as unattributed, not as a denominator that shrank', () => {
  const missingOne = allSentences.filter((s) => s.characterId !== 'anton');
  const m = compute({ ...base, sentences: missingOne });
  expect(m.spokenTotal).toBe(2);          // the source still has two speech spans
  expect(m.unattributedSpeech).toBe(1);   // one of them nobody answered
  expect(m.attributableSpoken).toBe(1);   // the share speaks for half the book
});
```

**Mutation:** build the denominator from the sentence list and `spokenTotal`
drops to 1 while `unattributedSpeech` reads 0 — the exact "denominator that
quietly shrank" criterion 4 names.

- [ ] **Step 2: Check the aligner's short-needle behaviour BEFORE trusting the fixture**

`aligner.ts` selects Pass-A anchors on **length alone** —
`ANCHOR_MIN_LEN = FUZZY_MIN_NEEDLE = 24` (`aligner.ts:45`), with
`WINDOW = 4096` (`:43`) — and its own header records a known residual: a needle
shorter than 24 normalised characters never anchors and is left to the
interval-bounded Pass B infill.

**Every fixture sentence in this plan as drafted is under 24 characters.**
`'— Ничего нет,'` is 13. So none of them anchors, all of them go through Pass B,
and Pass B's behaviour on a run with **no** bounding anchors is not the same as
its behaviour between two. A fixture that passes because Pass B happened to
place everything is not evidence the join works.

**So: before writing Task 4's assertions, run the fixture through
`alignSentences` directly and print `aligned[i].spans` for each sentence.**
Assert what it actually does. Then build the fixture set in **two tiers**, and
run every criteria test against both:

- **Short tier** — the drafted fixture, all needles under 24 chars, exercising
  Pass B with no anchors.
- **Anchored tier** — the same book with every speech and tag half rewritten to
  **over 24 normalised characters**, so Pass A anchors and Pass B infills
  between anchors. e.g. `'— Ничего здесь нет, совсем ничего,'` /
  `'— негромко сказал Егор, не оборачиваясь.'`

**A single-tier suite cannot distinguish "the join works" from "Pass B guessed
right on a two-sentence chapter", and the real corpus is the anchored tier.**
Lengthening the fixture instead of adding the tier loses the short case, which
is where dash dialogue actually lives — `- Да.` is 5 characters, and #2187's
note records that exact needle as the one that used to mis-anchor. A fixture
that passes because nothing aligned is the placebo shape this spec has shipped
four times.

- [ ] **Step 3: GREEN — map spans to attributions**

For each `speech` span, collect the aligned sentences overlapping it:
- **exactly one** → that sentence's `characterId` is the span's attribution;
- **more than one, agreeing** → same;
- **more than one, disagreeing** → `splitSpeech`, attributed to neither;
- **zero** → `unattributedSpeech`.

`AlignedSentence.lumped` (a sentence straddling a speech span and a
tag/narration span) increments `lumpedSpeech` and is reported; it does not
change the span's attribution.

- [ ] **Step 4: RED — `attributableSpoken` subtracts each population once**

```ts
it('never double-subtracts, and never goes negative', () => {
  // a span that is BOTH orphaned and split, plus one unattributed
  const m = compute(overlappingFixture);
  expect(m.attributableSpoken).toBeGreaterThanOrEqual(0);
  expect(m.attributableSpoken).toBe(countedByHand);
});
```

`attributableSpoken` is **the count of speech spans with exactly one resolvable
attribution**, computed by counting that set directly — *not* by subtracting
three counters from `spokenTotal`. Subtraction is what makes overlap a bug; a
direct count makes it impossible. The three columns remain reported.

- [ ] **Step 5: Commit** — `feat(server): join source spans to model attributions via the aligner`

---

### Task 5: The numerator, its origin split, and id drift (criterion 5)

**Files:**
- Modify: `server/src/store/attribution-health.ts`
- Test: `server/src/store/attribution-health.test.ts`

**Interfaces:**
- Consumes: `NARRATOR_CHARACTER_IDS` (`narrator-identity.ts:26`),
  `buildCastResolver` (`cast-resolve.ts:91`).

- [ ] **Step 1: RED — both narrator ids count**

`narratorIdSpoken` counts **both** `narrator` and `char-narrator`. Matching only
`'narrator'` is the exact regression #1895 centralised the constant to prevent,
and it scores a `char-narrator` book at 0% while 100% collapsed.

- [ ] **Step 2: RED — the origin split, including the absent-field case**

**EVERY sentence in this fixture must land on a SPEECH span** (spec R-9C2). The
numerator is over speech spans, so a narrator sentence that aligns to a **tag**
or **narration** span enters no origin column at all and the assertion about it
is vacuous. The round-8 gate found exactly that defect in the spec's own version
of this fixture, where the prior-less narrator was the tag half.

```ts
// body has THREE dash paragraphs, so THREE speech spans.
const body =
  '— Ничего нет, — сказал Егор.\n' +
  '— Значит, ищем дальше.\n' +
  '— Никого здесь не было.\n';

it('splits the narrator numerator three ways and never defaults the third', () => {
  const m = compute({ ...base, body, cacheHasOriginField: true, sentences: [
    { text: '— Ничего нет,',           characterId: 'narrator', priorCharacterId: 'egor' },
    { text: '— сказал Егор.',          characterId: 'narrator' },  // TAG span — NOT counted
    { text: '— Значит, ищем дальше.',  characterId: 'anton'    },
    { text: '— Никого здесь не было.', characterId: 'narrator' },  // SPEECH span, model said so
  ]});
  expect(m.demotedNarrator).toBe(1);
  expect(m.modelNarrator).toBe(1);          // the 4th sentence, NOT the 2nd
  expect(m.unknownOriginNarrator).toBe(0);
  expect(m.tagNarratorSpan).toBe(1);        // the 2nd, in its own column
  expect(m.narratorIdSpoken).toBe(m.modelNarrator + m.demotedNarrator + m.unknownOriginNarrator);
});

it('reports a cache written before priorCharacterId existed as unknown-origin', () => {
  const m = compute({ ...base, sentences: legacyCacheSentences, cacheHasOriginField: false });
  expect(m.unknownOriginNarrator).toBe(m.narratorIdSpoken);
  expect(m.modelNarrator).toBe(0);          // NOT folded in
});
```

**The second test is the one this task exists for.** An absent field defaulting
to "model-assigned" reads as a harmless default and reports 100%
model-assigned on every historical book, from no evidence. **Mutation:** make
the absent case fall through to `modelNarrator` and this test goes red and
nothing else does.

`cacheHasOriginField` is a per-book input, not a per-sentence guess: a cache
written after Task 1 has the field on demoted sentences and legitimately lacks
it on undemoted ones, so per-sentence absence cannot distinguish the two. **The
caller (Task 7) resolves it once from the cache's own metadata; the pure module
receives it.** Do not infer it from the sentences.

- [ ] **Step 3: RED then GREEN — orphans, D9, and the fixture built to fail**

`buildCastResolver(cast, history).resolve(id)` returning `undefined` is the
#2040 id-drift class. `orphanSpoken` and `orphanIds` are reported and are
**never** summed into the share.

The fixture is built with the orphan count **comparable to the narrator-id
count** — one orphan among a hundred spans cannot distinguish the two formulas
at any precision anyone will read. And it retires **`char-narrator` →
`narrator`**, not an ordinary character, or the test passes with
`buildCastResolver` removed entirely (spec §Neutralisation proof).

- [ ] **Step 4: RED — a wholly-orphaned book is `share: null`, never `0%`**

Taking orphans out of the numerator alone would score a wholly-drifted book at
`0 / spokenTotal` = perfectly healthy — #1984's own failure shape, for the third
time in the spec's history.

- [ ] **Step 5: Commit** — `feat(server): split the narrator numerator by origin and by id resolvability`

---

### Task 6: The five criteria as their own suite

Tasks 3–5 test the parts. This task tests the **contract**, in one file, so a
reviewer can read the five criteria and the five describes side by side.

**Gated on owner decision 1** for the criterion-5 block only.

**Files:**
- Create: `server/src/store/attribution-health.criteria.test.ts`

- [ ] **Step 1: Criterion 1 + 3 — the F1 replay, both arms**

```ts
const body =
  '— Ничего нет, — сказал Егор.\n' +
  '— Значит, ищем дальше.\n' +
  '— Никого здесь не было.\n';       // R-9M4: a SPEECH span the narrator takes

const withDashes = [
  { text: '— Ничего нет,',           characterId: 'egor'     },
  { text: '— сказал Егор.',          characterId: 'narrator' },  // TAG span, CORRECT
  { text: '— Значит, ищем дальше.',  characterId: 'anton'    },
  { text: '— Никого здесь не было.', characterId: 'narrator' },  // SPEECH span, a DEFECT
];
// The EXACT transform observed between Aug-6 and Aug-13.
const stripped = withDashes.map((s) => ({ ...s, text: s.text.replace(/^\s*[-–—]\s*/u, '') }));

it('scores identically whether or not the model returned leading dashes', () => {
  const a = compute({ ...base, sentences: withDashes });
  const b = compute({ ...base, sentences: stripped });
  expect(a.narratorIdSpoken).toBe(1);        // the numerator EXISTS (R-9M4)
  expect(a.tagNarratorSpan).toBe(1);         // and the tag half is NOT in it
  expect(b.spokenTotal).toBe(a.spokenTotal);
  expect(b.tagTotal).toBe(a.tagTotal);
  expect(b.narratorIdSpoken).toBe(a.narratorIdSpoken);
  expect(b.unattributedSpeech).toBe(0);      // and nothing fell out of the join
  expect(a.unattributedSpeech).toBe(0);
});
```

**Measured against the real modules 2026-08-13, after the fix:**

```
speech 3 | tag 1
dashes   | narratorIdSpoken(speech) 1 | tagNarratorSpan 1
stripped | narratorIdSpoken(speech) 1 | tagNarratorSpan 1
```

**The fourth sentence is not decoration — without it this test cannot fail for
the right reason** (spec R-9M4). The round-8 gate executed the three-sentence
version: `'— сказал Егор.'` lands on the **tag** span in both arms, so
`narratorIdSpoken` is `0 === 0` and an implementation that never tests
`NARRATOR_CHARACTER_IDS` at all passes every assertion.

**The `unattributedSpeech` assertions cover the other half**: an implementation
that loses the join entirely also scores 0 on both arms. The suite must
distinguish "the score did not move" from "there is no score" **and** from
"there is no numerator".

- [ ] **Step 2: Criterion 2 — the tag half is not in the numerator**

Assert the correctly-narrated tag half lands in `tagNarratorSpan` and **not** in
`narratorIdSpoken`. **Mutation:** fold tag spans into the denominator and this
book's share moves 0% → 33%.

- [ ] **Step 3: Criterion 5 — the demoted arm reports as demoted**

Per the owner: criterion 3's test "gets stronger for free" here. Feed the
stripped arm through `applyNarratorDefault` for real (it is pure, so the test
can call it), and assert both that the score did not move **and** that the
demoted lines report `demotedNarrator`, not `modelNarrator`.

- [ ] **Step 4: Criterion 4 — omission, from Task 4, restated here**

- [ ] **Step 5: The punctuation-invariance property test — TWO TIERS**

Spec criterion 16, and **the single-tier version this plan first specified would
fail on correct code** (spec R-9C3). `ANCHOR_MIN_LEN = 24` is a hard threshold on
**normalised length**, and two of the three transforms change length by 2 chars,
so a needle at 24–25 loses anchor status when stripped — which merges runs in
`locateNeedles` and changes the bounded haystack for every neighbour.

```ts
// Tier A — byte-identical under ALL THREE transforms, no tolerance.
// These fields never read model text, so any variation is a defect.
for (const t of [stripDashes, addDashes, emToHyphen]) {
  expect(measure(t(sents)).spokenTotal).toBe(base.spokenTotal);
  expect(measure(t(sents)).tagTotal).toBe(base.tagTotal);
}

// Tier B — join-dependent fields. Byte-identical under the LENGTH-PRESERVING
// transform only; bounded under the other two by the number of needles that
// actually crossed the 24-char boundary, COMPUTED from the fixture.
expect(measure(emToHyphen(sents))).toEqual(base);            // exact

const crossers = sents.filter((s) => crossesAnchorFloor(s.text, stripDashes)).length;
expect(Math.abs(measure(stripDashes(sents)).narratorIdSpoken - base.narratorIdSpoken))
  .toBeLessThanOrEqual(crossers);
```

**`crossers` is computed, not tolerated blindly** — a drift of any other size
still fails, so the test keeps its teeth. Build one fixture set well away from
the boundary (where `crossers === 0` and the assertion is exact equality) and
one straddling it.

**The corpus must include one book per convention family** (`ru`/`es`/`fr`
dash; `en`/`de` quote-only; `zh`/`ja` CJK). A property test locks only what its
fixture reaches, and a dash-only corpus proves nothing about the quote languages
the same transform is a no-op on.

- [ ] **Step 6: Commit** — `test(server): pin the five attribution-metric acceptance criteria`

---

### Task 7: The impure caller and the state sequence

**Files:**
- Modify: `server/src/store/attribution-health-io.ts`
- Test: `server/src/store/attribution-health-io.test.ts`

**Interfaces:**
- Produces: `loadMeasurementInputs(bookDir)` (cache + manuscript bodies +
  cast + history + `cacheHasOriginField`), and `resolveAttributionState(...)`.

- [ ] **Step 1: GREEN-first — the loader**

Reads the analysis cache (`analysis-cache.ts:79`), the manuscript record's
`chapterHints[].body` (`manuscripts.ts:20`), `cast.json`,
`cast-id-history.json`, and the `excluded` flags (`scan.ts:77`). Excluded
chapters are dropped from **both** halves here.

`assertCacheChaptersShape` throws **inside `loadAnalysisCache`**
(`analysis-cache.ts:124`), not at measure time, so the catch wraps the **load**,
not the metric.

- [ ] **Step 2: RED — the state sequence, one explicit order**

```
1. no analysis at all                          → ok        (no claim is made)
2. cache corrupt (loadAnalysisCache throws)    → unmeasurable
2b. manuscript record absent (no source prose) → unmeasurable   ← NEW in rev 8
3. conventionsFor(resolvedLanguage) === null   → unmeasurable
4. castCount > 0 && spokenTotal === 0
   && (await readAnalysisState(dir)) === null:
     a. no source prose sentences at all       → missing   (nothing to corroborate)
     b. detection contradicts or surrenders    → unmeasurable
     c. otherwise                              → missing
4d. unattributedSpeech share ≥ threshold       → unanswered  (Wave 2 — spec R-9C4,
                                                  gated on owner question 5)
5. orphan share ≥ DRIFT_SHARE_THRESHOLD        → drifted    (Wave 2 — no threshold yet)
6. share ≥ threshold (book or chapter)         → collapsed  (Wave 2 — no threshold yet)
7. otherwise                                   → ok
```

**`readAnalysisState` is `async`** (`analysis-state.ts:85`). Written literally
as `readAnalysisState() === null` the clause compares a Promise to `null`, is
never true, and makes `missing` **silently unreachable** while every test that
does not exercise it still passes (spec R-5M5).

**Wave 1 ships steps 1–4 and 7 only.** Steps 5 and 6 have no threshold yet; the
script prints the shares and the states it can resolve.

- [ ] **Step 3: RED — the nine-row fixture table**

Spec §Testing's rows 1–9, unchanged in intent, with revision 8's mutation table.
Rows 5 and 6 are **language-coverage** fixtures now, not mutation carriers —
their old controls are inert after #2245 (spec F9). The controls that carry
weight are the four D14/D16/D17/D18 mutations.

**Row 9 is the one easiest to leave out**, because deleting the empty-cache
carve-out breaks no other row — every other fixture has text. That is exactly
why it needs its own control.

- [ ] **Step 4: RED — the manuscript-absent row**

A book with a cache and no manuscript record → `unmeasurable`, reported by the
script as `no manuscript`. This is D14's new producer and it is a real corpus
state: the workspace and the cache directory have already been shown to diverge
by a factor of three.

- [ ] **Step 5: Commit** — `feat(server): derive the attribution-health state from the measurement`

---

### Task 8: `scripts/measure-attribution.mjs`

**Files:**
- Create: `scripts/measure-attribution.mjs`, `scripts/tests/measure-attribution.test.mjs`

- [ ] **Step 1: Write the walker, with three properties that are requirements**

- **It walks the library, never the cache directory.** On the reference box 54
  of 76 caches have no book at all.
- **It skips `.upgrade-backups/`.** That directory holds whole copies of the
  books tree; a naïve recursive walk finds each book several times and dedupes
  to *a* copy, not necessarily the live one.
- **It calls `computeAttributionMeasurement`.** No re-implementation of the
  filters, the resolver, the parser or the aligner. Every hand-computed
  distribution in this spec's history was wrong, three times, for three
  different reasons.

- [ ] **Step 2: Columns**

`title`, `language`, `languageSource`, `spokenTotal`, `tagTotal`,
`narratorIdSpoken`, share, `modelNarrator`, `demotedNarrator`,
`unknownOriginNarrator`, `unattributedSpeech`, `splitSpeech`, `orphanSpoken`,
`tagNarratorSpan`, `dashOnlySpoken`, `castCount`, state. Sorted by share
descending, plus the worst chapter per book. JSON report to the scratch path.

**`pipelineSpoken`, `blindSpoken` and `overcountSpoken` are not columns.**

- [ ] **Step 3: Four rows must be visibly distinct**

A book with a cast and nothing attributed; a book whose language could not be
corroborated; a book never analysed; a book whose source prose is gone. **None
may render as a blank row.** Unit-tested at the formatter, since no live book is
in any of these states and an on-box check of it would pass vacuously (spec
R-7M4).

- [ ] **Step 4: Pure helpers unit-tested** in `scripts/tests/`, matching the
`build-companion-apk.test.mjs` pattern.

- [ ] **Step 5: Commit** — `feat(scripts): print the attribution-health distribution for the live library`

---

### Task 9: Docs, release notes, and the acceptance row

- [ ] **Step 1: On-box acceptance register**

One row: *run `scripts/measure-attribution.mjs` against the live workspace and
record its output verbatim.* Plus the on-box invariance check — run the script
twice, the second time over scratch-path copies of each cache with every leading
dash stripped, and diff: **every field of every row must be identical.**

**What the run must show** (spec §On-box acceptance): a row for every live book,
none blank; the two live CJK books at `spokenTotal > 0`; `orphanSpoken` non-zero
on the books that carry unresolvable ids (8 of 20 as of 2026-08-11) with the
share unaffected; `dashOnlySpoken` non-zero on the two Russian books; and
`unattributedSpeech`/`demotedNarrator` printed for every book. **A run reporting
0 in both new columns on all 20 books is a finding to investigate, not a pass** —
and specifically, `demotedNarrator: 0` everywhere means site 1
(`reconcileSentenceCharacterIds`) was not instrumented, **not** that the corpus
is clean. The first draft of this check said "unless that book ran with the
structure engine on"; the engine is on by default, so that escape clause covered
every book and made the check vacuous (spec R-9C1).

**Do NOT carry the `blindSpoken` corpus-replay row** — it is discharged by
#2245 (spec F7).

Three surfaces move in the same diff: the register, the run sheet, and the
**live view** (`docs/testing/onbox-acceptance-register-live-view.html`), which
is hand-authored and published to the URL in the register's header. Run
`npm run check:onbox-register` and, immediately before publishing,
`npm run check:onbox-register -- --against-published <saved copy of the live page>`.

- [ ] **Step 2: Release notes**

`docs/release-notes-next.md` (technical, PR-refed) and a matching brand-voice
line in the in-progress section of `RELEASE_NOTES.md`. Wave 1 has no
user-visible surface, but `priorCharacterId` is an operator-visible schema
change and the script is an operator-visible tool — so both get an entry rather
than a "no shippable delta" note.

- [ ] **Step 3: `docs/features/INDEX.md`** — entry for the spec if it is not
already indexed.

- [ ] **Step 4: Spec status** — leave `status: draft` until the owner approves;
Wave 1 shipping moves it to `active`, not `stable` (Wave 2 is unbuilt).

- [ ] **Step 5: Commit** — `docs(docs): record Wave 1's acceptance and release notes`

---

## What Wave 1 deliberately does not ship

- No threshold constant. `COLLAPSE_SHARE_THRESHOLD`, `DRIFT_SHARE_THRESHOLD`
  and all four floors are set from Task 8's run, in Wave 2.
- No UI, no badge, no banner, no generation gate, no persisted health file, no
  dismissal.
- **No change to `isSpokenLine`, `applyNarratorDefault`'s behaviour, or the
  structure-engine branch.** Task 1 instruments; it does not decide.
- No diagnosis of the two historical CJK collapses. Their books are deleted and
  their leading hypothesis was weakened by #2245 (spec F11).

## Ship notes

_(filled at merge)_
