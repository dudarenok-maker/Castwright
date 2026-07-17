# Manuscript Scene-Change Separator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a visual scene-change divider in the manuscript/script-review view wherever the source had a word-free scene break (`* * *`, `⁂`, `<hr>`), as a read-only editorial aid.

**Architecture:** A read-only server pass runs *after* stage-2 attribution finishes (at the single universal exit both attribution branches converge on) and sets an additive `sceneBreakBefore?: boolean` flag on the first sentence following each word-free separator line in the chapter body. Detection reuses the aligner's existing normalization + windowed-match primitives to locate each sentence's body offset. The frontend splits manuscript segments on that flag and draws a hairline + ✦ divider, suppressing the boundary handle at the seam. Nothing about chunking, model calls, coverage, or attribution changes — the worst-case failure is a cosmetically misplaced or dropped divider.

**Tech Stack:** TypeScript, Node/Express (server), Zod (`handoff/schemas.ts`), Vitest (server + frontend), Vite + React 18 + Redux Toolkit (frontend), Playwright (e2e), OpenAPI (`openapi.yaml` → generated `src/lib/api-types.ts`).

## Global Constraints

- **Design of record:** `docs/superpowers/specs/2026-07-17-manuscript-scene-separator-design.md` (v4, approved). This plan corrects two spec imprecisions discovered while reading the code — noted inline where they occur; the architecture is unchanged.
- **Read-only:** the pass mutates ONLY the new `sceneBreakBefore` flag. Sentence `text`, `characterId`, order, ids, and count are byte-identical to pre-change. No change to chunking, coverage, attribution, or synthesis.
- **Additive-optional field:** `sceneBreakBefore?: boolean` follows the existing additive pattern (`emotion`/`instruct`/`vocalization`/`excludeFromSynthesis`). The model NEVER emits it — it is set by post-processing *after* `.strict()` validation of model output, so strict validation is unaffected.
- **No hex literals in component code** — use existing CSS custom properties / Tailwind tokens. This repo is **Tailwind v4 CSS-first (no `tailwind.config.ts`)**: tokens are declared in `src/styles.css`'s `@theme` block (`--color-ink: var(--ink)` → `text-ink`/`bg-ink`; `--font-serif: Lora` → `font-serif`), and opacity modifiers (`text-ink/40`, `bg-ink/15`) work via v4 `color-mix`. `text-ink`/`bg-ink`/`font-serif` are already used across 8+ views — confirmed resolvable. Divider ornament is Lora serif.
- **OpenAPI is the type source of truth** — never hand-edit `src/lib/api-types.ts`; regenerate via `npm run openapi:types`.
- **Touch targets** unaffected (no new interactive control; the divider is non-interactive and the boundary handle is *removed* at the seam, not added).
- **Commit convention:** `<type>(<scope>): <subject>`; scopes used here: `server`, `frontend`, `docs`. Commit trailers required (see any recent commit).

---

## File Structure

**Server (detection + data model):**
- `server/src/analyzer/dialogue-structure/aligner.ts` — **modify.** Add exported `locateSentenceOffsets()` reusing the module-private `buildNormalizedMap`/`normalize`/`findMatch`. (These primitives already exist here; `alignSentences` uses them but discards the offset and requires `ParagraphEvidence[]`, so it is not directly reusable — see Task 3 note.)
- `server/src/analyzer/scene-breaks.ts` — **create.** The `annotateSceneBreaks(sentences, body)` pass. New focused file, one responsibility.
- `server/src/analyzer/scene-breaks.test.ts` — **create.** Unit tests for the pass.
- `server/src/handoff/schemas.ts` — **modify.** Add `sceneBreakBefore` to `sentenceSchema`.
- `server/src/parsers/html-utils.ts` — **modify.** Preserve `<hr>` as a separator line in `stripHtml`.
- `server/src/parsers/html-utils.test.ts` — **modify (or create if absent).** `<hr>` test.
- `server/src/routes/analysis.ts` — **modify.** One call to `annotateSceneBreaks` at the universal exit of `attributeChapterStage2` (before `return result`, :1788).
- `server/src/routes/analysis.structure-engine.test.ts` — **modify.** Integration assertion that the flag lands via `attributeChapterStage2` on both attribution branches.

**Contract:**
- `openapi.yaml` — **modify.** Add `sceneBreakBefore` to the `Sentence` schema.
- `src/lib/api-types.ts` — **regenerate** (never hand-edit).

**Frontend (rendering):**
- `src/views/manuscript.tsx` — **modify.** `Segment` type + `segments` useMemo split-on-flag; divider render in both branches; boundary-handle suppression in both branches.
- `src/views/manuscript.test.tsx` — **modify (or create if absent).** Divider/seam unit tests.
- `src/store/manuscript-slice.ts` — **modify.** `splitSentence` strips the flag from non-first pieces.
- `src/store/manuscript-slice.test.ts` — **modify (or create if absent).** Split-strip test.
- `e2e/responsive/` or an existing manuscript e2e spec — **modify.** Divider visible on a fixture with a scene break.
- `server/src/__fixtures__/the-coalfall-commission.md` (or its `.ru.md` variant) — **modify.** Add a `* * *` scene break for the e2e fixture.

**Docs:**
- `docs/features/<n>-manuscript-scene-separator.md` — **create** from `TEMPLATE.md` (regression plan).
- `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md` — **modify** (ship checklist).

---

## Task 0: Alignment measurement spike — GO/NO-GO gate (do this FIRST)

**Why first (round-4 adversarial review, most-dangerous assumption):** the entire feature bets that scene-*opening* sentences align back to their body offset reliably. The aggregate `alignedPct` is only ~65.6% and the scene-opener sub-rate is **unmeasured**. Measuring it is cheap and needs only the locator + separator logic — so it runs *before* the schema, wiring, and frontend build, not after. If the hit-rate is poor, a "no divider here" is ambiguous (real gap vs. alignment miss) and the aid is not shippable — **stop and surface to the user** rather than sinking Tasks 1–8.

