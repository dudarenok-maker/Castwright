# Analyzer First-Person Narrator Identity Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the analyzer from scattering a Russian first-person narrator's «я» material across a phantom pronoun character, a mislabeled side-character, and the real protagonist — so re-analyzing Night Watch on the same local model attributes first-person correctly.

**Architecture:** The bug is a compound of three root causes. **RC1 (stage-1 identity):** nothing stops the model from rostering a bare pronoun «Я» as a character or seeding first-person evidence onto the wrong character — fixed by a deterministic roster-dedup guard + a prompt id-rule. **RC2 (structure engine suppressed):** the dialogue-structure correction engine goes `flagOnly` below an 80% per-chapter alignment floor, and Night Watch aligned at only 65.6% because the aligner is an exact-substring match whose normalizer doesn't fold Russian ё↔е — fixed by widening the normalizer + letting the one high-precision narration demote run even below floor. **RC3 (stage-2 prompt has no «я» anchor):** the model is handed the roster with no first-person→character mapping, so a model told "egor = Protagonist" routes first-person prose to egor — fixed by surfacing the known first-person-narrator id into the stage-2 prompt (Task 5), plus separator-aware chunking hardening (Task 6). Each code fix is deterministic and unit-tested; a final fresh re-analysis on the same local model proves it end-to-end.

**Tech Stack:** TypeScript (server), Vitest, local Ollama analyzer (`gemma4-e4b-8gb:latest`), the `server/src/analyzer/dialogue-structure/` engine (srv-59).

## Global Constraints

- **Re-analysis model is fixed:** `gemma4-e4b-8gb:latest`, engine `local`. The fix MUST hold under a small local model — favor deterministic guards, never rely on the model obeying a prompt. (Optional Qwen-9b comparison run is informational only; Gemma is the acceptance bar due to stronger Russian.)
- **Verification requires a FRESH analysis** (`fresh:true` / app "Start fresh"). The structure engine runs inside stage-2, downstream of the cache; a normal re-analyze hits the cache and the engine never runs.
- **Language path:** Russian (`ru`). Conventions live in `server/src/analyzer/dialogue-structure/lang/ru.ts`.
- **Environment:** the current worktree `server-analyzer-local-warm-gate` is broken (not in `git worktree list`, no checked-out `server/`). Create a FRESH worktree off `main` via `superpowers:using-git-worktrees` before Task 1. Junction `node_modules` per house practice.
- TDD, one logical change per commit, DRY, YAGNI. Server is TypeScript — `npm run build` before any re-analysis.
- Test runner: `cd server && npx vitest run <path>` (server has its own vitest project).

---

### Task 1: Fold ё↔е in the aligner normalizer (RC2 core)

The aligner matches the model's per-sentence `text` against the chapter body by exact substring after a narrow normalization. Its fold set (case, whitespace, dash, quote, ellipsis) does NOT fold `ё↔е`. A small Russian model routinely swaps ё/е, and a single unfolded character orphans the whole sentence → sub-floor chapters → `flagOnly` → no corrections. Folding ё→е is 1:1 per-character so it preserves the offset map exactly.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/aligner.ts:68-70` (the `else` branch of `buildNormalizedMap`)
- Test: `server/src/analyzer/dialogue-structure/aligner.test.ts`

**Interfaces:**
- Consumes: existing `alignSentences(sentences, paras, body)`, `buildNameIndex`, `parseChapterStructure`, `conventionsFor` (all already imported in the test).
- Produces: no signature change — same `AlignmentResult`, strictly higher `alignedPct` on ё/е-divergent input.

- [ ] **Step 1: Write the failing test**

Add to `aligner.test.ts` inside `describe('alignSentences', ...)`:

```ts
it('(RC2) folds ё↔е so a model ё/е swap still aligns', () => {
  const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
  // Body uses ё in both "Ещё" and "всё".
  const body = '— Ещё не всё, — сказал Антон.';
  const paras = parseChapterStructure(body, ruIdx);
  const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
  expect(body.slice(speechSpan.start, speechSpan.end)).toBe('Ещё не всё,');

  // Model returned the same line with е instead of ё (the classic RU drift).
  const sentences = [mkSentence(1, 'anton', 'Еще не все,')];
  const result = alignSentences(sentences, paras, body);

  // Assert on membership + alignedPct, NOT strict array-equality: the overlap
  // filter (aligner.ts:161) can graze the adjacent tag span depending on the
  // comma-boundary offset, and that's not what this test is about.
  expect(result.aligned[0].spans).toContain(speechSpan);
  expect(result.alignedPct).toBe(100);
});
```

