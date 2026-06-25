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

```ts
import { scriptReviewSchema } from './schemas.js';

describe('scriptReviewSchema — validate_instruct (fs-58)', () => {
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

Append to `skills/audiobook-script-review.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL = readFileSync(
  fileURLToPath(new URL('./audiobook-script-review.md', import.meta.url)),
  'utf8',
);

describe('audiobook-script-review skill — validate_instruct (fs-58)', () => {
  it('documents the validate_instruct op and the English-instruct rule', () => {
    expect(SKILL).toMatch(/### `validate_instruct`/);
    expect(SKILL).toMatch(/always English/i);
    expect(SKILL).toMatch(/newInstruct/);
    expect(SKILL).toMatch(/newVocalizationText/);
  });

  it('documents the conditional instruct + vocalization input fields', () => {
    // The ## Input section must mention both new fields so the model knows their meaning.
    const input = SKILL.split('## Input')[1] ?? '';
    expect(input).toMatch(/"instruct"/);
    expect(input).toMatch(/"vocalization"/);
  });

  it('hands intentional vocalizations to validate_instruct in the strip_tag rule', () => {
    expect(SKILL).toMatch(/leave intentional vocalizations to `validate_instruct`/);
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

In `server/src/routes/script-review.ts`:

(a) Export the serializer (replace the inline mapping that builds the sentence array for the inbox):

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

Use it where the chapter's sentences are serialized into the inbox/user prompt.

(b) Add the language to the `call` object passed to `runScriptReviewChapter`. Import `bookStateLanguage`:

```ts
import { bookStateLanguage } from '../workspace/scan.js';
```

and in the call object (currently `{ signal, onChunk, onThrottle }`):

```ts
const call = {
  signal,
  onChunk,
  onThrottle,
  language: bookStateLanguage(located.state),
};
```

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

In `server/src/tts/synthesise-chapter.test.ts`, add a focused assertion on the returned `segments`. Mirror an existing synth test's setup (a group with an explicit `instruct`, `liveInstruct: true`, character routed to `qwen3-tts-1.7b`). Assert:

```ts
it('stamps instructHash for a 1.7b liveInstruct group with an explicit instruct', async () => {
  const res = await synthesiseChapter(/* …existing 1.7b + liveInstruct:true setup, one sentence with instruct:'a tired sigh' */);
  const seg = res.segments.find((s) => s.sentenceIds?.includes(1));
  expect(seg?.instructHash).toBe(textHashForStale('a tired sigh'));
});

it('omits instructHash when liveInstruct is off', async () => {
  const res = await synthesiseChapter(/* …same but liveInstruct:false */);
  expect(res.segments.find((s) => s.sentenceIds?.includes(1))?.instructHash).toBeUndefined();
});

it('omits instructHash for an emotion-only group (no explicit instruct)', async () => {
  const res = await synthesiseChapter(/* …1.7b liveInstruct:true, sentence with emotion but no instruct */);
  expect(res.segments.find((s) => s.sentenceIds?.includes(1))?.instructHash).toBeUndefined();
});
```

(Reuse the nearest existing `synthesiseChapter` test fixture in this file for the boilerplate args — copy its option object and adjust `liveInstruct`/`instruct`/model key.)

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

Then in `server/src/routes/book-state.ts`, beside the `renderedTextByChapter` collection (line ~451) and its inclusion in the response (line ~479):

```ts
import { collectRenderedInstructHashesByChapter } from '../audio/segments-io.js'; // add to existing import group

// near line 451, beside renderedTextByChapter:
const renderedInstructByChapter = await collectRenderedInstructHashesByChapter(
  bookDir,
  chaptersForCollect, // the same chapters arg renderedTextByChapter uses
);

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

Append to `src/store/manuscript-slice.test.ts`:

```ts
describe('setSentenceText — vocalization tri-state (fs-58)', () => {
  const base = () => makeManuscriptState([
    { chapterId: 1, id: 1, characterId: 'mira', text: 'Hhh… done.', vocalization: true },
  ]);

  it('leaves an existing vocalization:true intact when no param is passed (strip_tag path)', () => {
    const s = reducer(base(), manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'done.' }));
    expect(find(s, 1, 1).vocalization).toBe(true);
  });

  it('sets the flag when vocalization:true', () => {
    const s0 = makeManuscriptState([{ chapterId: 1, id: 1, characterId: 'mira', text: 'X' }]);
    const s = reducer(s0, manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'Ah! X', vocalization: true }));
    expect(find(s, 1, 1).vocalization).toBe(true);
  });

  it('deletes the flag when vocalization:false (absent, not === false)', () => {
    const s = reducer(base(), manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'done.', vocalization: false }));
    expect('vocalization' in find(s, 1, 1)).toBe(false);
  });
});
```

(Use the test's existing `makeManuscriptState`/`find` helpers; if absent, build a minimal state literal as other tests in this file do.)

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
- Test: `src/lib/script-review-apply.test.ts`

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
      // vocalization half
      if (norm.newVocalizationText !== undefined) {
        const collides = textTargets.has(op.id); // a strip_tag already claimed this id's text
        if (!s.vocalization || collides) {
          delete norm.newVocalizationText;
          delete norm.vocalization;
        } else {
          textTargets.add(op.id);
        }
      }
      const hasInstruct = norm.newInstruct !== undefined;
      const hasVocal = norm.newVocalizationText !== undefined;
      if (!hasInstruct && !hasVocal) {
        // Nothing appliable. A pure-strip-on-instruct-less is a silent no-op (not surfaced);
        // a rejected vocalization-only edit IS surfaced as un-appliable.
        if (op.newVocalizationText !== undefined && !byId.get(op.id)?.vocalization) {
          unappliable.push({ op, reason: 'sentence is not a vocalization' });
        }
        continue;
      }
      appliable.push(norm);
      continue;
    }

    appliable.push(op); // any other non-structural op unchanged
  }
```