This task also lands the locator (`locateSentenceOffsets`) permanently — it is needed regardless — so Task 3 below only formalizes its committed unit tests.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/aligner.ts` (add exported `locateSentenceOffsets` — full code in Task 3, Step 3)
- Create (throwaway, NOT committed): `scripts/scene-break-measure.mjs` — a measurement harness
- Test data: _Ночной дозор_ (Night Watch) and one real `<hr>`-bearing EPUB, analyzed locally

**Interfaces:**
- Produces: `locateSentenceOffsets` (see Task 3). Consumed by the measurement harness and Tasks 3/4.

- [ ] **Step 1: Land the locator**

Implement `locateSentenceOffsets` exactly as in **Task 3, Step 3** (aligner.ts), with its unit tests (Task 3, Step 1). Commit it:

```bash
git add server/src/analyzer/dialogue-structure/aligner.ts server/src/analyzer/dialogue-structure/aligner.test.ts
git commit -m "feat(server): add locateSentenceOffsets body-offset helper (#1679)"
```

(This is Task 3's commit, pulled forward. Task 3 becomes a no-op checkpoint confirming it landed.)

- [ ] **Step 2: Write the throwaway measurement harness**

Create `scripts/scene-break-measure.mjs`. For each test book: read the analyzed `manuscript-edits.json` (sentences) + the source chapter bodies, compute separator offsets (inline the `separatorOffsets` logic from Task 4, Step 3) and sentence offsets (`locateSentenceOffsets`), and for every true `* * *`/`<hr>` break report whether the divider would bind to the correct scene-opening sentence (the first real sentence of the next scene) vs. mid-scene vs. dropped. Print a hit / miss / drop tally per book. This file is deliberately NOT committed (it's a spike).

- [ ] **Step 3: Analyze the two books and run the harness**

Run `npm start`, analyze Night Watch and the EPUB through the UI, then `node scripts/scene-break-measure.mjs`. Record the per-book hit-rate.

- [ ] **Step 4: GO/NO-GO decision**

- **GO** (the vast majority of true breaks bind correctly): record the number for the regression doc (Task 8) and proceed to Task 1.
- **NO-GO** (dividers land mid-scene / drop often enough to mislead): **STOP. Surface the numbers to the user** and do not build Tasks 1–8 as-is. The spec makes this an explicit go/no-go gate, not a nice-to-have.

- [ ] **Step 5: Delete the throwaway harness**

```bash
rm scripts/scene-break-measure.mjs
```

---

## Task 1: Data model — `sceneBreakBefore` field (schema + OpenAPI + generated types)

Foundation: every later task references the type. Additive-optional boolean.

**Files:**
- Modify: `server/src/handoff/schemas.ts:135` (inside `sentenceSchema`, before the closing `})` at :136)
- Modify: `openapi.yaml` (the `Sentence` schema, after `excludeFromSynthesis` at ~:5347)
- Regenerate: `src/lib/api-types.ts` (via `npm run openapi:types` — do NOT hand-edit)
- Test: `server/src/handoff/schemas.test.ts` (**already exists** — append the new describe block; do not recreate)

**Interfaces:**
- Produces: `SentenceOutput` (`z.infer<typeof sentenceSchema>`) gains optional `sceneBreakBefore?: boolean`. Frontend `Sentence` (generated) gains the same optional field. Consumed by Tasks 4, 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Create/append `server/src/handoff/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sentenceSchema } from './schemas.js';

