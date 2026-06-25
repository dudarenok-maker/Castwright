# fs-58 `validate_instruct` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 6th Script Review class, `validate_instruct`, that flags/repairs a sentence's per-line English `instruct` and its in-language vocalization, applied client-side and made precisely stale-aware on the qwen-1.7b liveInstruct path.

**Architecture:** A read-only LLM op-class riding the existing fs-58 per-chapter review call (one flat-envelope op, id-keyed, no anchor). Accepted ops dispatch the existing `setSentenceInstruct` (fs-56) and a tri-state-extended `setSentenceText`. Instruct staleness mirrors the merged #1105 `renderedTextByChapter` thread (a per-group, post-fallback-gated `instructHash` stamp → `renderedInstructByChapter`); a `boundary_move` carve-out keeps an instruct-only edit from engine-blind false-staling.

**Tech Stack:** TypeScript, React 18, Redux Toolkit (Immer), Zod, Vitest (frontend jsdom + server node), Playwright. Server is Node/Express; client mocks behind `VITE_USE_MOCKS`.

**Spec:** `docs/superpowers/specs/2026-06-25-fs58-validate-instruct-design.md` (read it; section refs below point into it).

## Global Constraints

- **OpenAPI is the type source of truth** — but the book-state GET response is **hand-typed** in `src/lib/types.ts` (not generated). `renderedInstructByChapter` is added there, NOT to `openapi.yaml`. **No `api-types.ts` regen.**
- **No hex literals in components**; design tokens are CSS vars (not relevant to this plan — no new visual styling).
- **RTK reducers mutate via Immer drafts** — do not rewrite to spreads.
- **Commit convention:** `<type>(<scope>): <subject>`; allowed scopes incl. `frontend`, `server`. End commit messages with the Co-Authored-By trailer the repo uses (the husky `commit-msg` hook validates the subject line).
- **Vocalization is omitted-when-false everywhere** (`applyDetectedInstruct` only sets `true`; `split`/`merge` clear via `= undefined`). Never store `vocalization: false`.
- **The `instruct` field is always English**; the line may be en/ru/es/fr/de. The apply layer never validates English-ness (prompt-only, operator-reviewed).
- **TDD:** every task writes the failing test first, watches it fail, implements minimally, watches it pass, commits.
- **Run tests from the repo root.** Frontend: `npm test -- <path>`. Server: `cd server && npx vitest run <path>` (or `npm run test:server`).

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `server/src/handoff/schemas.ts` | `scriptReviewSchema` — add op enum + 3 fields | T1 |
| `skills/audiobook-script-review.md` | prompt: `validate_instruct` section, `## Input` field docs, strip_tag tweak | T2 |
| `server/src/routes/script-review.ts` | thread book language into `call`; serialize `instruct`+`vocalization` conditionally | T3 |
| `server/src/tts/synthesise-chapter.ts` | per-group `instructHash` stamp + segment type | T4 |
| `server/src/audio/segments-io.ts` | segment type + `collectRenderedInstructHashesByChapter` | T4, T5 |
| `server/src/routes/book-state.ts` | GET wiring for `renderedInstructByChapter` | T5 |
| `src/store/manuscript-slice.ts` | `setSentenceText` tri-state `vocalization` param | T6 |
| `src/lib/script-review-apply.ts` | `ReviewOp` fields, widened `live`, guards + normalization, dispatch case + carve-out | T7, T8 |
| `src/lib/stale-chapters.ts` | `isChapterInstructEditedSinceRender` | T9 |
| `src/lib/types.ts`, `src/store/chapters-slice.ts`, `src/components/layout.tsx` | `renderedInstructByChapter` thread | T9 |
| `src/views/generation.tsx` | selector + memo + OR-gate clause | T10 |
| `src/components/script-review-diff.tsx` | widened Apply-time `live` builder, `CLASS_LABELS`, `OpPreview` | T11 |
| `src/views/manuscript.tsx` | widened seed-time `live` builder (`:695`) | T11 |
| `src/lib/api.ts` | mock `reviewScript` returns a canned `validate_instruct` op (for e2e/tests) | T12 |
| `e2e/script-review-instruct.spec.ts` | apply-path e2e | T12 |

---

## Task 1: Server schema — add `validate_instruct` to `scriptReviewSchema`

**Files:**
- Modify: `server/src/handoff/schemas.ts:224-246`
- Test: `server/src/handoff/schemas.test.ts`