> **Scope note (review fold, MAJOR 3):** ё→е is a correct, cheap, offset-preserving lever, but it is NOT proven to lift Night Watch from 65.6% to ≥80% on its own — the remaining misalignment may also be paraphrase/truncation/NFC. Treat ">80% alignment" as a **measured outcome in Task 5, not a guaranteed step**. Every speech-side correction and escalation is gated on clearing the floor (`analysis.ts:1742`), so if Task 5 shows chapters still sub-floor, the follow-up lever is NFC folding and/or a bounded fuzzy match in `findMatch` (deferred until measured — YAGNI).

- [ ] **Step 2: Run it — verify it FAILS**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/aligner.test.ts -t "folds ё"`
Expected: FAIL — `alignedPct` is `0` (needle `еще не все,` not found in body normalized as `ещё не всё,`).

- [ ] **Step 3: Implement the fold**

In `aligner.ts`, change the `else` branch of `buildNormalizedMap` (currently lines 68-70):

```ts
    } else {
      out = raw[i].toLowerCase();
      // RU: models routinely swap ё↔е. Fold to е so a single ё/е divergence
      // doesn't orphan the whole sentence (which would drag the chapter under
      // the 80% alignment floor and suppress ALL structure corrections).
      // 1:1 char replacement — preserves the offset map exactly.
      if (out === 'ё') out = 'е';
    }