describe('sentenceSchema — sceneBreakBefore (scene separator)', () => {
  const base = { id: 1, chapterId: 1, characterId: 'narrator', text: 'A line.' };

  it('accepts sceneBreakBefore: true (additive-optional)', () => {
    const parsed = sentenceSchema.parse({ ...base, sceneBreakBefore: true });
    expect(parsed.sceneBreakBefore).toBe(true);
  });

  it('accepts a sentence WITHOUT the field (absent = undefined)', () => {
    const parsed = sentenceSchema.parse(base);
    expect(parsed.sceneBreakBefore).toBeUndefined();
  });

  it('rejects a non-boolean sceneBreakBefore', () => {
    expect(() => sentenceSchema.parse({ ...base, sceneBreakBefore: 'yes' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`
Expected: the first two tests FAIL — `.strict()` rejects the unknown `sceneBreakBefore` key ("Unrecognized key(s) in object: 'sceneBreakBefore'").

- [ ] **Step 3: Add the field to `sentenceSchema`**

In `server/src/handoff/schemas.ts`, immediately after line 135 (`excludeFromSynthesis: z.boolean().optional(),`) and before the closing `})` on :136:

```ts
    /* #1679 — read-only editorial display flag: true on the first sentence
       after a word-free scene break (`* * *`, `<hr>`) in the source. Set by
       the post-attribution annotateSceneBreaks pass, never by the model, so
       .strict() validation of model output is unaffected. Additive. */
    sceneBreakBefore: z.boolean().optional(),
```

- [ ] **Step 4: Add the field to the OpenAPI `Sentence` schema**

In `openapi.yaml`, inside `Sentence.properties` (after the `excludeFromSynthesis` block ending ~:5347):

```yaml
        sceneBreakBefore:
          type: boolean
          description: >-
            #1679 — read-only editorial flag: true on the first sentence after a
            word-free scene break (* * *, <hr>) in the source. Display-only;
            never spoken, never affects attribution.
```

- [ ] **Step 5: Regenerate the frontend types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` diff adds `sceneBreakBefore?: boolean` to the `Sentence` schema. Confirm with `git diff src/lib/api-types.ts` — only that one field changes.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run src/handoff/schemas.test.ts`
Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): add read-only sceneBreakBefore sentence field (#1679)"
```

---

## Task 2: Preserve `<hr>` as a separator line in `stripHtml`

Independent of the detection work. EPUB/MOBI's most common scene-break glyph is `<hr>`, which the generic tag-strip erases today. Convert it to a canonical word-free line the detector will recognize.

**Files:**
- Modify: `server/src/parsers/html-utils.ts:36-56` (`stripHtml`)
- Test: `server/src/parsers/html-utils.test.ts` (create if absent — list the dir first)

**Interfaces:**
- Produces: `stripHtml` output now contains a standalone `* * *` line wherever the HTML had `<hr>`. Consumed downstream by the detector (Task 4) via the chapter body.

- [ ] **Step 1: Write the failing test**

Create/append `server/src/parsers/html-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stripHtml } from './html-utils.js';

describe('stripHtml — scene-break preservation (#1679)', () => {
  it('converts <hr> to a standalone word-free separator line', () => {
    const body = stripHtml('<p>End of scene one.</p><hr/><p>Scene two begins.</p>');
    // A blank-line-delimited unit that is exactly the canonical separator.
    const units = body.split(/\n[ \t]*\n/).map((u) => u.trim());
    expect(units).toContain('* * *');
    expect(body).toContain('End of scene one.');
    expect(body).toContain('Scene two begins.');
  });

  it('preserves an existing <p>* * *</p> separator line', () => {
    const body = stripHtml('<p>Before.</p><p>* * *</p><p>After.</p>');
    const units = body.split(/\n[ \t]*\n/).map((u) => u.trim());
    expect(units).toContain('* * *');
  });

  it('handles <hr> with attributes and whitespace', () => {
    const body = stripHtml('<p>A.</p>\n<hr class="scene" />\n<p>B.</p>');
    const units = body.split(/\n[ \t]*\n/).map((u) => u.trim());
    expect(units).toContain('* * *');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/parsers/html-utils.test.ts`
Expected: the `<hr>` tests FAIL — `<hr>` is stripped to nothing today (the `<p>* * *</p>` test passes already).

- [ ] **Step 3: Add the `<hr>` conversion**

In `server/src/parsers/html-utils.ts`, in `stripHtml`, extend the initial block-break replacements (currently :37-39). Change:

```ts
  let s = tagHtmlEmphasis(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n');
```

to:

```ts
  let s = tagHtmlEmphasis(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    /* #1679 — <hr> is the most common EPUB/MOBI scene-break glyph; the generic
       <[^>]+> strip below would erase it. Emit the canonical word-free line
       with surrounding blank lines so the later \n{3,}->\n\n collapse leaves it
       a standalone paragraph unit rather than gluing it to adjacent prose. */
    .replace(/<\s*hr\s*[^>]*\/?>/gi, '\n\n* * *\n\n')
    .replace(/<\/p>/gi, '\n\n');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/parsers/html-utils.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add server/src/parsers/html-utils.ts server/src/parsers/html-utils.test.ts
git commit -m "feat(server): preserve <hr> scene breaks through stripHtml (#1679)"
```

---

## Task 3: Sentence body-offset locator (`locateSentenceOffsets`)

> **Landed in Task 0.** The locator is built and committed as part of the Task 0 gating spike (it is needed to measure). This section is retained as the canonical spec for its code + unit tests; if you ran Task 0, verify the commit exists and skip to Task 4.

**Spec correction (do not skip reading this).** The spec says "reuse `alignSentences` for per-sentence body offsets." That is not directly possible: `alignSentences` (aligner.ts:136) (a) requires `ParagraphEvidence[]`, which only exists inside the structure-engine branch of `attributeChapterStage2`, and (b) returns overlapping `spans`, discarding the raw offset. To populate dividers on EVERY chapter (all languages, structure-engine on or off), add a thin locator that reuses the same module-private normalization/match primitives (`buildNormalizedMap`, `normalize`, `findMatch`) but needs only the body. Same match behaviour, same ~65.6%-aggregate hit rate — see the acceptance gate in Task 8.

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/aligner.ts` (add exported function at end of file, after `alignSentences`)
- Test: `server/src/analyzer/dialogue-structure/aligner.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: module-private `buildNormalizedMap` (:43), `normalize` (:120), `findMatch` (:129) — already defined in this file.
- Produces: `export function locateSentenceOffsets(sentences: Array<{ text: string }>, body: string): Array<number | null>` — a parallel array of each sentence's raw body start offset, or `null` when the text couldn't be located. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `server/src/analyzer/dialogue-structure/aligner.test.ts` (create the file with the standard header if it does not exist):

```ts
import { describe, it, expect } from 'vitest';
import { locateSentenceOffsets } from './aligner.js';

describe('locateSentenceOffsets (#1679)', () => {
  it('returns each sentence start offset in body order', () => {
    const body = 'The door opened. A shadow fell across the floor.';
    const offsets = locateSentenceOffsets(
      [{ text: 'The door opened.' }, { text: 'A shadow fell across the floor.' }],
      body,
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(body.indexOf('A shadow'));
  });

  it('returns null for a sentence whose text is not in the body (paraphrase/drift)', () => {
    const body = 'The door opened.';
    const offsets = locateSentenceOffsets(
      [{ text: 'The door opened.' }, { text: 'Something else entirely.' }],
      body,
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeNull();
  });

  it('a mid-sequence miss does not desync later matches (cursor unmoved on miss)', () => {
    const body = 'Alpha here. Beta here. Gamma here.';
    const offsets = locateSentenceOffsets(
      [{ text: 'Alpha here.' }, { text: 'nope.' }, { text: 'Gamma here.' }],
      body,
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeNull();
    expect(offsets[2]).toBe(body.indexOf('Gamma'));
  });

  it('tolerates smart-quote / dash normalization drift', () => {
    const body = 'He said — quietly — nothing.'; // em dashes in body
    const offsets = locateSentenceOffsets([{ text: 'He said -- quietly -- nothing.' }], body);
    expect(offsets[0]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/aligner.test.ts`
Expected: FAIL — `locateSentenceOffsets` is not exported ("does not provide an export named 'locateSentenceOffsets'").

- [ ] **Step 3: Add the locator**

Append to `server/src/analyzer/dialogue-structure/aligner.ts` (after `alignSentences`, end of file):

```ts
/** #1679 — Locate each sentence's raw start offset in `body`, reusing the same
    normalization + windowed forward-match this module already uses for
    alignment. Returns an array parallel to `sentences`: the raw body offset of
    each sentence's first character, or null when its text couldn't be located
    (model paraphrase / tag drift). A miss NEVER advances the cursor, so one bad
    sentence can't desync the rest — identical semantics to alignSentences.

    Unlike alignSentences this needs only the body (no ParagraphEvidence), so it
    runs on every chapter regardless of whether the dialogue-structure engine is
    active. Pure: no I/O, no model calls. */
export function locateSentenceOffsets(
  sentences: Array<{ text: string }>,
  body: string,
): Array<number | null> {
  const { text: normBody, rawStart } = buildNormalizedMap(body);
  let cursor = 0;
  return sentences.map((s) => {
    const needle = normalize(s.text);
    const matchStart = needle.length > 0 ? findMatch(normBody, needle, cursor) : -1;
    if (matchStart === -1) return null;
    cursor = matchStart + needle.length;
    return rawStart[matchStart];
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/aligner.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/aligner.ts server/src/analyzer/dialogue-structure/aligner.test.ts
git commit -m "feat(server): add locateSentenceOffsets body-offset helper (#1679)"
```

---

## Task 4: Scene-break annotator (`annotateSceneBreaks`)

The core detection pass. Pure function over `(sentences, body)`; mutates only the flag.

**Files:**
- Create: `server/src/analyzer/scene-breaks.ts`
- Create: `server/src/analyzer/scene-breaks.test.ts`

**Interfaces:**
- Consumes: `locateSentenceOffsets` (Task 3, `./dialogue-structure/aligner.js`); `hasAttributableContent` (`./stage2-coverage.js:104`); `SentenceOutput` (`../handoff/schemas.js`, now with `sceneBreakBefore`).
- Produces: `export function annotateSceneBreaks(sentences: SentenceOutput[], body: string): void` — mutates `sentences[i].sceneBreakBefore = true` in place for each first-sentence-after-a-separator. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/scene-breaks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { annotateSceneBreaks } from './scene-breaks.js';
import type { SentenceOutput } from '../handoff/schemas.js';

function sents(...texts: string[]): SentenceOutput[] {
  return texts.map((text, i) => ({ id: i + 1, chapterId: 1, characterId: 'narrator', text }));
}

describe('annotateSceneBreaks (#1679)', () => {
  it('flags the first sentence after a mid-chapter * * * and nothing else', () => {
    const body = 'Scene one ends here.\n\n* * *\n\nScene two starts here.';
    const s = sents('Scene one ends here.', 'Scene two starts here.');
    annotateSceneBreaks(s, body);
    expect(s[0].sceneBreakBefore).toBeUndefined();
    expect(s[1].sceneBreakBefore).toBe(true);
  });

  it('collapses consecutive separators to a single flag on the next real sentence', () => {
    const body = 'One.\n\n* * *\n\n* * *\n\nTwo.';
    const s = sents('One.', 'Two.');
    annotateSceneBreaks(s, body);
    expect(s[1].sceneBreakBefore).toBe(true);
    // exactly one flag set
    expect(s.filter((x) => x.sceneBreakBefore).length).toBe(1);
  });

  it('does NOT treat a page-number-only unit as a separator', () => {
    const body = 'One.\n\n42\n\nTwo.';
    const s = sents('One.', '42', 'Two.');
    annotateSceneBreaks(s, body);
    expect(s.every((x) => !x.sceneBreakBefore)).toBe(true);
  });

  it('recognizes a dinkus and a dash rule as separators', () => {
    for (const glyph of ['⁂', '---', '―']) {
      const body = `One.\n\n${glyph}\n\nTwo.`;
      const s = sents('One.', 'Two.');
      annotateSceneBreaks(s, body);
      expect(s[1].sceneBreakBefore).toBe(true);
    }
  });

  it('a leading separator (before any prose) sets no flag and does not throw', () => {
    const body = '* * *\n\nOnly scene.';
    const s = sents('Only scene.');
    annotateSceneBreaks(s, body);
    expect(s[0].sceneBreakBefore).toBeUndefined();
  });

  it('a paraphrase mismatch drops the divider without error (no flag, no throw)', () => {
    const body = 'One.\n\n* * *\n\nTwo verbatim.';
    // model paraphrased the post-break sentence -> unaligned -> no flag
    const s = sents('One.', 'Two, but paraphrased differently.');
    expect(() => annotateSceneBreaks(s, body)).not.toThrow();
    expect(s.every((x) => !x.sceneBreakBefore)).toBe(true);
  });

  it('does not mutate text, characterId, id, or order', () => {
    const body = 'One.\n\n* * *\n\nTwo.';
    const s = sents('One.', 'Two.');
    const before = JSON.parse(JSON.stringify(s.map(({ sceneBreakBefore, ...rest }) => rest)));
    annotateSceneBreaks(s, body);
    const after = s.map(({ sceneBreakBefore, ...rest }) => rest);
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/scene-breaks.test.ts`
Expected: FAIL — module `./scene-breaks.js` does not exist.

- [ ] **Step 3: Write the annotator**

Create `server/src/analyzer/scene-breaks.ts`:

```ts
/* #1679 — Read-only scene-break annotation. After stage-2 attribution finishes,
   find the word-free separator lines (`* * *`, `⁂`, `<hr>`-derived `* * *`,
   dash rules) that survive in the chapter body but produced no sentence, and
   flag the first sentence that follows each one with `sceneBreakBefore = true`.

   Pure display aid: it mutates ONLY the flag. A model paraphrase that can't be
   located binds the divider to the next locatable sentence — so a miss
   misplaces or drops the divider, never corrupts a sentence. It changes nothing
   about chunking, coverage, attribution, or synthesis. */

import { locateSentenceOffsets } from './dialogue-structure/aligner.js';
import { hasAttributableContent } from './stage2-coverage.js';
import type { SentenceOutput } from '../handoff/schemas.js';

/** Blank-line-delimited paragraph units. A unit with visible text but zero
    attributable words (`* * *`, `⁂`, `---`, `―`) is a scene separator; a
    page-number unit (`42`) is NOT (digits are attributable words). */
function separatorOffsets(body: string): number[] {
  const offsets: number[] = [];
  const delimiter = /\n[ \t]*\n/g;
  let unitStart = 0;
  let m: RegExpExecArray | null;
  const consider = (from: number, to: number) => {
    const unit = body.slice(from, to);
    if (unit.trim().length > 0 && !hasAttributableContent(unit)) offsets.push(from);
  };
  while ((m = delimiter.exec(body)) !== null) {
    consider(unitStart, m.index);
    unitStart = m.index + m[0].length;
  }
  consider(unitStart, body.length);
  return offsets;
}

export function annotateSceneBreaks(sentences: SentenceOutput[], body: string): void {
  const separators = separatorOffsets(body);
  if (separators.length === 0 || sentences.length === 0) return;

  const offsets = locateSentenceOffsets(sentences, body);

  for (const sep of separators) {
    /* A leading separator (chapter-top, before any located prose) is DROPPED:
       only bind when at least one located sentence precedes the separator, so a
       `* * *` at offset 0 doesn't flag the very first sentence. */
    const hasPreceding = offsets.some((o) => o != null && o < sep);
    if (!hasPreceding) continue;
    for (let i = 0; i < sentences.length; i++) {
      const off = offsets[i];
      if (off != null && off > sep) {
        sentences[i].sceneBreakBefore = true;
        break; // first aligned sentence after the separator only
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/scene-breaks.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/scene-breaks.ts server/src/analyzer/scene-breaks.test.ts
git commit -m "feat(server): add annotateSceneBreaks read-only detection pass (#1679)"
```

---

**Shipped correction (post-merge, folded from the acceptance measurement — see
`docs/features/261-manuscript-scene-separator.md`).** Two corrections landed
on top of this task's code during implementation; the architecture (pure,
read-only, additive-flag-only) is unchanged:

(a) **Binding is marker-anchored, not drop-on-miss.** The task above binds a
separator to "the first sentence whose located offset is after the
separator" and drops the divider when the opener itself doesn't locate. Real
measurement on Russian restructure-heavy text showed the scene-*opening*
sentence frequently fails to locate even when its neighbors do (dash-prefixed
/ split dialogue the model re-emits differently) — so drop-on-miss silently
lost dividers exactly where they'd be most useful. The shipped
`annotateSceneBreaks` instead anchors on the separator's own literal, exact
body offset, finds the **last sentence that located strictly before it**,
and flags the next sentence in reading order regardless of whether that
sentence's own text locates (commit `e7b877c1`).

(b) **Premise correction — separators are emitted as their own sentences.**
This task's tests assumed a `* * *`/`⁂` line produces no sentence at all. A
shipped-behavior measurement disproved that: the analyzer emits the
separator glyph as its own word-free sentence. **Fix A** (this file, same
commit `e7b877c1`): the marker-anchored bind skips over any run of
separator-only (non-attributable) sentences immediately after the anchor
point, so the flag lands on the real opener, not the separator's own
placeholder sentence. **Fix B** is in Task 6 below (frontend).

---

## Task 5: Wire the annotator into `attributeChapterStage2`

**Spec correction (do not skip).** The spec's "insertion point after crossExamine + escalation (~:1735)" sits INSIDE the `if (conventions)` structure-engine branch. Chapters where the engine is off or the language is unsupported take the `else` branch (:1781-1787, `applyNarratorDefault`) and would get NO dividers. Both branches converge at `return result;` (:1788). Insert there — one call, universal across every language and engine state.

**Files:**
- Modify: `server/src/routes/analysis.ts:1788` (add one line before `return result;`, after the `if (conventions) {...} else {...}` block closes at :1787)
- Test: `server/src/routes/analysis.structure-engine.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `annotateSceneBreaks` (Task 4), `result.sentences` (final, post-attribution), `opts.chapter.body`.
- Produces: `result.sentences` now carries `sceneBreakBefore` flags. No signature change to `attributeChapterStage2`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/routes/analysis.structure-engine.test.ts`. This reuses the file's existing `attributeChapterStage2` / `fakeAnalyzer` / `StageCall` harness (see `baseOpts`, :64). It asserts the flag lands on BOTH attribution branches: `'ru'` (structure-engine ON → conventions branch) and `'xx'` (unsupported → `applyNarratorDefault` else branch).

```ts
describe('attributeChapterStage2 — scene-break annotation (#1679)', () => {
  const BODY = 'Первая сцена заканчивается тут.\n\n* * *\n\nВторая сцена начинается тут.';
  function sceneSents(): SentenceOutput[] {
    return [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Первая сцена заканчивается тут' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'Вторая сцена начинается тут' },
    ];
  }
  function sceneOpts(language: string) {
    return {
      analyzer: fakeAnalyzer(sceneSents()),
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: STAGE1,
      chapter: { id: 1, title: 'Chapter One', body: BODY },
      stageCall: { language } as StageCall,
    };
  }

  it('flags the post-separator sentence on the structure-engine (conventions) branch', async () => {
    const result = await attributeChapterStage2(sceneOpts('ru'));
    expect(result.sentences[0].sceneBreakBefore).toBeUndefined();
    expect(result.sentences[1].sceneBreakBefore).toBe(true);
  });

  it('flags the post-separator sentence on the applyNarratorDefault (else) branch too', async () => {
    const result = await attributeChapterStage2(sceneOpts('xx')); // unsupported language
    expect(result.sentences[0].sceneBreakBefore).toBeUndefined();
    expect(result.sentences[1].sceneBreakBefore).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/analysis.structure-engine.test.ts -t "scene-break annotation"`
Expected: FAIL — `sceneBreakBefore` is `undefined` on sentence 2 (annotator not wired yet).

- [ ] **Step 3: Wire the call at the universal exit**

In `server/src/routes/analysis.ts`, add the import near the other analyzer imports (with `alignSentences` at :149):

```ts
import { annotateSceneBreaks } from '../analyzer/scene-breaks.js';
```

Then, in `attributeChapterStage2`, replace the final `return result;` (:1788) with:

```ts
  /* #1679 — read-only scene-break display flags, computed once on the FINAL
     post-attribution sentences. Placed here (after BOTH the conventions and
     applyNarratorDefault branches converge) so dividers populate on every
     chapter regardless of language or structure-engine state. Mutates only the
     sceneBreakBefore flag. */
  annotateSceneBreaks(result.sentences, opts.chapter.body);
  return result;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/analysis.structure-engine.test.ts`
Expected: PASS (existing tests + the 2 new ones). The existing structure-engine assertions are unchanged (the annotator only adds an optional flag).

- [ ] **Step 4b: Prove the flag survives to the PERSISTED array (not just the function boundary)**

`attributeChapterStage2`'s `return result` is NOT the persisted array: sentences then pass through `dedupAndPrepare` (`analysis.ts:~727`), `stripThirdPartyFrontMatter`, `foldMinorCast` (`analyzer/fold-minor-cast.ts:~279`), `remapCjkHonorificIds`, and `reconcileSentenceCharacterIds` (`analysis.ts:~1103`) before landing in `manuscript-edits.json`/state.json (and being read back via `z.array(sentenceSchema.passthrough())`, `routes/book-state.ts:594`). Round-4 review verified all of these use object-**spread** when rewriting a sentence, so an additive field survives — but nothing tests it. Add a focused regression that runs a flagged sentence through the real spread-based transforms and asserts survival, so a future reconstruct-not-spread change is caught.

Add to `server/src/routes/analysis.structure-engine.test.ts` (import the transforms from their real modules — confirm each import path and signature by reading the function before writing the call; do NOT guess a signature):

```ts
import { reconcileSentenceCharacterIds } from './analysis.js'; // confirm it is exported; else use foldMinorCast from ../analyzer/fold-minor-cast.js
// #1679 — the scene-break flag must survive the post-attribution transform chain.
it('sceneBreakBefore survives the spread-based post-attribution transforms', () => {
  const flagged: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Scene one.' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: 'Scene two.', sceneBreakBefore: true },
  ];
  // Exercise the real reconcile pass (identity roster → no id changes, but it
  // rewrites every row via spread). Assert the additive flag is untouched.
  const out = reconcileSentenceCharacterIds(flagged, /* roster/args per the real signature */);
  expect(out.find((s) => s.id === 2)?.sceneBreakBefore).toBe(true);
  expect(out.find((s) => s.id === 1)?.sceneBreakBefore).toBeUndefined();
});
```

If `reconcileSentenceCharacterIds` is not exported / not cheaply callable in isolation, instead extend the fuller-path integration test in `server/src/routes/analysis.structure-fixture.test.ts` (which already drives closer to persisted output) with a fixture chapter containing a `* * *` break, and assert the flag is present on the persisted/returned sentence array there. Either way, the assertion must be on the array AFTER the transform chain, not on `attributeChapterStage2`'s immediate return.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.structure-engine.test.ts
git commit -m "feat(server): annotate scene breaks at the universal stage-2 exit (#1679)"
```

---

## Task 6: Frontend — split segments on the flag, draw the divider, suppress the seam handle

Renders the divider above any segment whose head sentence has `sceneBreakBefore`, in BOTH the flat and virtualized render branches, and removes the boundary handle at the seam. Keying the segment split on the flag makes "the flagged sentence is always its segment's head" hold by construction.

**Files:**
- Modify: `src/views/manuscript.tsx` — `Segment` interface (:83), `segments` useMemo (:267-282), virtualized branch (:1170-1213), flat branch (:1215-1242)
- Test: `src/views/manuscript.test.tsx` (append; create if absent — list dir first)

**Interfaces:**
- Consumes: `Sentence.sceneBreakBefore` (Task 1, via generated types → `IndexedSentence extends Sentence`).
- Produces: a `Segment.sceneBreakBefore?: boolean` field and a `<SceneDivider/>` rendered above flagged segments (segIdx > 0). No new store/API surface.

- [ ] **Step 1: Write the failing test**

Append to `src/views/manuscript.test.tsx` (use the file's existing render/store harness; if the file does not exist, model it on a sibling view test such as `src/views/cast.test.tsx`). The exact store-seeding helper name may differ — match whatever the existing manuscript tests use to seed `manuscript.sentences`.

```tsx
// #1679 — scene-break divider
it('renders a scene divider above the sentence flagged sceneBreakBefore', () => {
  renderManuscriptWith([
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Scene one ends.' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: 'Scene two begins.', sceneBreakBefore: true },
  ]);
  expect(screen.getByTestId('scene-divider')).toBeInTheDocument();
});

it('does not render a divider above segment 0 even if it carries the flag', () => {
  renderManuscriptWith([
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Leading.', sceneBreakBefore: true },
  ]);
  expect(screen.queryByTestId('scene-divider')).not.toBeInTheDocument();
});

it('starts a new segment at the flagged sentence even for same-speaker prose', () => {
  renderManuscriptWith([
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Same speaker one.' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: 'Same speaker two.', sceneBreakBefore: true },
  ]);
  // two segments (split by the flag), so one divider between them
  expect(screen.getAllByTestId('scene-divider')).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/manuscript.test.tsx -t "scene divider"`
Expected: FAIL — no `scene-divider` testid; same-speaker sentences currently coalesce into one segment.

- [ ] **Step 3: Add `sceneBreakBefore` to the `Segment` type**

In `src/views/manuscript.tsx`, extend the `Segment` interface (:83-87):

```ts
interface Segment {
  id: string;
  characterId: string;
  sentences: IndexedSentence[];
  /** #1679 — true when this segment opens on a source scene break. */
  sceneBreakBefore?: boolean;
}
```

- [ ] **Step 4: Split the `segments` useMemo on the flag**

In the `segments` useMemo (:267-282), change the coalesce/push logic so a flagged sentence always starts a new segment:

```ts
  const segments: Segment[] = useMemo(() => {
    const segs: Segment[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (currentChapterId != null && s.chapterId !== currentChapterId) continue;
      const last = segs[segs.length - 1];
      // #1679 — a sceneBreakBefore sentence ALWAYS opens a new segment, so the
      // flag is the segment head by construction (a later boundary-drag can't
      // push it off the head and vanish the divider).
      if (last && last.characterId === s.characterId && !s.sceneBreakBefore)
        last.sentences.push({ ...s, absIdx: i });
      else
        segs.push({
          id: `seg_${segs.length}`,
          characterId: s.characterId,
          sceneBreakBefore: s.sceneBreakBefore,
          sentences: [{ ...s, absIdx: i }],
        });
    }
    return segs;
  }, [sentences, currentChapterId]);
```

- [ ] **Step 5: Add the `SceneDivider` component**

Add near the other small presentational components in `src/views/manuscript.tsx` (e.g. beside `BoundaryHandle`). Hairline rules flank a centered Lora-serif ✦; tokens only, no hex:

```tsx
/* #1679 — read-only scene-change divider. Two faint --ink hairlines flanking a
   Lora-serif ornament; non-interactive, generous vertical spacing. */
function SceneDivider() {
  return (
    <div
      data-testid="scene-divider"
      aria-hidden="true"
      className="flex items-center gap-4 my-8 select-none text-ink/40"
    >
      <span className="h-px flex-1 bg-ink/15" />
      <span className="font-serif text-lg leading-none">&#10022;</span>
      <span className="h-px flex-1 bg-ink/15" />
    </div>
  );
}
```

- [ ] **Step 6: Render the divider + suppress the seam handle in the FLAT branch**

In the flat branch (:1215-1242), render the divider above the segment (guarded `segIdx > 0`) and omit the boundary handle when the NEXT segment opens a scene break:

```tsx
                segments.map((seg, segIdx) => (
                  <Fragment key={seg.id}>
                    {segIdx > 0 && seg.sceneBreakBefore && <SceneDivider />}
                    <SegmentRow
                      seg={seg}
                      characters={characters}
                      priorRoster={priorRoster}
                      onAddFromSeriesRoster={onAddFromSeriesRoster}
                      selected={selectedSeg === seg.id}
                      dimmed={!!filterChar && filterChar !== seg.characterId}
                      drag={drag}
                      onSelect={() => setSelectedSeg(seg.id)}
                      onShowDetails={() => {
                        setSelectedSeg(seg.id);
                        setInspectorOpen(true);
                      }}
                      onReassignSegment={(newCharId) => reassignSegment(seg, newCharId)}
                      onOpenProfile={onOpenProfile}
                      findChar={findChar}
                    />
                    {segIdx < segments.length - 1 && !segments[segIdx + 1]?.sceneBreakBefore && (
                      <BoundaryHandle
                        boundaryIdx={segIdx + 1}
                        drag={drag}
                        onPointerDown={onBoundaryPointerDown}
                      />
                    )}
                  </Fragment>
                ))
```

- [ ] **Step 7: Render the divider + suppress the seam handle in the VIRTUALIZED branch**

In the virtualized branch (:1170-1213), the divider lives inside the segment's virtual row (so `measureElement` captures its height — no `estimateSize` retune). Guard `virtualItem.index > 0`; suppress the trailing handle when the NEXT segment opens a break:

```tsx
                  {virtualItems.map((virtualItem) => {
                    const seg = segments[virtualItem.index];
                    const isLast = virtualItem.index === segments.length - 1;
                    const nextBreak = segments[virtualItem.index + 1]?.sceneBreakBefore;
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
                        }}
                      >
                        {virtualItem.index > 0 && seg.sceneBreakBefore && <SceneDivider />}
                        <SegmentRow
                          seg={seg}
                          characters={characters}
                          priorRoster={priorRoster}
                          onAddFromSeriesRoster={onAddFromSeriesRoster}
                          selected={selectedSeg === seg.id}
                          dimmed={!!filterChar && filterChar !== seg.characterId}
                          drag={drag}
                          onSelect={() => setSelectedSeg(seg.id)}
                          onShowDetails={() => {
                            setSelectedSeg(seg.id);
                            setInspectorOpen(true);
                          }}
                          onReassignSegment={(newCharId) => reassignSegment(seg, newCharId)}
                          onOpenProfile={onOpenProfile}
                          findChar={findChar}
                        />
                        {!isLast && !nextBreak && (
                          <BoundaryHandle
                            boundaryIdx={virtualItem.index + 1}
                            drag={drag}
                            onPointerDown={onBoundaryPointerDown}
                          />
                        )}
                      </div>
                    );
                  })}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/views/manuscript.test.tsx -t "scene divider"` then the full file `npx vitest run src/views/manuscript.test.tsx`
Expected: PASS — new tests green, existing manuscript tests unaffected.

- [ ] **Step 9: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): render scene-change divider in manuscript view (#1679)"
```

---

**Shipped correction — Fix B (post-merge, paired with Task 4's Fix A; see
`docs/features/261-manuscript-scene-separator.md`).** The same
separators-are-sentences premise correction that changed Task 4's binding
also required a frontend fix, landed in a follow-up commit
(`8abb9df0`): since the analyzer emits the `* * *`/`⁂`/`<hr>`-derived glyph
line as its own word-free sentence, and the divider already visually
represents that break, rendering the glyph line as an ordinary segment row
too would show a redundant text row right next to the divider. A new
`isSeparatorOnly(text)` predicate (true when a sentence's text has no
letters or digits) filters those rows out of the manuscript's segment list
in both the flat and virtualized branches. Display-only — the sentence
itself is untouched in the underlying data and still exists for
synthesis/attribution purposes; `absIdx` still uses the real array index so
drag/boundary edits on the surrounding rows are unaffected.

---

## Task 7: Frontend — `splitSentence` strips the flag from non-first pieces

`splitSentence` (manuscript-slice.ts:449-479) spreads `...original` into every piece; without a strip, a mid-scene split would duplicate the flag and paint a spurious divider. Mirror the existing `instruct`/`vocalization` null-out (:475).

**Files:**
- Modify: `src/store/manuscript-slice.ts:475`
- Test: `src/store/manuscript-slice.test.ts` (append; create if absent — list dir first)

**Interfaces:**
- Consumes: `Sentence.sceneBreakBefore`. Produces: split pieces where only the first retains the flag.

- [ ] **Step 1: Write the failing test**

Append to `src/store/manuscript-slice.test.ts` (model store-seeding on the file's existing `splitSentence` tests):

```ts
// #1679 — a split must not duplicate the scene-break flag onto later pieces
it('splitSentence keeps sceneBreakBefore on the first piece only', () => {
  const state = seedManuscript([
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'Alpha beta gamma.', sceneBreakBefore: true },
  ]);
  const next = manuscriptReducer(
    state,
    splitSentence({ chapterId: 1, sentenceId: 1, offsets: [5], characterIds: ['narrator', 'narrator'] }),
  );
  const pieces = next.sentences.filter((s) => s.chapterId === 1);
  expect(pieces[0].sceneBreakBefore).toBe(true);
  expect(pieces[1].sceneBreakBefore).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/manuscript-slice.test.ts -t "sceneBreakBefore on the first piece"`
Expected: FAIL — the second piece inherits `sceneBreakBefore: true` from the `...original` spread.

- [ ] **Step 3: Strip the flag on non-first pieces**

In `src/store/manuscript-slice.ts`, extend the existing null-out at :475. Change:

```ts
          ...(isFirst ? {} : { instruct: undefined, vocalization: undefined }),
```

to:

```ts
          /* #1679 — the scene-break flag describes the original sentence's
             opening; only the first piece may keep it, else a split paints a
             spurious mid-scene divider. */
          ...(isFirst ? {} : { instruct: undefined, vocalization: undefined, sceneBreakBefore: undefined }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/manuscript-slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/manuscript-slice.test.ts
git commit -m "fix(frontend): strip sceneBreakBefore from non-first split pieces (#1679)"
```

---

## Task 8: E2E, acceptance gate, regression doc, release notes

Ships the user-visible proof + the go/no-go alignment measurement + the required docs.

**Files:**
- Modify: `server/src/__fixtures__/the-coalfall-commission.md` (or `.ru.md`) — add a `* * *` scene break between two paragraphs of one chapter
- Modify: an existing manuscript e2e spec under `e2e/` (or add a case to `e2e/responsive/coverage.spec.ts` per the "adding a new view" note — here a new assertion on the existing manuscript surface)
- Create: `docs/features/<n>-manuscript-scene-separator.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:** none (leaf task).

- [ ] **Step 1: Add a scene break to the e2e fixture**

In the chosen chapter of `server/src/__fixtures__/the-coalfall-commission.md`, insert a standalone `* * *` line (blank line above and below) between two existing paragraphs. Keep it in ONE chapter so the assertion is deterministic.

- [ ] **Step 2: Write the failing e2e assertion**

In the manuscript e2e spec, after navigating to the manuscript view for the fixture book, assert the divider is visible:

```ts
// #1679 — scene divider renders for a fixture chapter with a * * * break
await expect(page.getByTestId('scene-divider').first()).toBeVisible();
```

- [ ] **Step 3: Run the e2e to verify it fails, then passes**

Run: `npx playwright test --project=chromium <spec-file>`
Expected: FAIL before the fixture flows through analysis with the flag; PASS once the mock manuscript payload carries `sceneBreakBefore` (if the e2e runs against mock mode, add the flag to the corresponding `src/mocks/manuscripts/` payload sentence in the same step so the mock and real paths agree).

- [ ] **Step 4: Confirm the acceptance-gate result (measured up front in Task 0)**

The go/no-go alignment measurement was run in **Task 0** *before* this build started. Here, simply confirm the shipped end-to-end behavior matches that measurement: analyze _Ночной дозор_ + the `<hr>` EPUB through the real pipeline and eyeball that dividers land where Task 0 predicted. Record the Task 0 number in the regression doc (Step 5). If Task 0 was GO, this is a confirmation; if anything regressed between the spike and the shipped path, surface it before merge.

- [ ] **Step 5: Write the regression plan doc**

Create `docs/features/<n>-manuscript-scene-separator.md` from `TEMPLATE.md`: `status: active`, the invariants (read-only, universal insertion point, cosmetic-only failure), the manual acceptance walkthrough, and the acceptance-gate result from Step 4. Tag issue #1679 `needs-plan`.

- [ ] **Step 6: Update INDEX + release notes**

- Add the plan to `docs/features/INDEX.md` under its area.
- Append a technical entry to `docs/release-notes-next.md` (`Refs #1679`).
- Add a brand-voice user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md`.

- [ ] **Step 7: Commit**

```bash
git add server/src/__fixtures__ e2e src/mocks docs/features RELEASE_NOTES.md
git commit -m "test(frontend): e2e + regression doc for scene separator (#1679)"
```

---

## Self-Review

**1. Spec coverage:**
- Detection — read-only post-attribution alignment → Tasks 3 (locator) + 4 (annotator) + 5 (wiring). ✓ (Spec's `alignSentences` reuse corrected to `locateSentenceOffsets`; insertion point corrected from ~:1735 to the universal :1788 exit — both corrections documented inline.)
- EPUB/MOBI `<hr>` preservation → Task 2. ✓
- Data model (schemas + OpenAPI + generated types + persistence round-trip) → Task 1. ✓ (Persistence needs no code — raw `readJson` round-trips the additive field, per spec §3.)
- Rendering: split-on-flag, divider, positional segment-0 guard, seam-handle suppression in BOTH branches, virtualization → Task 6. ✓
- `splitSentence` flag strip → Task 7. ✓
- Edge cases (consecutive/leading collapse, page-number guard, alignment miss) → Task 4 tests. ✓
- Population via re-analysis → automatic (flag set at analysis time; re-analysis merge spreads it, spec §6). Optional backfill script is explicitly out of v1 scope — no task, by design. ✓
- Testing: server alignment, `stripHtml`, frontend unit, e2e, acceptance gate → Tasks 2,4,5,6,7,8. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows full code; every test step shows the assertion. Two test-harness references ("model on the existing tests") name the concrete sibling to copy — acceptable because the harness pre-exists and the plan can't know its exact private helper names without over-specifying. Flagged for the implementer.

**3. Type consistency:** `locateSentenceOffsets(sentences, body): Array<number|null>` — same name/signature in Tasks 3, 4. `annotateSceneBreaks(sentences, body): void` — same in Tasks 4, 5. `sceneBreakBefore?: boolean` — identical across schema (T1), Segment (T6), split-strip (T7). `SceneDivider` / `data-testid="scene-divider"` — consistent across T6 render + T8 e2e. ✓

**Known residual risk (carried from the spec, surfaced to the user, NOT a plan defect):** the locator inherits the aligner's ~65.6% aggregate hit rate. **Task 0** is now the go/no-go gate — measured *before* the build, so a poor hit-rate stops the work before Tasks 1–8 are sunk cost, not after.

**Round-4 adversarial-review folds (independent Opus reviewer on this plan):**
- **Acceptance gate moved to a gating Task 0 spike** (was Task 8 Step 4) — the most-dangerous assumption is measured before building.
- **Leading-separator guard added** to `annotateSceneBreaks` (Task 4) — a chapter-top `* * *` would otherwise flag sentence 0 (offset > 0), contradicting the task's own test and the design's "leading separator dropped." Now: bind only when a located sentence precedes the separator.
- **Persisted-array survival test added** (Task 5 Step 4b) — the function-boundary test can't catch a downstream drop across `dedupAndPrepare`/`foldMinorCast`/`reconcileSentenceCharacterIds` (all verified spread-based) before `manuscript-edits.json`.
- **`book-state.ts` read path corrected** — `server/src/routes/book-state.ts:594` reads `manuscript-edits.json` via `z.array(sentenceSchema.passthrough())`; additive-optional + passthrough is safe (the spec's "file doesn't exist" and the reviewer's `store/` path were both wrong on the directory).
- **`schemas.test.ts` already exists** (append, not create); **`tailwind.config.ts` is stale** — repo is Tailwind v4 CSS-first, tokens confirmed resolvable.
- **Accepted-as-limitation (documented in spec, not fixed):** stage-2 cache cross-version-resume replay skips annotation (self-heals on re-analyze); seam handle-suppression is a visual affordance, not a hard cross-scene reassignment lock.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-17-manuscript-scene-separator.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — fresh implementer subagent per task + two-stage review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

(Per the process: the mandatory `assumption-checker` adversarial pass on THIS plan runs before you approve it — that is the next step, not execution.)