**Interfaces:**
- Produces: the `validate_instruct` op value and the optional fields `newInstruct: string`, `newVocalizationText: string`, `vocalization: boolean` on `ScriptReviewOp`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/handoff/schemas.test.ts`:

**Note (round-1):** `scriptReviewSchema` is **already imported** at `schemas.test.ts:14` — do NOT add an import line (duplicate-import lint). Use the existing import.

```ts
describe('scriptReviewSchema — validate_instruct (fs-58)', () => {
  // §9 degradation gate (parse-identity half): adding the 6th op + 3 optional fields
  // must not change how the existing 5 classes parse.
  it('parses the 5 existing classes byte-identically after the widening', () => {
    const five = {
      ops: [
        { id: 1, op: 'strip_tag', anchor: 'x', newText: 'y', rationale: 'r' },
        { id: 2, op: 'split', anchor: 'a', pieceCharacterIds: ['n', 'm'], rationale: 'r' },
        { id: 3, op: 'extract_dialogue', anchor: 'a', anchorEnd: 'b', pieceCharacterIds: ['n', 'm', 'n'], rationale: 'r' },
        { id: 4, op: 'merge', mergeIds: [4, 5], rationale: 'r' },
        { id: 6, op: 'fix_emotion', anchor: 'a', emotion: 'neutral', rationale: 'r' },
      ],
    };
    expect(scriptReviewSchema.parse(five)).toEqual(five);
  });

  it('parses a validate_instruct op with instruct + vocalization edits', () => {
    const parsed = scriptReviewSchema.parse({
      ops: [
        {
          id: 14,
          op: 'validate_instruct',
          newInstruct: 'a long, tired sigh',
          newVocalizationText: 'Hhh… She closed her eyes.',
          vocalization: false,
          rationale: 'instruct contradicts the calm line',
          confidence: 0.8,
        },
      ],
    });
    expect(parsed.ops[0].op).toBe('validate_instruct');
    expect(parsed.ops[0].newVocalizationText).toContain('Hhh');
  });

  it('parses a strip (empty newInstruct) with no vocalization fields', () => {
    const parsed = scriptReviewSchema.parse({
      ops: [{ id: 3, op: 'validate_instruct', newInstruct: '', rationale: 'leaks spoken content' }],
    });
    expect(parsed.ops[0].newInstruct).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`
Expected: FAIL — `Invalid enum value. Expected 'strip_tag' | ... , received 'validate_instruct'`.

- [ ] **Step 3: Implement the schema change**

In `server/src/handoff/schemas.ts`, in the `scriptReviewSchema` object (lines 224-243), edit the op enum and add three optional fields:

```ts
          op: z.enum([
            'strip_tag',
            'split',
            'extract_dialogue',
            'merge',
            'fix_emotion',
            'validate_instruct',
          ]),
          newText: z.string().optional(),
          newInstruct: z.string().optional(),
          newVocalizationText: z.string().optional(),
          anchor: z.string().optional(),
          anchorEnd: z.string().optional(),
          pieceCharacterIds: z.array(z.string()).optional(),
          mergeIds: z.array(z.number().int().positive()).optional(),
          emotion: z.enum(EMOTIONS).optional(),
          vocalization: z.boolean().optional(),
          rationale: z.string(),
          confidence: z.number().min(0).max(1).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts
git commit -m "feat(server): add validate_instruct op + fields to scriptReviewSchema (#1041)"
```

---

## Task 2: Prompt — the `validate_instruct` skill section

**Files:**
- Modify: `skills/audiobook-script-review.md` (the `## Input` section ~14-21, the op-classes section, and the strip_tag rule ~38-40)
- Test: `skills/audiobook-script-review.test.ts`

**Interfaces:**
- Produces: a prompt that documents the conditional `instruct`/`vocalization` input fields and the `validate_instruct` op (English-instruct rule, strip vs repair, vocalization repair, multilingual contract).

- [ ] **Step 1: Write the failing test**

**Note (round-1):** the test file **already** imports `readFileSync`/`fileURLToPath` (lines 9, 11) and defines a module-level `SKILL_PATH` (line 14). Do NOT re-add those imports or redeclare a `SKILL` const — read the file once via the existing path. Append:

```ts
const SKILL_MD = readFileSync(SKILL_PATH, 'utf8');

describe('audiobook-script-review skill — validate_instruct (fs-58)', () => {
  it('documents the validate_instruct op and the English-instruct rule', () => {
    expect(SKILL_MD).toMatch(/### `validate_instruct`/);
    expect(SKILL_MD).toMatch(/always English/i);
    expect(SKILL_MD).toMatch(/newInstruct/);
    expect(SKILL_MD).toMatch(/newVocalizationText/);
  });

  it('documents the conditional instruct + vocalization input fields', () => {
    const input = SKILL_MD.split('## Input')[1] ?? '';
    expect(input).toMatch(/"instruct"/);
    expect(input).toMatch(/"vocalization"/);
  });

  it('hands intentional vocalizations to validate_instruct in the strip_tag rule', () => {
    expect(SKILL_MD).toMatch(/leave intentional vocalizations to `validate_instruct`/);
  });

  // §9 degradation gate (prompt-assembly snapshot half): the existing 5-class op
  // sections must be byte-identical before/after adding validate_instruct, so the
  // 6th class can't silently perturb the other five. The validate_instruct section
  // is appended AFTER fix_emotion, so everything up to it is unchanged.
  it('leaves the 5-class section text intact above the new section', () => {
    const fiveClassRegion = SKILL_MD.split('### `validate_instruct`')[0];
    for (const cls of ['strip_tag', 'split', 'extract_dialogue', 'merge', 'fix_emotion']) {
      expect(fiveClassRegion).toContain(`### \`${cls}\``);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/audiobook-script-review.test.ts`
Expected: FAIL on the new `it` blocks.

- [ ] **Step 3: Edit the skill markdown**

In `skills/audiobook-script-review.md`:

(a) Replace the `## Input` example block so it documents the two optional fields:

```jsonc
   { "sentenceId": 3, "characterId": "halloran", "text": "\"Hard to starboard,\"",
     "instruct": "clipped, urgent",        // OPTIONAL, English — present only when the sentence has one
     "vocalization": true }                // OPTIONAL — present only when text carries a machine-prepended sound
```

Add one sentence below the example: *"`instruct` is an English delivery direction; `vocalization: true` marks a sentence whose `text` was given a machine-prepended non-verbal sound."*

(b) Add a new op section after `### fix_emotion`:

```markdown
### `validate_instruct`

Review the per-line `instruct` (always **English**) and any vocalization. The line
may be in any language (en/ru/es/fr/de); the instruct is always English.

- **Strip** an instruct that contradicts the line, is malformed, leaks content meant
  to be spoken, or is written in the book's language instead of English — supply
  `newInstruct: ""`.
- **Repair** such an instruct to a corrected English phrase — supply a non-empty
  `newInstruct`. Only repair a sentence that ALREADY has an instruct; never author one.
- **Repair/strip a vocalization** that is a non-pronounceable stage-direction or in the
  wrong language — supply `newVocalizationText` (the corrected `text`, in the book's
  language) and `vocalization` (`true` to keep the sound flag, `false` to drop it).

Do NOT police "duplicates spoken content" — you cannot see the pre-prepend text.
Abstain when in doubt.
```

(c) In the `strip_tag` "Vocalization protection" rule (~line 38-40), append: *"— leave intentional vocalizations to `validate_instruct`."*

(d) Update the stale "five classes"/"the five classes below" wording in the frontmatter `description` (line 3) and the body (~line 28) to "six classes" — they currently enumerate the old set.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/audiobook-script-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/audiobook-script-review.md skills/audiobook-script-review.test.ts
git commit -m "feat(server): validate_instruct prompt section + input-field docs (#1041)"
```

---

## Task 3: Route — thread book language + serialize instruct/vocalization

**Files:**
- Modify: `server/src/routes/script-review.ts` (the `call` object + the per-sentence serializer)
- Test: `server/src/routes/script-review.test.ts`

**Interfaces:**
- Consumes: `bookStateLanguage(state)` from `server/src/workspace/scan.ts`; `StageCall.language?` (`analyzer/index.ts:61`).
- Produces: the review call now carries `language`, and the serialized per-sentence input includes `instruct` (when present) and `vocalization: true` (when set).

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/script-review.test.ts` a unit test on the serializer. First, in `script-review.ts`, the serializer must be an **exported pure function** so it can be tested directly. Write the test against the intended export `buildReviewSentencesInput`:

```ts
import { buildReviewSentencesInput } from './script-review.js';

describe('buildReviewSentencesInput (fs-58)', () => {
  it('includes instruct only when present and vocalization only when true', () => {
    const out = buildReviewSentencesInput([
      { id: 1, characterId: 'narrator', text: 'Plain line.' },
      { id: 2, characterId: 'mira', text: 'Hhh… done.', instruct: 'a tired sigh', vocalization: true },
      { id: 3, characterId: 'mira', text: 'No instruct.', vocalization: false },
    ]);
    expect(out[0]).toEqual({ sentenceId: 1, characterId: 'narrator', text: 'Plain line.' });
    expect(out[1]).toEqual({
      sentenceId: 2, characterId: 'mira', text: 'Hhh… done.',
      instruct: 'a tired sigh', vocalization: true,
    });
    expect(out[2]).toEqual({ sentenceId: 3, characterId: 'mira', text: 'No instruct.' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: FAIL — `buildReviewSentencesInput is not a function`.

- [ ] **Step 3: Implement the serializer + language thread**

In `server/src/routes/script-review.ts` (**ground truth, verified round-1**: the per-sentence mapping is **nested inside `buildScriptReviewChapterInbox` at lines 54-58**, NOT a standalone block; and there is **no named `call` object** — `runScriptReviewChapter` is called with an **inline options object literal at lines 224-241**):

(a) Export the serializer by **lifting the nested `sentences.map(...)` out of `buildScriptReviewChapterInbox`** into a top-level function, then call it from inside the inbox builder:

```ts
export function buildReviewSentencesInput(
  sentences: Array<{ id: number; characterId: string; text: string; instruct?: string; vocalization?: boolean }>,
): Array<Record<string, unknown>> {
  return sentences.map((s) => ({
    sentenceId: s.id,
    characterId: s.characterId,
    text: s.text,
    ...(s.instruct ? { instruct: s.instruct } : {}),
    ...(s.vocalization ? { vocalization: true } : {}),
  }));
}
```

In `buildScriptReviewChapterInbox`, replace the inline `sentences.map(...)` (54-58) with `buildReviewSentencesInput(sentences)`.

(b) Thread the language. **`bookStateLanguage` must be MERGED into the EXISTING import from `'../workspace/scan.js'` at line 19** (a second `import … from '../workspace/scan.js'` trips ESLint `no-duplicate-imports`, which `npm run verify` gates):

```ts
// line 19 — add bookStateLanguage to the existing named imports:
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
```

Then add `language` to the **inline options literal** passed as `runScriptReviewChapter`'s 4th arg (lines 224-241), beside `signal`/`onChunk`/`onThrottle`:

```ts
    language: bookStateLanguage(located.state),
```

**Overflow caveat (§5.2, acceptance check — not code):** a heavily-annotated chapter's serialized input grows by the per-sentence `instruct`. Confirm a previously-passing chapter doesn't now tip over `DEFAULT_STAGE2_CHUNK_CHAR_BUDGET` (9000) and emit a misleading `chapter-failed` "split it first". No mitigation owed for v1 — note it in the PR.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): thread book language + serialize instruct/vocalization into script-review (#1041)"
```

---

## Task 4: Per-group `instructHash` stamp + segment type

**Files:**
- Modify: `server/src/audio/segments-io.ts:59-64` (segment type), and `server/src/tts/synthesise-chapter.ts:294-295` (segment type) + `:1664-1678` (stamp)
- Test: `server/src/tts/synthesise-chapter.test.ts`

**Interfaces:**
- Consumes: `resolveGroup(group).route.modelKey`, `liveInstruct` (in scope at `synthesise-chapter.ts:792`), `group.instruct`, `textHashForStale` (already imported).
- Produces: each rendered segment carries `instructHash?: string`, stamped iff the group has an explicit instruct AND rendered on the per-group qwen-1.7b liveInstruct path.

- [ ] **Step 1: Write the failing test**

In `server/src/tts/synthesise-chapter.test.ts`. **Ground truth (round-1):** this file already has the exact fixtures to use — `INSTRUCT_CAST` (a 1.7b cast, ~line 2033), an `instructSentence(id, text, instruct)` helper (~line 2044), a `makeBatchProvider()` that returns real PCM, and `synthesiseChapter` options that accept `liveInstruct`. Copy the nearest `INSTRUCT_CAST`-based test's option object and vary `liveInstruct`/`instruct`/model. `import { textHashForStale } from '../audio/segments-io.js'`. Assert against `res.segments`:

```ts
// Helper around the existing INSTRUCT_CAST fixture (copy its option object); pseudo-shape:
const runInstruct = (opts: { liveInstruct: boolean; sentences: ReturnType<typeof instructSentence>[]; modelKey?: string }) =>
  synthesiseChapter({ /* …copy the existing INSTRUCT_CAST option object…, */
    cast: INSTRUCT_CAST, liveInstruct: opts.liveInstruct, provider: makeBatchProvider() /* etc. */ });

it('stamps instructHash for a 1.7b liveInstruct group with an explicit instruct', async () => {
  const res = await runInstruct({ liveInstruct: true, sentences: [instructSentence(1, 'She closed her eyes.', 'a tired sigh')] });
  expect(res.segments.find((s) => s.sentenceIds?.includes(1))?.instructHash).toBe(textHashForStale('a tired sigh'));
});

it('omits instructHash when liveInstruct is off', async () => {
  const res = await runInstruct({ liveInstruct: false, sentences: [instructSentence(1, 'She closed her eyes.', 'a tired sigh')] });
  expect(res.segments.find((s) => s.sentenceIds?.includes(1))?.instructHash).toBeUndefined();
});

it('omits instructHash for an emotion-only group (no explicit instruct)', async () => {
  const res = await runInstruct({ liveInstruct: true, sentences: [/* a sentence with emotion set, instruct undefined */] });
  expect(res.segments.find((s) => s.sentenceIds?.includes(1))?.instructHash).toBeUndefined();
});

// §9 round-2 finding: a Qwen-1.7b group that FELL BACK to Kokoro must NOT be stamped
// (its audio ignored the instruct). Drive a fallback (e.g. a provider that throws for the
// 1.7b modelKey so resolveGroup yields a Kokoro post-fallback route, mirroring an existing
// fallback test in this file) and assert the stamp is absent even though liveInstruct is on.
it('omits instructHash for a 1.7b group that fell back to Kokoro', async () => {
  const res = await runInstruct({ liveInstruct: true, sentences: [instructSentence(1, 'x', 'a tired sigh')], /* force fallback */ });
  expect(res.segments.find((s) => s.sentenceIds?.includes(1))?.instructHash).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts -t instructHash`
Expected: FAIL — `instructHash` is `undefined` (not yet stamped).

- [ ] **Step 3: Implement the stamp + type**

(a) In `server/src/audio/segments-io.ts`, add `instructHash?: string;` to the `segments?: Array<{…}>` type (after `textHash?: string;`, line 63), with a one-line comment mirroring the `textHash` doc.

(b) In `server/src/tts/synthesise-chapter.ts`, add `instructHash?: string;` to the local `ChapterSegment` type (next to `textHash?: string;` at line 295).

(c) In the segment-push loop at `synthesise-chapter.ts:1664-1678`, compute the gate per group and add the field:

```ts
    const groupRoute = resolveGroup(group);
    const groupIs17b = groupRoute.route.modelKey === 'qwen3-tts-1.7b';
    // Stamp the RAW EXPLICIT instruct iff it would have ridden the per-group
    // 1.7b liveInstruct path. groupRoute.route is post-fallback, so a Qwen-1.7b
    // group that fell back to Kokoro has modelKey !== 'qwen3-tts-1.7b' and is
    // correctly un-stamped. Emotion-derived instructs have group.instruct == null
    // and are not stamped (matches what resolveInstructForGroup would not key here).
    const instructHash =
      group.instruct != null && liveInstruct && groupIs17b
        ? textHashForStale(group.instruct)
        : undefined;
    segments.push({
      groupIndex: group.index,
      characterId: group.characterId,
      sentenceIds: group.sentenceIds.slice(),
      textHash: textHashForStale(group.text),
      instructHash,
      startSec,
      endSec,
      renderedFallbackEngine: resolveGroup(group).renderedFallbackEngine,
      voiceSubstitutedFrom: r.voiceSubstitutedFrom,
      qa,
      suspect: quarantined || qa?.status === 'suspect' ? true : undefined,
      asr: asrClass,
      asrSuspect: asrClass?.verdict === 'drift' ? true : undefined,
      quarantined: quarantined ? true : undefined,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts -t instructHash`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/audio/segments-io.ts server/src/tts/synthesise-chapter.test.ts
git commit -m "feat(server): stamp per-group instructHash on the 1.7b liveInstruct path (#1041)"
```

---

## Task 5: Collector + book-state GET wiring

**Files:**
- Modify: `server/src/audio/segments-io.ts` (add collector after `collectRenderedTextHashesByChapter`, line ~183), `server/src/routes/book-state.ts:451-479`
- Test: `server/src/audio/segments-io.test.ts`, `server/src/routes/book-state.test.ts`

**Interfaces:**
- Consumes: `loadSegmentsFiles`, the segment `instructHash` (Task 4).
- Produces: `collectRenderedInstructHashesByChapter(bookDir, chapters): Promise<Record<number, Record<number, string>>>` and `renderedInstructByChapter` on the book-state GET response.

- [ ] **Step 1: Write the failing test**

Append to `server/src/audio/segments-io.test.ts` (mirror the `collectRenderedTextHashesByChapter` describe at line 142):

```ts
import { collectRenderedInstructHashesByChapter } from './segments-io.js';

describe('collectRenderedInstructHashesByChapter (fs-58)', () => {
  it('inverts per-segment instructHash to {chapterId:{sentenceId:hash}}, omitting empty chapters', async () => {
    // Seed two segments.json: ch1 has a segment with instructHash, ch2 has none.
    // (Reuse the fixture-writing helper used by the textHash describe above.)
    const res = await collectRenderedInstructHashesByChapter(bookDir, chapters);
    expect(res).toEqual({ 1: { 5: 'abc123' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/audio/segments-io.test.ts -t collectRenderedInstructHashesByChapter`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement the collector**

In `server/src/audio/segments-io.ts`, after `collectRenderedTextHashesByChapter` (line 183), add (an exact copy keyed on `instructHash`):

```ts
/* fs-58 — the render-time sentence→instructHash map per rendered chapter, recovered
   from each segment's `instructHash` (stamped only on the per-group 1.7b liveInstruct
   path). Shape: `{ [chapterId]: { [sentenceId]: instructHash } }`. The frontend diffs
   it against the live manuscript `instruct` to flag a chapter whose instruct was edited
   after it rendered — the instruct sibling of collectRenderedTextHashesByChapter.

   Only chapters with at least one stamped instructHash appear; a chapter that rendered
   on a non-liveInstruct engine (nothing stamped) is omitted so the client reads it as
   "can't tell" rather than "every instruct edited". */
export async function collectRenderedInstructHashesByChapter(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<Record<number, Record<number, string>>> {
  const out: Record<number, Record<number, string>> = {};
  const segs = await loadSegmentsFiles(bookDir, chapters);
  for (const seg of segs) {
    const map: Record<number, string> = {};
    for (const s of seg.segments ?? []) {
      if (!s.instructHash || !Array.isArray(s.sentenceIds)) continue;
      for (const sid of s.sentenceIds) {
        if (typeof sid === 'number') map[sid] = s.instructHash;
      }
    }
    if (Object.keys(map).length > 0) out[seg.chapterId] = map;
  }
  return out;
}
```

- [ ] **Step 4: Wire the GET (write the route test first)**

Add to `server/src/routes/book-state.test.ts` (mirror the `renderedTextByChapter` describe at line 230):

```ts
describe('book-state router — renderedInstructByChapter (#1041)', () => {
  it('returns {} when no chapter stamped an instructHash', async () => {
    const res = await /* GET book-state via supertest, as the sibling test does */;
    expect(res.body.renderedInstructByChapter).toEqual({});
  });
});
```

**Round-1 fixes:** (i) the route test's GET helper — model it on the **sibling describe at `book-state.test.ts:230`** (it asserts `res.body.renderedTextByChapter` via supertest; copy its setup verbatim and assert `renderedInstructByChapter`). (ii) the collector test's fixture-writer (`writeSegmentsWithText`) is **describe-private** at `segments-io.test.ts:143-151` — copy that ~9-line helper into the new describe and add `instructHash?` to its local segment type. (iii) the real collection call **wraps `.catch(() => ({}))`** and passes **`state.chapters`** (NOT a `chaptersForCollect` variable — that doesn't exist) — mirror exactly, or a throwing collector 500s the whole GET:

Then in `server/src/routes/book-state.ts`, add `collectRenderedInstructHashesByChapter` to the **existing** `../audio/segments-io.js` import group (lines 61-63 — don't add a second import line), and beside the `renderedTextByChapter` collection (line ~451) and its response inclusion (line ~479):

```ts
// near line 451, beside renderedTextByChapter (note the .catch — required):
const renderedInstructByChapter = await collectRenderedInstructHashesByChapter(
  bookDir,
  state.chapters,
).catch(() => ({}));

// in the response object near line 479:
  renderedTextByChapter,
  renderedInstructByChapter,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/audio/segments-io.test.ts src/routes/book-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/audio/segments-io.ts server/src/routes/book-state.ts server/src/audio/segments-io.test.ts server/src/routes/book-state.test.ts
git commit -m "feat(server): collectRenderedInstructHashesByChapter + book-state GET wiring (#1041)"
```

---

## Task 6: `setSentenceText` tri-state vocalization param

**Files:**
- Modify: `src/store/manuscript-slice.ts:280-283`
- Test: `src/store/manuscript-slice.test.ts`

**Interfaces:**
- Produces: `setSentenceText({ chapterId, sentenceId, text, vocalization? })` where `vocalization` is tri-state: `undefined` ⇒ leave the flag untouched; `true` ⇒ set; `false` ⇒ delete.

- [ ] **Step 1: Write the failing test**

Append to `src/store/manuscript-slice.test.ts`. **Ground truth (round-1):** the only state helper in `manuscript-slice.test-helpers.ts` is **`start(...)`** (it accepts `vocalization?`); there is **NO `makeManuscriptState`/`find`**. The existing `setSentenceText` describe (manuscript-slice.test.ts:819) uses `start([...])` + `reducer` + an inline `.sentences.find(...)`. Match that:

```ts
const find1 = (s: ReturnType<typeof reducer>) =>
  s.sentences.find((x) => x.chapterId === 1 && x.id === 1)!;

describe('setSentenceText — vocalization tri-state (fs-58)', () => {
  const base = () => start([
    { chapterId: 1, id: 1, characterId: 'mira', text: 'Hhh… done.', vocalization: true },
  ]);

  it('leaves an existing vocalization:true intact when no param is passed (strip_tag path)', () => {
    const s = reducer(base(), manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'done.' }));
    expect(find1(s).vocalization).toBe(true);
  });

  it('sets the flag when vocalization:true', () => {
    const s0 = start([{ chapterId: 1, id: 1, characterId: 'mira', text: 'X' }]);
    const s = reducer(s0, manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'Ah! X', vocalization: true }));
    expect(find1(s).vocalization).toBe(true);
  });

  it('deletes the flag when vocalization:false (absent, not === false)', () => {
    const s = reducer(base(), manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'done.', vocalization: false }));
    expect('vocalization' in find1(s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/store/manuscript-slice.test.ts -t "vocalization tri-state"`
Expected: FAIL — the param isn't read; the "deletes the flag" case fails (flag still true).

- [ ] **Step 3: Implement the tri-state param**

Replace `setSentenceText` in `src/store/manuscript-slice.ts:280-283`:

```ts
    /* fs-58 — User edit: replace a sentence's text (strip_tag + validate_instruct
       vocalization targets). Scoped by (chapterId, sentenceId). The optional
       `vocalization` is TRI-STATE: undefined ⇒ leave the flag untouched (so an
       unrelated strip_tag text edit can't wipe a vocalization:true sentence —
       locked by a regression test); true ⇒ set; false ⇒ delete (never store false). */
    setSentenceText: (
      s,
      a: PayloadAction<{ chapterId: number; sentenceId: number; text: string; vocalization?: boolean }>,
    ) => {
      const sent = s.sentences.find(
        (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
      );
      if (!sent) return;
      sent.text = a.payload.text;
      if (a.payload.vocalization === undefined) return; // leave the flag untouched
      if (a.payload.vocalization) sent.vocalization = true;
      else delete sent.vocalization;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/store/manuscript-slice.test.ts -t "vocalization tri-state"`
Expected: PASS. Also run the file's existing `setSentenceText` tests — they must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/manuscript-slice.test.ts
git commit -m "feat(frontend): tri-state vocalization param on setSentenceText (#1041)"
```

---

## Task 7: Apply — `ReviewOp` fields, widened `live`, guards + partial-apply normalization

**Files:**
- Modify: `src/lib/script-review-apply.ts:43-130` (`ReviewOp`, the `live` type, `planApply`)
- Modify: `src/components/script-review-diff.tsx:105-110` (Apply-time `live` builder) + `src/views/manuscript.tsx:695-700` (seed-time `live` builder) — both widened here (round-1, see step 3(d))
- Test: `src/lib/script-review-apply.test.ts`, `src/views/manuscript.test.tsx`

**Interfaces:**
- Consumes: the widened `live` element `{ id; chapterId; text; characterId; instruct?; vocalization? }`.
- Produces: `planApply` accepts `validate_instruct`. For a `validate_instruct` op it **normalizes** the op — returning a copy with only the *appliable* halves (drops `newInstruct` if the repair guard fails; drops `newVocalizationText`/`vocalization` if the vocalization guard fails). An op with no appliable half goes to `unappliable`. `strip_tag` wins a same-id text collision.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/script-review-apply.test.ts`:

```ts
const liveOne = (over: Partial<{ instruct: string; vocalization: boolean; text: string }> = {}) => ([
  { id: 1, chapterId: 1, text: over.text ?? 'A calm line.', characterId: 'mira',
    instruct: over.instruct, vocalization: over.vocalization },
]);

describe('planApply — validate_instruct (fs-58)', () => {
  it('keeps a repair when the sentence has a current instruct', () => {
    const { appliable } = planApply(
      [{ id: 1, op: 'validate_instruct', newInstruct: 'a calm, even tone', rationale: 'r' }],
      liveOne({ instruct: 'shouting' }),
    );
    expect(appliable).toHaveLength(1);
    expect(appliable[0].newInstruct).toBe('a calm, even tone');
  });

  it('drops a repair (no current instruct) but keeps the vocalization half of a both-row', () => {
    const { appliable } = planApply(
      [{ id: 1, op: 'validate_instruct', newInstruct: 'x', newVocalizationText: 'Ah! line', vocalization: true, rationale: 'r' }],
      liveOne({ vocalization: true }), // has vocalization, no instruct
    );
    expect(appliable).toHaveLength(1);
    expect(appliable[0].newInstruct).toBeUndefined();        // repair half dropped
    expect(appliable[0].newVocalizationText).toBe('Ah! line'); // vocalization half kept
  });

  it('treats a whitespace-only newInstruct as a strip (no current-instruct guard)', () => {
    const { appliable } = planApply(
      [{ id: 1, op: 'validate_instruct', newInstruct: '   ', rationale: 'r' }],
      liveOne(), // no instruct
    );
    // strip on an instruct-less sentence is a silent no-op: dropped from appliable, not unappliable
    expect(appliable).toHaveLength(0);
  });

  it('rejects the vocalization edit when the sentence is not vocalization:true', () => {
    const { appliable, unappliable } = planApply(
      [{ id: 1, op: 'validate_instruct', newVocalizationText: 'Ah! x', vocalization: false, rationale: 'r' }],
      liveOne(), // not vocalization
    );
    expect(appliable).toHaveLength(0);
    expect(unappliable).toHaveLength(1);
  });

  it('strip_tag wins a same-id text collision regardless of op order', () => {
    const ops = [
      { id: 1, op: 'validate_instruct', newVocalizationText: 'Ah! line', vocalization: true, rationale: 'r' },
      { id: 1, op: 'strip_tag', anchor: 'A calm line.', newText: 'calm line', rationale: 'r' },
    ];
    const { appliable, unappliable } = planApply(ops as never, liveOne({ vocalization: true }));
    expect(appliable.find((o) => o.op === 'strip_tag')).toBeTruthy();
    expect(unappliable.find((u) => u.op.op === 'validate_instruct')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/script-review-apply.test.ts -t "planApply — validate_instruct"`
Expected: FAIL — `validate_instruct` not handled.

- [ ] **Step 3: Implement the type + guards + normalization**

In `src/lib/script-review-apply.ts`:

(a) Extend `ReviewOp` (line 43) — add to the `op` union `| 'validate_instruct'` and add fields:

```ts
  newInstruct?: string;
  newVocalizationText?: string;
  vocalization?: boolean;
```

(b) Widen the `live` element type everywhere it appears (the `planApply` and `dispatchAcceptedOps` signatures, ~lines 91 and 135):

```ts
  live: Array<{ id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }>,
```

(c) In `planApply`, treat `validate_instruct` as a **text-writer-aware, partial-normalizing** non-structural op. Replace the non-structural loop (lines 123-128) with:

```ts
  const textTargets = new Set<number>(); // strip_tag / validate_instruct-vocalization collisions

  // strip_tag first so it deterministically wins a same-id text collision.
  const nonStructural = ops.filter((o) => !STRUCTURAL.has(o.op));
  const ordered = [
    ...nonStructural.filter((o) => o.op === 'strip_tag'),
    ...nonStructural.filter((o) => o.op !== 'strip_tag'),
  ];

  for (const op of ordered) {
    if (consumed.has(op.id)) { unappliable.push({ op, reason: 'id consumed by a structural op' }); continue; }
    const s = byId.get(op.id);
    if (!s) { unappliable.push({ op, reason: 'target id missing' }); continue; }

    if (op.op === 'strip_tag') {
      textTargets.add(op.id);
      appliable.push(op);
      continue;
    }

    if (op.op === 'fix_emotion') {
      if (!REVIEW_EMOTIONS.includes(op.emotion as never)) { unappliable.push({ op, reason: 'invalid emotion value' }); continue; }
      appliable.push(op);
      continue;
    }

    if (op.op === 'validate_instruct') {
      // Normalize: keep only the appliable halves.
      const norm: ReviewOp = { ...op };
      // instruct half
      if (norm.newInstruct !== undefined) {
        const isStrip = norm.newInstruct.trim() === '';
        if (isStrip) {
          if (!s.instruct) delete norm.newInstruct; // strip on instruct-less = no-op, drop
        } else if (!s.instruct || s.instruct === norm.newInstruct.trim()) {
          delete norm.newInstruct; // repair needs an existing, different instruct
        }
      }
      // vocalization half — capture WHY it dropped so a collision is surfaced, not silent
      let vocalDropReason: string | null = null;
      if (norm.newVocalizationText !== undefined) {
        if (!s.vocalization) vocalDropReason = 'sentence is not a vocalization';
        else if (textTargets.has(op.id)) vocalDropReason = 'text already claimed by strip_tag'; // strip_tag wins
        if (vocalDropReason) {
          delete norm.newVocalizationText;
          delete norm.vocalization;
        } else {
          textTargets.add(op.id);
        }
      }
      const hasInstruct = norm.newInstruct !== undefined;
      const hasVocal = norm.newVocalizationText !== undefined;
      if (!hasInstruct && !hasVocal) {
        // A pure-strip-on-instruct-less instruct edit is a silent no-op (not surfaced).
        // A DROPPED vocalization edit (wrong sentence OR strip_tag collision) IS surfaced
        // as un-appliable — the collision test asserts this.
        if (vocalDropReason) unappliable.push({ op, reason: vocalDropReason });
        continue;
      }
      appliable.push(norm);
      continue;
    }

    appliable.push(op); // any other non-structural op unchanged
  }
```

(Keep the existing structural-op loop above it untouched; `REVIEW_EMOTIONS`, `STRUCTURAL`, `consumed`, `byId` already exist.)

(d) **Widen BOTH production `live` builders in this same task** (round-1 — closes the dead-feature window: `planApply` runs at *seed time* too, so if the builders aren't widened the guards see `instruct: undefined` and reject every op silently, with green unit tests):
- `src/components/script-review-diff.tsx:105-110` (Apply-time builder) — add `instruct: s.instruct, vocalization: s.vocalization,` to each mapped sentence.
- `src/views/manuscript.tsx:695-700` (seed-time builder feeding the `planApply` at `:704`) — add the same two fields.

(`s.instruct`/`s.vocalization` are typed on the manuscript `Sentence`, so both typecheck.) Add a **seed-path test** to `src/views/manuscript.test.tsx`: a seeded `validate_instruct` repair op against a sentence that HAS an instruct survives the seed-time `planApply` (lands in the suggestions, not silently dropped).

**Round-1 note on Step 1:** until step 3(a) adds `'validate_instruct'` to the `ReviewOp` `op` union, the new op literals are a TS union error — cast each `as never` (as the collision test already does: `planApply(ops as never, …)`) OR accept that `npm run typecheck` is expected-red on this file mid-task (it self-heals at step 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/script-review-apply.test.ts src/views/manuscript.test.tsx`
Expected: PASS (the new describes + all existing planApply tests stay green; the seed-path test proves the widened builder reaches the op).

- [ ] **Step 5: Commit**

```bash
git add src/lib/script-review-apply.ts src/lib/script-review-apply.test.ts src/components/script-review-diff.tsx src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): planApply guards + normalization + widen both live builders (#1041)"
```

---

## Task 8: Apply — dispatch case + `boundary_move` carve-out

**Files:**
- Modify: `src/lib/script-review-apply.ts:132-169` (`dispatchAcceptedOps`)
- Test: `src/lib/script-review-apply.test.ts`

**Interfaces:**
- Consumes: the normalized appliable ops from Task 7 (a `validate_instruct` op here carries only the halves that will dispatch).
- Produces: `dispatchAcceptedOps` dispatches `setSentenceInstruct`/`setSentenceText` for `validate_instruct` and calls `onBoundaryMove` only for a real text/structure/speaker change — **never for an instruct-only edit**.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/script-review-apply.test.ts`:

```ts
describe('dispatchAcceptedOps — validate_instruct (fs-58)', () => {
  const live = [{ id: 1, chapterId: 1, text: 'x', characterId: 'mira', instruct: 'old', vocalization: true }];

  it('instruct-only edit dispatches setSentenceInstruct and does NOT bump boundary_move', () => {
    const dispatched: any[] = []; const bumped: number[] = [];
    dispatchAcceptedOps(
      ((a: any) => dispatched.push(a)) as never,
      [{ id: 1, op: 'validate_instruct', newInstruct: 'new', rationale: 'r' }],
      live,
      { onBoundaryMove: (c) => bumped.push(c) },
    );
    expect(dispatched.some((a) => a.type.endsWith('setSentenceInstruct'))).toBe(true);
    expect(bumped).toEqual([]); // engine-aware: instruct-only never time-stales
  });

  it('vocalization edit dispatches setSentenceText and DOES bump boundary_move', () => {
    const dispatched: any[] = []; const bumped: number[] = [];
    dispatchAcceptedOps(
      ((a: any) => dispatched.push(a)) as never,
      [{ id: 1, op: 'validate_instruct', newVocalizationText: 'Ah! x', vocalization: false, rationale: 'r' }],
      live,
      { onBoundaryMove: (c) => bumped.push(c) },
    );
    expect(dispatched.some((a) => a.type.endsWith('setSentenceText'))).toBe(true);
    expect(bumped).toEqual([1]);
  });

  // §9 round-2 hole: a "both" row whose vocalization half planApply DROPPED must reach
  // dispatch as instruct-only → no setSentenceText, no boundary bump (no false-stale on
  // Kokoro). planApply normalizes the dropped half away, so dispatch sees no newVocalizationText.
  it('a both-row whose vocalization half was dropped does NOT bump boundary_move', () => {
    const dispatched: any[] = []; const bumped: number[] = [];
    // Feed planApply a both-row against a NON-vocalization sentence (vocal half drops),
    // then dispatch the normalized appliable result — mirrors the modal's real flow.
    const liveNoVocal = [{ id: 1, chapterId: 1, text: 'x', characterId: 'mira', instruct: 'old' }];
    const { appliable } = planApply(
      [{ id: 1, op: 'validate_instruct', newInstruct: 'new', newVocalizationText: 'Ah! x', vocalization: true, rationale: 'r' }] as never,
      liveNoVocal,
    );
    dispatchAcceptedOps(((a: any) => dispatched.push(a)) as never, appliable, liveNoVocal, { onBoundaryMove: (c) => bumped.push(c) });
    expect(dispatched.some((a) => a.type.endsWith('setSentenceInstruct'))).toBe(true);
    expect(dispatched.some((a) => a.type.endsWith('setSentenceText'))).toBe(false);
    expect(bumped).toEqual([]); // instruct-only effect → no false-stale
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/script-review-apply.test.ts -t "dispatchAcceptedOps — validate_instruct"`
Expected: FAIL — no `validate_instruct` case; `boundary_move` unconditional.

- [ ] **Step 3: Implement the dispatch case + carve-out**

In `dispatchAcceptedOps`, replace the unconditional `onBoundaryMove(chapterId)` at the end of the loop (line 167) with a per-op decision, and add the `validate_instruct` case:

```ts
  for (const op of accepted) {
    const target = byId.get(op.op === 'merge' ? (op.mergeIds?.[0] ?? op.id) : op.id);
    if (!target) continue;
    const chapterId = target.chapterId;
    let changedTextOrStructure = true; // strip_tag/split/extract/merge/fix_emotion all stale on every engine
    switch (op.op) {
      case 'strip_tag':
        dispatch(manuscriptActions.setSentenceText({ chapterId, sentenceId: op.id, text: op.newText ?? target.text }));
        break;
      case 'fix_emotion':
        dispatch(manuscriptActions.setSentenceEmotion({ chapterId, sentenceId: op.id, emotion: op.emotion ?? 'neutral' }));
        break;
      case 'validate_instruct': {
        if (op.newInstruct !== undefined)
          dispatch(manuscriptActions.setSentenceInstruct({ chapterId, sentenceId: op.id, instruct: op.newInstruct }));
        if (op.newVocalizationText !== undefined)
          dispatch(manuscriptActions.setSentenceText({ chapterId, sentenceId: op.id, text: op.newVocalizationText, vocalization: op.vocalization }));
        // Carve-out: bump boundary_move ONLY when the text actually changed (vocalization
        // half dispatched). An instruct-only edit changes no text and must rely solely on
        // the precise instructHash path, or it would engine-blind false-stale Kokoro.
        changedTextOrStructure = op.newVocalizationText !== undefined;
        break;
      }
      case 'split': {
        const off = resolveAnchorOffset(target.text, op.anchor ?? '');
        if (off === null) continue;
        dispatch(manuscriptActions.splitSentence({ chapterId, sentenceId: op.id, offsets: [off], characterIds: op.pieceCharacterIds ?? [target.characterId, target.characterId] }));
        break;
      }
      case 'extract_dialogue': {
        const start = resolveAnchorOffset(target.text, op.anchor ?? '');
        const end = resolveAnchorOffset(target.text, op.anchorEnd ?? '');
        if (start === null || end === null || end <= start) continue;
        dispatch(manuscriptActions.splitSentence({ chapterId, sentenceId: op.id, offsets: [start, end], characterIds: op.pieceCharacterIds ?? [target.characterId, target.characterId, target.characterId] }));
        break;
      }
      case 'merge':
        dispatch(manuscriptActions.mergeSentences({ chapterId, sentenceIds: op.mergeIds ?? [] }));
        break;
    }
    if (changedTextOrStructure) onBoundaryMove(chapterId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/script-review-apply.test.ts`
Expected: PASS (new describe + existing dispatch tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/script-review-apply.ts src/lib/script-review-apply.test.ts
git commit -m "feat(frontend): dispatch validate_instruct + boundary_move carve-out (#1041)"
```

---

## Task 9: Frontend staleness — `isChapterInstructEditedSinceRender` + the `renderedInstructByChapter` thread

**Files:**
- Modify: `src/lib/stale-chapters.ts` (after line 112), `src/lib/types.ts:427`, `src/store/chapters-slice.ts:104/115/262/273/277`, `src/components/layout.tsx:766`
- Test: `src/lib/stale-chapters.test.ts`

**Interfaces:**
- Produces: `isChapterInstructEditedSinceRender(renderedInstructHashes, currentSentences): boolean` and the `renderedInstructByChapter?` field threaded into `ChaptersState`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/stale-chapters.test.ts` (mirror the `isChapterTextEditedSinceRender` describe at line 164):

```ts
import { isChapterInstructEditedSinceRender } from './stale-chapters';

describe('isChapterInstructEditedSinceRender (fs-58 precise instruct diff)', () => {
  const rendered = { 1: textHashForStale('a tired sigh') } as Record<number, string>;
  it('not stale when the live instruct matches the stamp', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1, instruct: 'a tired sigh' }])).toBe(false);
  });
  it('stale when the instruct was edited', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1, instruct: 'shouting' }])).toBe(true);
  });
  it('stale when the instruct was cleared', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1 }])).toBe(true);
  });
  it('not stale when no stamps exist (non-liveInstruct render)', () => {
    expect(isChapterInstructEditedSinceRender(undefined, [{ id: 1, instruct: 'x' }])).toBe(false);
    expect(isChapterInstructEditedSinceRender({}, [{ id: 1, instruct: 'x' }])).toBe(false);
  });
  // §6.5 trim invariant: the server stamps the TRIMMED instruct (setSentenceInstruct trims
  // on write); a live value differing only in surrounding whitespace must read NOT stale.
  it('not stale when the live instruct differs only by surrounding whitespace', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1, instruct: '  a tired sigh  ' }])).toBe(false);
  });
});
```

For the whitespace case to pass, `isChapterInstructEditedSinceRender` must hash the **trimmed** live value (`(s.instruct ?? '').trim()`) — see step 3(a).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/stale-chapters.test.ts -t "isChapterInstructEditedSinceRender"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the diff fn + thread the field**

(a) In `src/lib/stale-chapters.ts`, after `isChapterTextEditedSinceRender` (line 112), add:

```ts
/* fs-58 — PRECISE instruct staleness, the instruct sibling of
   isChapterTextEditedSinceRender. A rendered chapter whose sentence `instruct` was
   edited after it rendered ON THE 1.7b liveInstruct path is stale (only that path's
   audio depends on the instruct). Derived from the render-time instructHash map
   (only populated for liveInstruct renders) vs the live `instruct`. Asymmetric —
   iterate the stamped ids only; a chapter with no stamps reads not-stale (a
   non-liveInstruct render never used the instruct). Hash the live instruct the same
   way the server stamps it: textHashForStale of the raw (trimmed) string. */
export function isChapterInstructEditedSinceRender(
  renderedInstructHashes: Record<number, string> | undefined,
  currentSentences: Array<{ id: number; instruct?: string }>,
): boolean {
  if (!renderedInstructHashes || Object.keys(renderedInstructHashes).length === 0) return false;
  const current = new Map<number, string>();
  // Trim to match the server stamp (setSentenceInstruct stores the trimmed value, §6.5).
  for (const s of currentSentences) current.set(s.id, (s.instruct ?? '').trim());
  for (const sidStr of Object.keys(renderedInstructHashes)) {
    const sid = Number(sidStr);
    const liveInstruct = current.get(sid) ?? '';
    if (textHashForStale(liveInstruct) !== renderedInstructHashes[sid]) return true;
  }
  return false;
}
```

(b) `src/lib/types.ts:427` — beside `renderedTextByChapter?`:

```ts
  renderedInstructByChapter?: Record<number, Record<number, string>>;
```

(c) `src/store/chapters-slice.ts` — declare the field **optional** (avoids `ChaptersState` literal churn): at the `ChaptersState` interface (line ~104) add `renderedInstructByChapter?: Record<number, Record<number, string>>;`; in `initialState` (line ~115) **do not** add a required default (it's optional); in the hydrate payload type (line ~262) add `renderedInstructByChapter?: Record<number, Record<number, string>>;`; in the destructure (line ~273) add `renderedInstructByChapter`; in the assign (line ~277) add `s.renderedInstructByChapter = renderedInstructByChapter ?? {};`.

(d) `src/components/layout.tsx:766` — beside `renderedTextByChapter: res.renderedTextByChapter,` add `renderedInstructByChapter: res.renderedInstructByChapter,`.

- [ ] **Step 4: Run test + typecheck**

Run: `npm test -- src/lib/stale-chapters.test.ts` then `npm run typecheck`
Expected: PASS, no type errors (the optional field means the 3 `ChaptersState` test literals need no edit).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stale-chapters.ts src/lib/types.ts src/store/chapters-slice.ts src/components/layout.tsx src/lib/stale-chapters.test.ts
git commit -m "feat(frontend): isChapterInstructEditedSinceRender + renderedInstructByChapter thread (#1041)"
```

---

## Task 10: Generate view — selector + memo + OR-gate clause

**Files:**
- Modify: `src/views/generation.tsx:70` (import), `:173` (selector), `:672-688` (memo), `:1190` (OR-gate)
- Test: `src/views/generation.test.tsx`

**Interfaces:**
- Consumes: `isChapterInstructEditedSinceRender` (Task 9), `s.chapters.renderedInstructByChapter` (Task 9).
- Produces: a chapter reads stale in the Generate view when its instruct was edited since a liveInstruct render.

- [ ] **Step 1: Write the failing test**

In `src/views/generation.test.tsx`. **Ground truth (round-1):** there is **no `chapter-1-stale` testid** — the only staleness indicator is the caption text `/Sentences reassigned · regenerate to refresh/i` (asserted via `getByText` at `:1441/1518`). Copy `renderWithTextMap` (`:1452`) to `renderWithInstructMap`, but note its `hydrateFromBookState` dispatch (`:1466`) currently passes only `renderedTextByChapter` — **add `renderedInstructByChapter`** to that dispatch, and seed a live sentence whose `instruct` differs from the stamped value:

```ts
function renderWithInstructMap(map: Record<number, Record<number, string>>): void {
  // identical to renderWithTextMap but dispatch hydrateFromBookState with
  // renderedInstructByChapter: map, and seed manuscript sentence 1 with instruct 'new'.
}

it('marks a done chapter stale when its rendered instruct was edited (fs-58)', () => {
  renderWithInstructMap({ 1: { 1: textHashForStale('old') } }); // live instruct is 'new' ≠ 'old'
  expect(screen.getByText(/Sentences reassigned · regenerate to refresh/i)).toBeInTheDocument();
});
```

**Copy note (MINOR):** an instruct-only edit surfaces under the same "Sentences reassigned" caption — semantically loose wording for an instruct edit, but acceptable for v1 (no copy change in scope).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/views/generation.test.tsx -t "instruct was edited"`
Expected: FAIL — the indicator is absent (instruct staleness not wired).

- [ ] **Step 3: Wire selector + memo + OR-gate**

(a) Import (line 70 group): add `isChapterInstructEditedSinceRender,`.

(b) Selector (beside line 173-174):

```ts
  const renderedInstructByChapter = useAppSelector(
    (s) => s.chapters.renderedInstructByChapter ?? {},
  );
```

(c) Memo (beside the `textEditedSinceRenderSet` memo at 672-688). **Round-1:** the text memo builds its `byChapter` map **inline in its own closure** — there is no shared variable to reference. Reproduce the same grouping here, carrying `instruct` instead of `text`:

```ts
  const instructEditedSinceRenderSet = useMemo(() => {
    const byChapter = new Map<number, Array<{ id: number; instruct?: string }>>();
    for (const s of sentences) {
      const arr = byChapter.get(s.chapterId) ?? [];
      arr.push({ id: s.id, instruct: s.instruct });
      byChapter.set(s.chapterId, arr);
    }
    const set = new Set<number>();
    for (const cid of Object.keys(renderedInstructByChapter)) {
      const cidNum = Number(cid);
      if (isChapterInstructEditedSinceRender(renderedInstructByChapter[cidNum], byChapter.get(cidNum) ?? [])) {
        set.add(cidNum);
      }
    }
    return set;
  }, [renderedInstructByChapter, sentences]);
```

(d) OR-gate (line 1190) — add the third precise clause:

```ts
                (renderedInstructByChapter[ch.id] ? instructEditedSinceRenderSet.has(ch.id) : false) ||
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/views/generation.test.tsx -t "instruct was edited"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/generation.tsx src/views/generation.test.tsx
git commit -m "feat(frontend): wire instruct staleness into the Generate view OR-gate (#1041)"
```

---

## Task 11: Diff UX — `CLASS_LABELS` + `OpPreview` for `validate_instruct`

(The two `live` builders are widened in T7 — round-1 reordering. This task is the diff-row rendering only.)

**Files:**
- Modify: `src/components/script-review-diff.tsx` (`CLASS_LABELS` ~19-25; `OpPreview` decl ~34 + its call site ~235)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: the widened `live` element (T7) — the diff already builds a live snapshot per sentence.
- Produces: a `validate_instruct` row renders a labelled before→after (current instruct/vocalization → proposed).

- [ ] **Step 1: Write the failing test**

Append to `src/components/script-review-diff.test.tsx` (model the seeding on the existing diff tests in this file — they seed the script-review slice + a manuscript sentence). Seed a `validate_instruct` op (id 1, `newInstruct: 'a calm tone'`) and a live sentence whose `instruct` is `'shouting'`:

```ts
it('renders a validate_instruct row with a class label and before→after instruct (fs-58)', () => {
  // (use the file's existing render+seed helper; seed sentence 1 with instruct: 'shouting'
  //  and a validate_instruct suggestion newInstruct: 'a calm tone')
  renderDiffWith(/* …existing helper… */);
  expect(screen.getByText('Instruct')).toBeInTheDocument();   // CLASS_LABELS heading
  expect(screen.getByText(/shouting/)).toBeInTheDocument();   // before
  expect(screen.getByText(/a calm tone/)).toBeInTheDocument();// after
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/script-review-diff.test.tsx -t "validate_instruct row"`
Expected: FAIL — no `Instruct` label (`classLabel` falls back to the raw op string), and `OpPreview` returns `null` for the unknown op.

- [ ] **Step 3: Implement label + preview (REAL prop surgery)**

(a) `CLASS_LABELS` (script-review-diff.tsx ~19-25): add `validate_instruct: 'Instruct',`.

(b) **`OpPreview` (declaration at ~34, NOT line 69 which is its closing `return null`).** Round-1 ground truth: `OpPreview` is typed `({ op, before }: { op: ReviewOp; before?: string })` and the call site (~235) passes `before={liveText}` — a **bare text string**, not a sentence object. So you MUST thread the live instruct/vocalization explicitly:
- Add props: `OpPreview({ op, before, liveInstruct, liveVocalization }: { op: ReviewOp; before?: string; liveInstruct?: string; liveVocalization?: boolean })`.
- At the call site (~235), source them from the same `sentences.find(...)` that already produces `liveText`: pass `liveInstruct={liveSentence?.instruct} liveVocalization={liveSentence?.vocalization}` (lift the `find` into a `const liveSentence` if it's currently inlined for `before`).
- Add the `validate_instruct` branch to `OpPreview`:
  - instruct edit (`op.newInstruct !== undefined`): `before = liveInstruct ?? '(none)'`, `after = op.newInstruct.trim() === '' ? '(stripped)' : op.newInstruct`.
  - vocalization edit (`op.newVocalizationText !== undefined`): `before = before /* the live text */`, `after = op.newVocalizationText`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/script-review-diff.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): validate_instruct diff row (CLASS_LABELS + OpPreview) (#1041)"
```

---

## Task 12: Mock op + e2e + slice coverage

**Files:**
- Modify: `src/lib/api.ts` (mock `mockReviewScript` — add a canned `validate_instruct` op), `src/mocks/canned-data.ts` (seed an `instruct` on the targeted sentence), `src/store/script-review-slice.test.ts`
- Create: `e2e/script-review-instruct.spec.ts` (copy `e2e/script-review.spec.ts`). No `coverage.spec.ts` case — validate_instruct adds no new view.

**Interfaces:**
- Consumes: the whole apply path (Tasks 6-11) + the mock.
- Produces: an e2e proving review → `validate_instruct` row → accept → manuscript updates.

- [ ] **Step 1: Write the slice characterization test** (NOT a TDD red — the slice is op-agnostic, so this is expected to PASS as-is; it locks that behaviour for the new op)

Append to `src/store/script-review-slice.test.ts`:

```ts
it('toggles a validate_instruct op via opKey like any other class (fs-58)', () => {
  const op = { id: 1, op: 'validate_instruct', newInstruct: 'x', rationale: 'r' };
  // seed suggestions, toggleClass off, assert opKey(chapterId,1,'validate_instruct') deselected
});
```

- [ ] **Step 2: Run it; verify it fails, then pass (slice is op-agnostic)**

Run: `npm test -- src/store/script-review-slice.test.ts`
Expected: PASS without slice changes (op-agnostic) — if it fails, the slice keyed on a hardcoded op list; fix by using `op.op`.

- [ ] **Step 3: Seed the fixture instruct + add the mock op + write the e2e**

**Round-1 CRITICAL:** the mock fixture (`src/mocks/canned-data.ts`, source of `initialSentences`) has **zero `instruct` fields**. `mockReviewScript` (`api.ts:~2985`) targets sentence id 1 / chapter 3. A `validate_instruct` **repair** against a sentence with no instruct is **dropped by T7's guard** → no diff row → the e2e silently no-ops. So:

(a) In `src/mocks/canned-data.ts`, add an `instruct` (e.g. `'shouting'`) to the sentence `mockReviewScript` targets (chapter 3, id 1) — OR inject it in the spec via `window.__store__` (as the existing spec injects `audioRenderedAt`). Without this the row never renders.

(b) In `src/lib/api.ts` `mockReviewScript`, add a `validate_instruct` op (`{ id: 1, op: 'validate_instruct', newInstruct: 'a calm tone', rationale: 'contradicts the line' }`) to the canned op array.

(c) Create `e2e/script-review-instruct.spec.ts` by **copying `e2e/script-review.spec.ts`** (the existing template — it `goto`s `/#/books/sb/manuscript`, clicks `getByTestId('review-script-chapter')`, waits the modal heading, clicks `getByTestId('apply-button')`, then asserts via `window.__store__`). Adapt it to assert the Instruct row + the applied instruct. **Disambiguate the heading match** — use the class-heading pattern (e.g. `getByRole('heading', { name: 'Instruct' })` or an exact `getByText('Instruct', { exact: true })`), NOT `getByText('Instruct')` which substring-matches "Live instruct":

```ts
import { test, expect } from '@playwright/test';

test('validate_instruct: review → accept → instruct updates', async ({ page }) => {
  await page.goto('/#/books/sb/manuscript'); // mock mode (copy setup from script-review.spec.ts)
  await page.getByTestId('review-script-chapter').click();
  await expect(page.getByText('Instruct', { exact: true })).toBeVisible();
  await page.getByTestId('apply-button').click();
  // assert via window.__store__ that sentence 1's instruct is now 'a calm tone' (mirror the sibling spec's store assertion)
});
```

- [ ] **Step 4: Run e2e + the full fast suite**

Run: `npm run test:e2e -- script-review-instruct` then `npm run verify:fast`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/mocks/canned-data.ts src/store/script-review-slice.test.ts e2e/script-review-instruct.spec.ts
git commit -m "test(frontend): validate_instruct mock op + fixture instruct + e2e + slice coverage (#1041)"
```

---

## Task 13: Full verify + spec status + follow-ups

**Files:**
- Modify: the spec frontmatter `status:`; file the follow-up issues

- [ ] **Step 1: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 2: Flip the spec status + ship notes**

In `docs/superpowers/specs/2026-06-25-fs58-validate-instruct-design.md`, set `status: active` → (on ship) `stable`, and at ship time create the `docs/features/` regression plan + `INDEX.md` row + `release-notes-next.md` entry (§10 follow-up 4). Update #1041 to the instruct+vocalization scope; edit the fs-58 Unit A + fs-57 specs to point at this delivered class (§10 follow-ups 1-2).

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs(docs): advance fs-58 validate_instruct spec + follow-ups (#1041)"
```

---

## Self-review (run after writing; fix inline)

**Spec coverage:** §3 op shape → T1/T7; §4.1 **four** `live` sites → **all in T7** (the planApply type + the Apply-time builder `script-review-diff.tsx:105` + the seed-time builder `manuscript.tsx:695` + the test fixtures) — folded together in round-1 to close the dead-feature window; §4.2 guards/dispatch/tri-state → T6/T7/T8; §5 prompt+language+serializer → T2/T3 (book language via `bookStateLanguage`; serializer lifted from `buildScriptReviewChapterInbox`); §6.1 vocalization-via-#1105 → free; §6.2 stamp(per-group post-fallback)+collector(`.catch`)+thread → T4/T5/T9; §6.3 carve-out keyed on dispatched (via T7 normalization) → T8 (+ the dropped-vocal-half test); §6.4 emotion gap → documented; §6.5 trim vector → T9; §7 UX (CLASS_LABELS + OpPreview prop surgery) → T11; **§9 degradation gate → T1 (parse-identity) + T2 (prompt-assembly snapshot)**; §9 mixed-engine fallback test → T4; §10 follow-ups + §5.2 overflow note → T13/T3.

**Round-1 fold (8 reviewers, 4 lenses):** corrected the T3 false premises (nested serializer, no named `call`), the T11 OpPreview `before:string` prop surgery, the T6/T10 non-existent helpers (`start`/caption-text), the T12 mock-fixture-has-no-instruct gap, the T7 collision-surfacing bug, the `.catch`/`state.chapters` GET fixes, the duplicate-import paste errors, and added the three missing §9 tests (degradation gate, mixed-engine fallback, dropped-vocal carve-out).

**Note (carve-out realization):** the spec §6.3 says "key on the dispatched result." This plan realizes that by **normalizing the op in `planApply` (T7)** — a dropped vocalization half is removed from the op there, so `dispatchAcceptedOps` (T8) keying on `op.newVocalizationText !== undefined` is exactly "what will dispatch." Equivalent to the spec's intent, simpler data flow.

**Type consistency:** `setSentenceText({…, vocalization?})` (T6) ↔ dispatch in T8; `ReviewOp.newInstruct/newVocalizationText/vocalization` (T7) ↔ schema fields (T1) ↔ prompt fields (T2); `renderedInstructByChapter` shape `Record<number, Record<number, string>>` consistent across T5/T9/T10; `isChapterInstructEditedSinceRender` signature consistent T9↔T10; `collectRenderedInstructHashesByChapter` T5↔(book-state) T5.

**Right-sized:** server review-pass (T1-3), server staleness (T4-5), reducer (T6), apply (T7-8), frontend staleness (T9-10), UX (T11), tests (T12), ship (T13) — each ends with an independently testable, reviewable deliverable.