```

- [ ] **Step 4: Run it — verify it PASSES**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/aligner.test.ts`
Expected: PASS (new test + all existing aligner tests green).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/aligner.ts server/src/analyzer/dialogue-structure/aligner.test.ts
git commit -m "fix(analyzer): fold ё↔е in aligner normalizer so RU ё/е drift doesn't orphan sentences"
```

---

### Task 2: Force-merge a bare first-person-pronoun character (RC1)

`roster-dedup.ts` Tier-3 links a character X→Y when X's name-key is in Y's alias set, but auto-merges only when the link is MUTUAL or the linking name is MULTI-token — to protect single-token role-word minors (`шеф`). A phantom character literally named «Я» (name-key `я`) links to the real narrator (Антон, who carries alias «Я») but is single-token + non-mutual, so it survives as a standalone 0-line row. A bare first-person pronoun is never a real character; it must always merge into whoever claims that pronoun as an alias.

**Files:**
- Modify: `server/src/analyzer/roster-dedup.ts` (imports; rename `_opts`→`opts`; add `isFirstPersonName`; extend the Tier-3 `strong` condition ~line 212-215)
- Test: `server/src/analyzer/roster-dedup.test.ts`

**Interfaces:**
- Consumes: `conventionsFor(language)` from `./dialogue-structure/lang/index.js` → `.pronouns.firstPerson: RegExp | undefined`.
- Produces: `dedupeRosterByName(characters, sentences, { language })` unchanged signature; now emits a rewrite `phantom→narratorProtagonist` and drops the phantom when a pronoun-named char links to an alias-holder.

- [ ] **Step 1: Write the failing tests**

Add to `roster-dedup.test.ts`:

```ts
describe('dedupeRosterByName — first-person pronoun phantom (RC1)', () => {
  it('force-merges a bare «Я» character into the char that lists «Я» as an alias', () => {
    const chars = [
      c({ id: 'антон', name: 'Антон', gender: 'male', aliases: ['Антон Городецкий', 'Я'] }),
      c({ id: 'я', name: 'Я', gender: 'male', aliases: [] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('антон', 196), ...sent('я', 7)], { language: 'ru' });
    expect(r.characters.map((x) => x.id)).toEqual(['антон']); // phantom gone, Антон survives (more lines)
    expect(r.rewrites['я']).toBe('антон');
  });

  it('routes a bare «Я» to the narrator when NO character claims it as an alias (fallback)', () => {
    const chars = [
      c({ id: 'антон', name: 'Антон', gender: 'male', aliases: [] }),
      c({ id: 'я', name: 'Я', gender: 'male', aliases: [] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('антон', 196), ...sent('я', 7)], { language: 'ru' });
    // A bare pronoun is NEVER a real character: with no alias-holder to absorb
    // it, it routes to the narrator (first-person-with-no-owner = narrator voice).
    expect(r.characters.map((x) => x.id)).toEqual(['антон']);
    expect(r.rewrites['я']).toBe('narrator');
  });
});
```

> **Framing (review fold, MAJOR 4 + MINOR 6):** the Tier-3 edge fires ONLY when a roster peer aliases «я» — on a fresh run the model may not reproduce that alias. The narrator-fallback below makes "a bare-pronoun character never survives" **unconditional** regardless of aliasing. Note this also activates for en/es/fr/de/zh/ja (each `conventionsFor` table has a `firstPerson` pronoun) — a deliberate, desirable generalization beyond Russian.

- [ ] **Step 2: Run — verify FAIL**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts -t "first-person pronoun phantom"`
Expected: first test FAILS (both `антон` and `я` survive; `rewrites['я']` undefined). Second test already passes.

- [ ] **Step 3: Implement**

In `roster-dedup.ts`, add the import near the top (after line 4):

```ts
import { conventionsFor } from './dialogue-structure/lang/index.js';
```

Rename the parameter `_opts` → `opts` in the `dedupeRosterByName` signature (line 52) and use it. Then, immediately after `const nameKeyOf = (ch: CharacterOutput): string => normaliseNameKey(ch.name);` (~line 176), add:

```ts
  // A "character" whose NAME is the language's bare first-person pronoun (the
  // model rostering «Я»/«I» as its own entity) is never real — it's the
  // narrator-protagonist's self-reference. Force it to a STRONG edge so it
  // merges into whichever real character claims that pronoun as an alias,
  // overriding the single-token weak-link gate that protects role-word minors.
  const firstPersonRx = conventionsFor(opts.language)?.pronouns.firstPerson ?? null;
  const isFirstPersonName = (ch: CharacterOutput): boolean =>
    firstPersonRx !== null && firstPersonRx.test(` ${nameKeyOf(ch)} `);
```

Extend the `strong` condition in the Tier-3 edge loop (currently lines 212-215):

```ts
      const strong =
        mutual ||
        (linkXY && (tokens(x.name).length >= 2 || isFirstPersonName(x))) ||
        (linkYX && (tokens(y.name).length >= 2 || isFirstPersonName(y)));
```

Then add the unconditional fallback immediately AFTER the Tier-3 survivor filter (`roster = roster.filter((ch) => !droppedT3.has(ch.id));`, ~line 268) — before the Tier-3 weak-suggestion pass so a routed pronoun row never spawns a suggestion:

```ts
  // Fallback: a bare first-person-pronoun character that STILL stands (no
  // roster peer aliased it above) is never a real character — route it and its
  // lines to the narrator rather than leave a pronoun masquerading as a
  // speaker. Terminal rewrite (→ narrator), so ordering vs the collapse below
  // is irrelevant. Guarantees "no bare-pronoun row survives" unconditionally.
  for (const ch of roster) {
    if (ch.id !== NARRATOR_ID && isFirstPersonName(ch)) rewrites[ch.id] = NARRATOR_ID;
  }
  roster = roster.filter((ch) => ch.id === NARRATOR_ID || !isFirstPersonName(ch));
```

- [ ] **Step 4: Run — verify PASS**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts`
Expected: PASS (both new tests + all existing tiers green; survivor ranks by tokens then lines so Антон (196) beats `я` (7)).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/roster-dedup.ts server/src/analyzer/roster-dedup.test.ts
git commit -m "fix(analyzer): force-merge bare first-person-pronoun phantom into its alias-holder"
```

---

### Task 3: Apply the pure-narration demote even below the alignment floor (RC2 safety net)

Below the 80% floor `crossExamine` runs `flagOnly` and corrects NOTHING — including `decideNarrationOnly`, which demotes a named-character-attributed pure-narration sentence to `narrator`. That demote is the rule that strips first-person narration («я скосил глаза…») off Егор, and it's high-precision (a narration paragraph is narrator voice on its own structural evidence, independent of window/alternation quality). Let this ONE correction run even below floor.

> **Framing (review fold, BLOCKER 1):** this is NOT a new high-precision claim — it **restores Wave A parity**. The legacy `applyNarratorDefault` (still used for unsupported languages, `analysis.ts:1786`) demoted narration to narrator unconditionally; the srv-59 structure engine *regressed* ru books by doing nothing below floor (escalation is skipped too, `analysis.ts:1769`). Task 3 closes that regression. **It deliberately weakens the floor contract** from "below floor ⇒ zero corrections" to "below floor ⇒ only the pure-narration demote runs; all speech/tag/alternation/escalation corrections stay suppressed." That contract change is encoded in a shipped invariant test (`cross-examine.test.ts:247-260`) which MUST be consciously revised (Step 3b) — it is not a silent side effect.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts` (add `isPureNarrationAligned`; branch inside the `crossExamine` forEach, ~lines 281-286)
- Test: `server/src/analyzer/dialogue-structure/cross-examine.test.ts`

**Interfaces:**
- Consumes: existing `AlignedSentence`, `decideNarrationOnly`, `flagOnlyDecision`, `NARRATOR_ID`.
- Produces: `crossExamine` unchanged signature; below-floor pure-narration on a named char now returns a `narrator` correction instead of a flag-only pass-through.

- [ ] **Step 1: Write the failing test**

Add to `cross-examine.test.ts`:

```ts
it('(RC2) below the alignment floor, still demotes pure-narration off a named char to narrator', () => {
  const as = {
    sentence: mkSentence('егор'),
    spans: [{ kind: 'narration', start: 0, end: 12 } as SpanEvidence],
    lumped: false,
  };
  const result = crossExamine(
    { alignedPct: 60, aligned: [as] } as any,
    { rosterIds: new Set(['егор', 'narrator']), unknownBucketIds: new Set(), alignmentFloorPct: 80 },
  );
  expect(result.sentences[0].characterId).toBe('narrator');
  expect(result.sentences[0].confidence).toBeLessThanOrEqual(0.5);
});
```

(`mkSentence` and the `SpanEvidence` import already exist in this test file; if `mkSentence` there requires a different arg shape, match the file's existing helper.)

- [ ] **Step 2: Run — verify FAIL**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts -t "below the alignment floor, still demotes"`
Expected: FAIL — `characterId` is `'егор'` (flag-only kept the model id).

- [ ] **Step 3: Implement**

In `cross-examine.ts`, add a helper above `crossExamine` (after `decideSentence`):

```ts
/** A pure-narration aligned sentence (spans present, no speech, not lumped) is
    narrator voice on its own structural evidence — so this ONE demote is safe
    to apply even below the alignment floor, where every other correction is
    suppressed as unreliable. */
function isPureNarrationAligned(as: AlignedSentence): boolean {
  return as.spans.length > 0 && !as.lumped && !as.spans.some((s) => s.kind === 'speech');
}
```

Replace the decision line in the `crossExamine` forEach (currently `const decision = flagOnly ? flagOnlyDecision(as) : decideSentence(as, opts, block);`) with:

```ts
    let decision: Decision;
    if (flagOnly) {
      // Suppress corrections below the floor EXCEPT the high-precision
      // pure-narration demote, which doesn't depend on the (unreliable)
      // window/alternation picture.
      if (isPureNarrationAligned(as) && as.sentence.characterId !== NARRATOR_ID) {
        decision = decideNarrationOnly(as.sentence.characterId, block);
      } else {
        block.active = false;
        decision = flagOnlyDecision(as);
      }
    } else {
      decision = decideSentence(as, opts, block);
    }
```

- [ ] **Step 3b: Consciously revise the shipped below-floor invariant test**

The existing test `cross-examine.test.ts:247-260` asserts below-floor = zero corrections, with an `olga` narration fixture commented `// would normally demote`. Task 3 makes that fixture demote. Rewrite the test to encode the NEW (weakened) contract — speech/tag corrections still suppressed, pure-narration now demotes:

```ts
  it('below the alignment floor -> speech/tag corrections suppressed, but pure-narration still demotes (Wave A parity)', () => {
    const list = [
      aligned(mkSentence('narrator'), [speechSpan({ characterId: 'anton', source: 'tag-name' })]), // tag-name correction SUPPRESSED below floor
      aligned(mkSentence('olga', 0.9), [narrationSpan()]), // pure narration STILL demotes to narrator (Wave A parity)
      aligned(mkSentence('anton'), []), // unaligned
    ];
    const result = run(list, 50); // 50% < 80% floor

    expect(result.report.flagOnly).toBe(true);
    // the tag-name-contradicting speech line is NOT corrected below floor; only the narration demote is
    expect(result.sentences.map((s) => s.characterId)).toEqual(['narrator', 'narrator', 'anton']);
    expect(result.report.corrected).toBe(1);
    for (const s of result.sentences) expect(s.confidence).toBeLessThanOrEqual(CONFIDENCE.UNALIGNED_CAP);
  });
```

(The demoted `olga` line clamps to ≤0.5 as run-first, which is ≤ `UNALIGNED_CAP` 0.74, so the confidence invariant still holds.)

- [ ] **Step 4: Run — verify PASS**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine.test.ts`
Expected: PASS (new below-floor demote test + the revised invariant test + all other cross-examine tests green).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/cross-examine.ts server/src/analyzer/dialogue-structure/cross-examine.test.ts
git commit -m "fix(analyzer): run the pure-narration demote even below the alignment floor"
```

---

### Task 4: Stage-1 prompt id-rule for the first-person voice (RC1 defense-in-depth)

The stage-1 prompt tells the model the first-person voice is the protagonist/narrator but gives no id rule and never forbids rostering the bare pronoun. This is defense-in-depth only (Tasks 1-3 are the deterministic guarantees); it reduces the chance the small model seeds the problem. Verified by the Task 5 re-analysis, not a unit test (prompt-string assertions are brittle and the model behavior is the real signal).

**Files:**
- Modify: `server/src/routes/analysis.ts:1432-1436` (the narrator/first-person guidance block in `buildStage1ChapterInbox`)
- Modify: `skills/audiobook-character-detection-per-chapter.md:78-80` (mirror the same rule)

- [ ] **Step 1: Add the id-rule to the inline prompt**

In `analysis.ts`, in the narrator/first-person guidance (~line 1432-1436), append these sentences to the existing block (keep the current text; add after it):

```
The first-person «я» voice is exactly ONE character. NEVER create a character whose name is a bare pronoun (я, I, ich, …) — that is not a character. Attribute first-person NARRATION to `narrator`; attribute first-person SPOKEN dialogue to the single protagonist and record «я» in that protagonist's aliases. Do NOT spread first-person lines across several characters, and never attach a first-person line as evidence to a secondary character.
```

- [ ] **Step 2: Mirror the rule in the skill prompt**

In `skills/audiobook-character-detection-per-chapter.md` (~line 78-80), add the same paragraph so the system-instruction and inbox agree.

- [ ] **Step 3: Build to confirm no syntax break**

Run: `cd server && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/analysis.ts skills/audiobook-character-detection-per-chapter.md
git commit -m "feat(analyzer): stage-1 prompt id-rule for the single first-person voice"
```

---

### Task 5: Anchor first-person «я» to the narrator id in the stage-2 prompt (RC3-investigation lever)

The stage-2 model prompt passes the roster as `{id,name,role}` with NO «я»→character mapping (analysis.ts:1527, :1592), so a model told "egor = Protagonist" routes first-person prose to egor. The pipeline already computes the first-person narrator (`findFirstPersonCharacter`, analysis.ts:1608) but only feeds it to the structure engine (:1726), never the model. Surface it as an explicit prompt instruction. **This is the most direct lever for the SPEECH-side «я»→Егор lines that RC2's narration demote does not touch** — and the fresh re-analysis is where it takes effect.

**Files:**
- Modify: `server/src/routes/analysis.ts` — `buildStage2ChapterInbox` (:1491) + `buildStage2ChunkInbox` (:1545): add trailing `firstPersonId: string | null` param and an instruction block; `attributeChapterStage2` (:1654): compute the id once and thread it through `callForBody`. `export` both builders for testing.
- Test: `server/src/routes/analysis.test.ts` (add a describe block).

**Interfaces:**
- Consumes: `findFirstPersonCharacter(characters, conv)` (exists, :1608), `conventionsFor(language)`.
- Produces: `buildStage2ChapterInbox(manuscriptId, title, stage1, chapter, firstPersonId)`; `buildStage2ChunkInbox(manuscriptId, title, stage1, chapter, subBody, precedingContext, firstPersonId)`.

- [ ] **Step 1: Write the failing test**

```ts
import { buildStage2ChapterInbox } from './analysis.js'; // add to exports in Step 3

describe('stage-2 prompt first-person anchor (RC3)', () => {
  const stage1 = { characters: [
    { id: 'антон', name: 'Антон', role: 'Colleague', aliases: ['Антон Городецкий', 'Я'] },
    { id: 'егор', name: 'Егор', role: 'Protagonist / Observer' },
  ]} as any;
  const chapter = { id: 1, title: 'Ch1', body: 'Я кивнул.' };

  it('emits the first-person anchor naming the narrator id when one is provided', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, 'антон');
    expect(prompt).toContain('First-person narrator');
    expect(prompt).toContain('`антон`');
  });

  it('omits the anchor block when firstPersonId is null', () => {
    const prompt = buildStage2ChapterInbox('m', 'Title', stage1, chapter, null);
    expect(prompt).not.toContain('First-person narrator');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "first-person anchor"`
Expected: FAIL — `buildStage2ChapterInbox` is not exported / doesn't accept `firstPersonId`.

- [ ] **Step 3: Implement**

`export` both builders. Add the `firstPersonId: string | null` param to each. In each, build the block and insert it right before the body section (`## Chapter …` / `## Section to attribute …`):

```ts
  const firstPersonBlock = firstPersonId
    ? `## First-person narrator

This manuscript is narrated in the FIRST PERSON. Every first-person pronoun («я», «меня», «мне», «мной», «мы») refers to character id \`${firstPersonId}\`. Attribute first-person narration and any first-person spoken line to \`${firstPersonId}\` UNLESS a dialogue tag explicitly names a different speaker. Never route a first-person line to another character merely because that character is prominent nearby.

`
    : '';
```

Insert `${firstPersonBlock}` immediately before `## Chapter ${chapter.id}` (chapter builder) and before `## Section to attribute` (chunk builder — after `${contextBlock}`).

Then in `attributeChapterStage2` (:1654), compute the id once before `runStage2ChapterChunked` and thread it into both builder calls inside `callForBody`:

```ts
  const fpConventions = conventionsFor(opts.stageCall.language);
  const firstPersonId = fpConventions ? findFirstPersonCharacter(opts.stage1.characters, fpConventions) : null;
```

Update the two `callForBody` builder invocations to pass `firstPersonId` as the final argument.

- [ ] **Step 4: Run — verify PASS**

Run: `cd server && npx vitest run src/routes/analysis.test.ts`
Expected: PASS (new tests + existing analysis tests green — the extra param is additive; existing callers pass the new arg).

> **Note:** this lever is only as good as `findFirstPersonCharacter` returning the right id, which needs the stage-1 roster to carry «я» in the narrator's aliases — that is exactly what Task 4's prompt rule reinforces. If a fresh run still fragments Антон or omits the «я» alias, the anchor no-ops (null) rather than mis-anchoring — safe by construction.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): anchor first-person «я» to the narrator id in the stage-2 prompt"
```

---

### Task 6: Prefer scene-separator boundaries when splitting stage-2 chunks (RC3 hardening)

`splitBodyIntoChunks` splits by size at blank-line boundaries and does NOT prefer scene/section separators (`***`, `* * *`, `⁂`), so a chunk can straddle a scene break. Evidence shows this did NOT cause the Night Watch bug, but a chunk straddling two scenes is a latent attribution-confusion risk. Make a word-free separator paragraph a preferred break point. Only affects over-budget bodies; lossless (`chunks.join('')` still reproduces the body).

**Files:**
- Modify: `server/src/analyzer/stage2-chunk.ts` — `splitBodyIntoChunks` (:133-155)
- Test: `server/src/analyzer/stage2-chunk.test.ts`

**Interfaces:**
- Consumes: `attributableWordCount` (already imported at stage2-chunk.ts:34).
- Produces: `splitBodyIntoChunks` unchanged signature; a scene-separator unit now forces a chunk boundary.

- [ ] **Step 1: Write the failing test**

```ts
it('(RC3) prefers a scene-separator boundary so no chunk straddles two scenes', () => {
  const sceneA = 'а'.repeat(60) + '.\n\n';
  const sep = '***\n\n';
  const sceneB = 'б'.repeat(60) + '.\n\n';
  const body = sceneA + sceneA + sep + sceneB + sceneB; // ~260 chars, 4 prose paras + separator
  const chunks = splitBodyIntoChunks(body, 200); // over budget → must split

  // No chunk contains prose from BOTH scenes.
  for (const ch of chunks) {
    expect(ch.includes('а') && ch.includes('б')).toBe(false);
  }
  expect(chunks.join('')).toBe(body); // lossless
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `cd server && npx vitest run src/analyzer/stage2-chunk.test.ts -t "scene-separator boundary"`
Expected: FAIL — without the fix, chunk 1 packs `аа*** б` (194 < 200) so it contains both `а` and `б`.

- [ ] **Step 3: Implement**

In `splitBodyIntoChunks`, add a helper and make a separator unit force a break. Replace the packing loop (currently lines 144-152):

```ts
  const isSceneSeparatorUnit = (u: string): boolean =>
    u.trim().length > 0 && attributableWordCount(u) === 0;
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    // A scene-separator paragraph forces a boundary BEFORE it, so the separator
    // (and the scene that follows) starts a fresh chunk — no chunk straddles a
    // scene break. Size overflow breaks too, as before.
    if (cur && (isSceneSeparatorUnit(u) || cur.length + u.length > charBudget)) {
      chunks.push(cur);
      cur = u;
    } else {
      cur += u;
    }
  }
```

- [ ] **Step 4: Run — verify PASS**

Run: `cd server && npx vitest run src/analyzer/stage2-chunk.test.ts`
Expected: PASS (new test + all existing chunk tests green — a word-free separator is not a tiny fragment, so `mergeTinyChunks` is unaffected; a separator-only chunk is skipped at attribution by `hasAttributableContent`).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/stage2-chunk.ts server/src/analyzer/stage2-chunk.test.ts
git commit -m "fix(analyzer): prefer scene-separator boundaries when splitting stage-2 chunks"
```

---

### Task 7: Fresh re-analysis of Night Watch on Gemma — acceptance

Prove the compound fix end-to-end on the reproduction book, using the same model, via a FRESH analysis (cache-bypassing).

**Files:** none (operational). Book id: `mns_oyK7Po6BiT`; bookDir: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор\.audiobook\`.

- [ ] **Step 1: Rebuild + confirm engine config**

```bash
cd server && npm run build
```
Confirm `server/.env` (or defaults): `STRUCTURE_ENGINE=true`, `ATTRIBUTION_ESCALATION=local` (cloud not required), engine `local`, model `gemma4-e4b-8gb:latest`.

- [ ] **Step 2: Snapshot BEFORE (for a real diff)**

```bash
bookDir="C:/AudiobookWorkspace/books/Сергей Лукьяненко/The Night Watch Tetralogy/Ночной дозор/.audiobook"
jq '.analysisProvenance.report' "$bookDir/state.json"   # baseline: alignedPct 65.6, flagged 10637
jq '[.characters[] | select(.id=="я")] | length' "$bookDir/cast.json"   # baseline: 1 (phantom present)
jq '[.sentences[] | select(.characterId=="егор")] | length' "$bookDir/manuscript-edits.json"  # baseline includes ~732 first-person
```

- [ ] **Step 3: Trigger a FRESH analysis (NOT a cached re-analyze)**

App: Night Watch → analysis → **"Start fresh"**. Or API: `POST /api/manuscripts/mns_oyK7Po6BiT/analysis` body `{ "fresh": true }`. Budget 30+ minutes (stage-1 + stage-2 over ~14k sentences on the local model + escalation).

- [ ] **Step 4: Watch the live per-chapter signal**

Tail server stdout / `server.log` for `[analysis:structure] ch=N aligned=..% confirmed=.. corrected=.. flagged=..`. Expect `aligned%` markedly higher than before (target: most chapters ≥ 80, so corrections + the narration demote actually run).

- [ ] **Step 5: Read the verdict**

```bash
jq '.analysisProvenance.report' "$bookDir/state.json"   # alignedPct UP, flagged DOWN vs 10637
jq '[.characters[] | select(.id=="я")] | length' "$bookDir/cast.json"   # EXPECT 0 (phantom gone)
jq '[.characters[] | {id, role, lines}] ' "$bookDir/cast.json"          # Егор no longer "Protagonist", line count sane
jq '.sentences | map(.characterId) | group_by(.) | map({id: .[0], n: length}) | sort_by(-.n)' "$bookDir/manuscript-edits.json"
```

**Acceptance (Gemma is the bar) — calibrated to what the deterministic fixes actually guarantee (review fold, MAJOR 2 & 3):**
- **Phantom `я` character GONE from cast.json** (hard pass — Task 2 makes this unconditional).
- **First-person NARRATION off Егор → ~0** (hard pass — `decideNarrationOnly`, now running below floor via Task 3). Егор keeps only his genuine dialogue + any residual first-person *speech*.
- **First-person SPEECH on Егор: markedly reduced, target low but not asserted 0.** The primary lever is now Task 5 (the stage-2 «я»→narrator-id prompt anchor) which biases the model to attribute first-person speech to Антон at the source on the fresh run; Task 4 (stage-1 «я» alias) feeds it, and above-floor alignment lets tag-anchored lines auto-correct. Structurally, an unanchored first-person quote remains ambiguous (any speaker says «я»), so a residual is expected — report it as a bounded number, don't assume 0. Measure the before/after Егор count.
- **`alignedPct` — MEASURED, not asserted.** Record the new book-wide value and the per-chapter `[analysis:structure] aligned=..%` lines vs the 65.6% baseline. If a majority of chapters are still sub-floor, that's the signal to add NFC/fuzzy matching (Task 1 scope note) — a follow-up, not a Task-5 failure.
- No characterIds in `manuscript-edits.json` absent from `cast.json` (id-drift not reintroduced).

- [ ] **Step 6: (Optional) Qwen-9b comparison run**

Repeat Steps 3-5 with the Qwen-9b model for a comparison data point only. Expectation (user): Gemma ≥ Qwen on Russian. Do NOT gate acceptance on Qwen.

- [ ] **Step 7: Record outcome**

If pass: note it against issue for this fix + update memory (`project_analyzer_first_person_narrator_egor_misattribution` → shipped) and flag the srv-59 acceptance as likely unblocked. If fail/surprising: capture `state.json` `generationError` (not server.log), the `[analysis:structure]` lines for the bad chapters, and escalation artifacts under `server/handoff/`.

---

## Self-Review notes

- **Spec coverage:** RC1 phantom → Task 2; RC1 stage-1 seeding → Task 4 (prompt) + downstream RC2 demote; RC2 low alignment → Task 1; RC2 floor suppression of narration demote → Task 3; same-model fresh re-analysis + Qwen compare → Task 5. All covered.
- **Deliberately NOT doing:** forcing unanchored first-person QUOTES ("- Я упустил вампиршу") to the narrator — structurally ambiguous (any speaker says «я»); would over-correct. These remain flagged + escalated; Task 4 reduces them at the source. Features (b)/(c) are issue #1676, out of scope.
- **Ordering:** Tasks 1-6 are independent and unit-tested; do them in any order; Task 7 (verify) depends on all. Task 1 is highest-leverage for RC2; Task 5 is highest-leverage for the speech-side «я»→Егор lines (RC3).

## Independent review folds (2026-07-16, opus adversarial pass)

- **BLOCKER 1 — folded:** Task 3 breaks shipped invariant `cross-examine.test.ts:247-260`. Added Step 3b to consciously revise it + reframed Task 3 as restoring Wave A below-floor narration demote (documents the weakened floor contract).
- **MAJOR 2 — folded:** Task 5 acceptance split into first-person NARRATION (deterministic → ~0) vs SPEECH (flagged/bounded, #1676, not required 0).
- **MAJOR 3 — folded:** Task 1 ">80% alignment" downgraded to a measured Task-5 outcome; NFC/fuzzy noted as the follow-up lever if chapters stay sub-floor.
- **MAJOR 4 — folded:** Task 2 given an unconditional narrator-fallback so a bare-pronoun row never survives even when no peer aliases it; framed honestly; noted it generalizes to all languages (MINOR 6).
- **MINOR 5 — acknowledged (no code):** `previewFoldForLiveView` (analysis.ts:749) dedups with empty sentences, so the *live* "Cast so far" pill could momentarily show «Я» surviving on roster order; cosmetic only — final cast.json (analysis.ts:726, real sentences) is correct and the frontend snapshot-replaces the roster (per prior live-cast fix).
- **MINOR 7 — folded:** Task 1 test asserts `spans` membership + alignedPct, not strict array-equality (avoids the tag-span overlap off-by-one).
- **Confirmed sound by review:** RC1/RC2 diagnosis; Task 1 fold correctness/offset-preservation/symmetry; Task 2 union + survivor-ranking picks Антон, no `isFirstPersonName` false-positive on Яков/Оля/Ян, no circular import, `opts.language` passed by callers.

## RC3 investigation folds (2026-07-16, opus evidence pass)

- **Chunker scene-straddle is NOT the dominant cause (evidence):** misattribution is pervasive, not seam-localized — Антон's own lines are mislabeled `egor` *inside* one unbroken dialogue scene (ch1 bin 600-800); every observable separator landed *at* a chunk boundary, not mid-chunk; a clean single-POV Антон section still dumped 248 lines on `egor` (ch5). Separators survive normalization (`html-utils.ts`: `</p>`→`\n\n`, `\n{3,}`→`\n\n`).
- **The evidenced miss:** the stage-2 prompt (`analysis.ts:1527/:1592`) passes `{id,name,role}` only — no «я»→id mapping — and `findFirstPersonCharacter` (:1608) is wired only to the structure engine (:1726), never the model. **→ Task 5 (new): surface the first-person-narrator id in the stage-2 prompt.** Highest-leverage lever for the speech-side «я»→Егор lines.
- **Chunker hardening kept (user-requested):** **→ Task 6 (new): separator-aware `splitBodyIntoChunks`.** Safe + lossless, only-when-over-budget; latent-risk hardening, not the fix for this bug.
- **Manuscript-view scene separator filed as #1679** (the display counterpart of Task 6); editing-UX (alias re-point + bulk reassign) is #1676. Both out of scope here.