(Keep the existing structural-op loop above it untouched; `REVIEW_EMOTIONS`, `STRUCTURAL`, `consumed`, `byId` already exist.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/script-review-apply.test.ts`
Expected: PASS (the new describe + all existing planApply tests stay green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/script-review-apply.ts src/lib/script-review-apply.test.ts
git commit -m "feat(frontend): planApply guards + partial-apply normalization for validate_instruct (#1041)"
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
});
```

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
  for (const s of currentSentences) current.set(s.id, s.instruct ?? '');
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

In `src/views/generation.test.tsx`, mirror the `renderWithTextMap` helper (line ~1452) with an instruct map and assert the stale indicator. Add:

```ts
it('marks a done chapter stale when its rendered instruct was edited (fs-58)', () => {
  // Render the Generate view with renderedInstructByChapter = { 1: { 1: hash('old') } }
  // and a live sentence 1 whose instruct is now 'new'.
  renderWithInstructMap({ 1: { 1: textHashForStale('old') } }, /* live instruct 'new' */);
  expect(screen.getByTestId('chapter-1-stale')).toBeInTheDocument(); // use the existing stale-indicator selector
});
```

(Copy `renderWithTextMap` to `renderWithInstructMap`, swapping `renderedTextByChapter` → `renderedInstructByChapter` and seeding the live `instruct`.)

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

(c) Memo (beside the `textEditedSinceRenderSet` memo at 672-688) — build `instructEditedSinceRenderSet`:

```ts
  const instructEditedSinceRenderSet = useMemo(() => {
    const set = new Set<number>();
    const byChapter = /* the same sentences-grouped-by-chapter map the text memo builds */;
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

## Task 11: Diff UX — widen both `live` builders, `CLASS_LABELS`, `OpPreview`

**Files:**
- Modify: `src/components/script-review-diff.tsx` (`CLASS_LABELS` ~19-25, `OpPreview` ~69, the Apply-time `live` builder ~105-110), `src/views/manuscript.tsx:695-700` (seed-time `live` builder)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: the widened `live` element (Task 7).
- Produces: a `validate_instruct` row renders a labelled before→after (current instruct/vocalization → proposed), and BOTH `live` builders carry `instruct`/`vocalization` so the guards see them.

- [ ] **Step 1: Write the failing test**

Append to `src/components/script-review-diff.test.tsx`:

```ts
it('renders a validate_instruct row with a class label and before→after instruct (fs-58)', () => {
  // Seed the slice with one validate_instruct suggestion (id 1, newInstruct 'a calm tone')
  // and a live sentence whose current instruct is 'shouting'.
  renderDiffModal(/* … */);
  expect(screen.getByText(/Validate instruct|Instruct/i)).toBeInTheDocument();
  expect(screen.getByText(/shouting/)).toBeInTheDocument();    // before
  expect(screen.getByText(/a calm tone/)).toBeInTheDocument(); // after
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/script-review-diff.test.tsx -t "validate_instruct row"`
Expected: FAIL — no label, `OpPreview` returns `null` for the unknown op.

- [ ] **Step 3: Implement labels, preview, and BOTH builders**

(a) `CLASS_LABELS` (script-review-diff.tsx ~19-25): add `validate_instruct: 'Instruct',`.

(b) `OpPreview` (~69): add a branch for `validate_instruct` that shows before→after using the widened live sentence. The component already receives the live sentence for `before`; pass its `instruct`/`vocalization` through and render:
- instruct edit: `before = live.instruct ?? '(none)'`, `after = op.newInstruct === '' ? '(stripped)' : op.newInstruct`.
- vocalization edit: `before = live.text`, `after = op.newVocalizationText`.

(c) Apply-time `live` builder (~105-110): add `instruct: s.instruct, vocalization: s.vocalization,` to each mapped sentence.

(d) Seed-time `live` builder in `src/views/manuscript.tsx:695-700`: add the same two fields — `instruct: s.instruct, vocalization: s.vocalization,` — to the `planApply` input there.

- [ ] **Step 4: Run test + a seed-time guard**

Add a test asserting a seeded `validate_instruct` op survives the seed-time `planApply` (so the widened seed builder reaches the op). Then:

Run: `npm test -- src/components/script-review-diff.test.tsx src/views/manuscript.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/views/manuscript.tsx src/components/script-review-diff.test.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): validate_instruct diff row + widen both live builders (#1041)"
```

---

## Task 12: Mock op + e2e + slice coverage

**Files:**
- Modify: `src/lib/api.ts` (mock `reviewScript` — add a canned `validate_instruct` op for the fixture book), `src/store/script-review-slice.test.ts`
- Create: `e2e/script-review-instruct.spec.ts`; add a case to `e2e/responsive/coverage.spec.ts` if a new surface

**Interfaces:**
- Consumes: the whole apply path (Tasks 6-11) + the mock.
- Produces: an e2e proving review → `validate_instruct` row → accept → manuscript updates.

- [ ] **Step 1: Write the failing slice test**

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

- [ ] **Step 3: Add the mock op + write the e2e**

(a) In `src/lib/api.ts` mock `reviewScript`, add a `validate_instruct` op to the canned response for the mock fixture book (a sentence that has an instruct), so the diff modal shows a row.

(b) Create `e2e/script-review-instruct.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('validate_instruct: review → accept → instruct updates', async ({ page }) => {
  await page.goto('/'); // mock mode
  // navigate to a ready book's manuscript, open Review Script,
  // find the "Instruct" group row, accept it, and assert the sentence's
  // instruct reflects the proposed value (or the row disappears / chapter reads stale).
  await expect(page.getByText('Instruct')).toBeVisible();
});
```

- [ ] **Step 4: Run e2e + the full fast suite**

Run: `npm run test:e2e -- script-review-instruct` then `npm run verify:fast`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/store/script-review-slice.test.ts e2e/script-review-instruct.spec.ts
git commit -m "test(frontend): validate_instruct mock op + e2e + slice coverage (#1041)"
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

**Spec coverage:** §3 op shape → T1/T7; §4.1 four `live` sites → T7 (type) + T11 (both builders); §4.2 guards/dispatch/tri-state → T6/T7/T8; §5 prompt+language+serializer → T2/T3; §6.1 vocalization-via-#1105 → free (no task; verified by T6's text edit riding #1105); §6.2 stamp+collector+thread → T4/T5/T9; §6.3 carve-out → T8; §6.4 emotion gap → documented (no task); §7 UX → T11; §9 tests → each task's TDD + T12; §10 follow-ups → T13.

**Note (carve-out realization):** the spec §6.3 says "key on the dispatched result." This plan realizes that by **normalizing the op in `planApply` (T7)** — a dropped vocalization half is removed from the op there, so `dispatchAcceptedOps` (T8) keying on `op.newVocalizationText !== undefined` is exactly "what will dispatch." Equivalent to the spec's intent, simpler data flow.

**Type consistency:** `setSentenceText({…, vocalization?})` (T6) ↔ dispatch in T8; `ReviewOp.newInstruct/newVocalizationText/vocalization` (T7) ↔ schema fields (T1) ↔ prompt fields (T2); `renderedInstructByChapter` shape `Record<number, Record<number, string>>` consistent across T5/T9/T10; `isChapterInstructEditedSinceRender` signature consistent T9↔T10; `collectRenderedInstructHashesByChapter` T5↔(book-state) T5.

**Right-sized:** server review-pass (T1-3), server staleness (T4-5), reducer (T6), apply (T7-8), frontend staleness (T9-10), UX (T11), tests (T12), ship (T13) — each ends with an independently testable, reviewable deliverable.
