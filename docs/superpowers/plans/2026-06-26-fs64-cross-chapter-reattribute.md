# fs-64 — Cross-chapter context for `reattribute` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the prior chapter's final two-speaker exchange into the script-review prompt as read-only context — gated on a genuine alternating exchange — so the LLM can resolve a tagless chapter-opening line via cross-chapter turn-taking.

**Architecture:** Three new pure functions in `server/src/routes/script-review.ts` (a boundary-exchange extractor with the live-exchange gate, a neighbor-chapter selector, and a new optional param on the existing prompt builder), wired into the per-chapter review loop so only the *first* chunk of each chapter carries the block. Strictly additive: when the gate fails, the prompt is byte-identical to today. No schema, api-types, or frontend change.

**Tech Stack:** TypeScript (strict, ESM `.js` import specifiers), Node, Vitest (server suite, node env), `vi.mock` + `supertest` for the route test.

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-06-26-fs64-cross-chapter-reattribute-context-design.md`. Every task implements a part of it.
- **`NARRATOR_ID` is re-declared locally** in `script-review.ts` (`const NARRATOR_ID = 'narrator';`) — the constant is module-private in `byline-author-guard.ts` and re-declared in five modules; **do NOT** add an `export` there.
- **No `sentenceId` may appear in the rendered context block** — the block renders only `speakerName`, `speakerId`, and line text. This is the read-only guard (sentence ids are per-chapter `1..N` and collide, so the `ownsOp` filter is NOT a guard here).
- **Additive only:** no change to `openapi.yaml`, `api-types.ts`, Zod schemas, or any frontend file. The chapter is chunked at **full** `charBudget` (unchanged) — do not modify the budget.
- **Commits:** `feat(server): …` (or `test(server):` / `docs(skill):` where apt). Branch `feat/server-fs64-cross-chapter-reattribute`.
- **Constants:** `PRIOR_TURN_LOOKBACK = 6`, `MAX_PRIOR_TURN_CHARS = 240`.
- **Run server tests with:** `cd server && npm run test -- script-review` (Vitest single-run, node env).

---

### Task 0: Cut the branch

- [ ] **Step 1: Branch off latest main**

```bash
git switch main && git pull --ff-only && git switch -c feat/server-fs64-cross-chapter-reattribute
```

*(If you are continuing on the existing `docs/docs-fs64-cross-chapter-reattribute` spec branch, instead rebase it on `main` and keep working there — the spec commits travel with the implementation.)*

---

### Task 1: `priorChapterBoundaryExchange` helper + constants

The heart of the feature: a pure function that returns the prior chapter's final two-speaker exchange, or `null` when the chapter does not end in one.

**Files:**
- Modify: `server/src/routes/script-review.ts` (add constants + types + the helper, near `buildReviewSentencesInput` at line 60)
- Test: `server/src/routes/script-review.test.ts` (new `describe` block + a dynamic-import binding in `beforeAll`)

**Interfaces:**
- Produces:
  ```ts
  export const PRIOR_TURN_LOOKBACK = 6;
  export const MAX_PRIOR_TURN_CHARS = 240;
  export interface BoundaryTurn { speakerId: string; speakerName: string; text: string; }
  export interface PriorExchange { turns: BoundaryTurn[]; } // exactly 2, [A, B] in reading order
  export function priorChapterBoundaryExchange(
    sentences: Array<{ id: number; characterId: string; text: string; excludeFromSynthesis?: boolean }>,
    roster: Array<{ id: string; name: string }>,
  ): PriorExchange | null;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `server/src/routes/script-review.test.ts`. First extend the type-import line (near line 20) and add a module-level binding (near line 30):

```ts
import type {
  buildReviewSentencesInput as BuildReviewSentencesInput,
  priorChapterBoundaryExchange as PriorChapterBoundaryExchange,
} from './script-review.js';
```
```ts
let priorChapterBoundaryExchange: typeof PriorChapterBoundaryExchange;
```

In `beforeAll`, extend the destructuring (currently line 131-133) to bind it:

```ts
const [{ scriptReviewRouter, buildReviewSentencesInput: build, priorChapterBoundaryExchange: pcbe }, { makeBookId }] =
  await Promise.all([import('./script-review.js'), import('../workspace/paths.js')]);
buildReviewSentencesInput = build;
priorChapterBoundaryExchange = pcbe;
```

Then add the test block at the end of the file:

```ts
describe('priorChapterBoundaryExchange (fs-64)', () => {
  const roster = [
    { id: 'wren', name: 'Wren' },
    { id: 'marlow', name: 'Marlow' },
  ];
  const s = (id: number, characterId: string, text: string, excludeFromSynthesis?: boolean) =>
    ({ id, characterId, text, ...(excludeFromSynthesis ? { excludeFromSynthesis } : {}) });

  it('returns both turns when the chapter ends on an A/B exchange', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'narrator', 'It was late.'), s(2, 'wren', '"Where to?"'), s(3, 'marlow', '"Somewhere safe."')],
      roster,
    );
    expect(out).toEqual({
      turns: [
        { speakerId: 'wren', speakerName: 'Wren', text: '"Where to?"' },
        { speakerId: 'marlow', speakerName: 'Marlow', text: '"Somewhere safe."' },
      ],
    });
  });

  it('returns null when the chapter ends on narration (single speaker in window)', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'wren', '"Hello?"'), s(2, 'narrator', 'No answer came.'), s(3, 'narrator', 'The hall was empty.')],
      roster,
    );
    expect(out).toBeNull();
  });

  it('returns null on a single-speaker monologue ending', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'wren', 'One.'), s(2, 'wren', 'Two.'), s(3, 'wren', 'Three.')],
      roster,
    );
    expect(out).toBeNull();
  });

  it('returns null when two speakers both folded to one id (unknown-male)', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'unknown-male', '"Run!"'), s(2, 'unknown-male', '"This way!"')],
      roster,
    );
    expect(out).toBeNull();
  });

  it('returns null when the exchange is beyond the lookback window', () => {
    const out = priorChapterBoundaryExchange(
      [
        s(1, 'wren', '"Where to?"'), s(2, 'marlow', '"Safe."'),
        s(3, 'narrator', 'a'), s(4, 'narrator', 'b'), s(5, 'narrator', 'c'),
        s(6, 'narrator', 'd'), s(7, 'narrator', 'e'), s(8, 'narrator', 'f'),
      ],
      roster,
    );
    expect(out).toBeNull();
  });

  it('filters excludeFromSynthesis residue out of the turns', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'wren', '"Where to?"'), s(2, 'marlow', '"Safe."'), s(3, 'page-header', 'Chapter 4', true)],
      roster,
    );
    expect(out).toEqual({
      turns: [
        { speakerId: 'wren', speakerName: 'Wren', text: '"Where to?"' },
        { speakerId: 'marlow', speakerName: 'Marlow', text: '"Safe."' },
      ],
    });
  });

  it('truncates a long line to MAX_PRIOR_TURN_CHARS with an ellipsis', () => {
    const long = '"' + 'x'.repeat(400) + '"';
    const out = priorChapterBoundaryExchange([s(1, 'wren', 'short'), s(2, 'marlow', long)], roster);
    expect(out!.turns[1].text.length).toBeLessThanOrEqual(240);
    expect(out!.turns[1].text.endsWith('…')).toBe(true);
  });

  it('falls back to the id when a speaker is off-roster', () => {
    const out = priorChapterBoundaryExchange([s(1, 'wren', '"Hi."'), s(2, 'ghost', '"Boo."')], roster);
    expect(out!.turns[1]).toEqual({ speakerId: 'ghost', speakerName: 'ghost', text: '"Boo."' });
  });

  it('returns null for an empty chapter', () => {
    expect(priorChapterBoundaryExchange([], roster)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm run test -- script-review`
Expected: FAIL — `priorChapterBoundaryExchange is not a function` (binding is `undefined`).

- [ ] **Step 3: Implement the constants, types, and helper**

In `server/src/routes/script-review.ts`, after the `CastFile` interface (line 48) and before `buildReviewSentencesInput`, add:

```ts
/* fs-64 — cross-chapter context for the script-review pass. The prior chapter's
   final two-speaker exchange is fed (read-only) into a chapter's first chunk so
   the model can resolve a tagless chapter-opening line via turn-taking. */
const NARRATOR_ID = 'narrator'; // module-private convention (re-declared, never exported)
export const PRIOR_TURN_LOOKBACK = 6; // sentences (positions) scanned back from the chapter end
export const MAX_PRIOR_TURN_CHARS = 240; // hard cap per rendered line

export interface BoundaryTurn {
  speakerId: string;
  speakerName: string;
  text: string;
}
export interface PriorExchange {
  turns: BoundaryTurn[]; // exactly two, [A, B] in reading order
}

function capLine(text: string): string {
  return text.length > MAX_PRIOR_TURN_CHARS
    ? text.slice(0, MAX_PRIOR_TURN_CHARS - 1).trimEnd() + '…'
    : text;
}

/* The prior chapter's final two-speaker exchange, or null when it does not end
   in a live exchange. Narration and excludeFromSynthesis residue are filtered;
   the remaining eligible sentences in the last PRIOR_TURN_LOOKBACK positions are
   collapsed into contiguous same-speaker turns. Gate: >=2 turns (which, by the
   collapse, guarantees the last two are different speakers). Two distinct people
   folded to one id (e.g. unknown-male) collapse to one turn -> null. */
export function priorChapterBoundaryExchange(
  sentences: Array<{ id: number; characterId: string; text: string; excludeFromSynthesis?: boolean }>,
  roster: Array<{ id: string; name: string }>,
): PriorExchange | null {
  const eligible = sentences
    .slice(-PRIOR_TURN_LOOKBACK)
    .filter((s) => s.characterId !== NARRATOR_ID && s.excludeFromSynthesis !== true);

  const turns: Array<{ speakerId: string; lastText: string }> = [];
  for (const sentence of eligible) {
    const prev = turns[turns.length - 1];
    if (prev && prev.speakerId === sentence.characterId) {
      prev.lastText = sentence.text; // extend the run; keep its boundary-adjacent line
    } else {
      turns.push({ speakerId: sentence.characterId, lastText: sentence.text });
    }
  }
  if (turns.length < 2) return null;

  const nameOf = (id: string): string => roster.find((r) => r.id === id)?.name ?? id;
  const toTurn = (t: { speakerId: string; lastText: string }): BoundaryTurn => ({
    speakerId: t.speakerId,
    speakerName: nameOf(t.speakerId),
    text: capLine(t.lastText),
  });
  const [a, b] = turns.slice(-2);
  return { turns: [toTurn(a), toTurn(b)] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm run test -- script-review`
Expected: PASS (all 9 new `priorChapterBoundaryExchange` cases green; existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): fs-64 priorChapterBoundaryExchange helper with live-exchange gate"
```

---

### Task 2: `priorExchange` param on `buildScriptReviewChapterInbox`

Render the read-only context block above the sentences when an exchange is present; emit byte-identical output when absent.

**Files:**
- Modify: `server/src/routes/script-review.ts` (`buildScriptReviewChapterInbox`, line 78-108)
- Test: `server/src/routes/script-review.test.ts` (new `describe` block + binding)

**Interfaces:**
- Consumes: `PriorExchange` (Task 1).
- Produces: `buildScriptReviewChapterInbox(manuscriptId, chapterId, sentences, roster, priorExchange?: PriorExchange | null)` — 5th param defaults to `null`, so existing 4-arg callers are unaffected.

- [ ] **Step 1: Write the failing tests**

Extend the type-import and add a binding (mirror Task 1):

```ts
import type {
  buildReviewSentencesInput as BuildReviewSentencesInput,
  priorChapterBoundaryExchange as PriorChapterBoundaryExchange,
  buildScriptReviewChapterInbox as BuildScriptReviewChapterInbox,
} from './script-review.js';
```
```ts
let buildScriptReviewChapterInbox: typeof BuildScriptReviewChapterInbox;
```
In `beforeAll`, add `buildScriptReviewChapterInbox: bsrci` to the destructuring and `buildScriptReviewChapterInbox = bsrci;`.

Add the test block:

```ts
describe('buildScriptReviewChapterInbox (fs-64 priorExchange)', () => {
  const roster = [{ id: 'wren', name: 'Wren', role: 'protagonist' }];
  const sentences = [{ id: 1, characterId: 'narrator', text: 'Hi.' }] as unknown as Parameters<
    typeof buildScriptReviewChapterInbox
  >[2];

  it('is byte-identical to today when no priorExchange is given', () => {
    const expected = `---
manuscriptId: m1
task: script-review
chapterId: 2
---

## Cast roster (post-fold)

\`\`\`json
[
  {
    "id": "wren",
    "name": "Wren",
    "role": "protagonist"
  }
]
\`\`\`

## Sentences (already attributed)

\`\`\`json
[
  {
    "sentenceId": 1,
    "characterId": "narrator",
    "text": "Hi."
  }
]
\`\`\`
`;
    expect(buildScriptReviewChapterInbox('m1', 2, sentences, roster)).toBe(expected);
  });

  it('renders the labelled block above the sentences, with no sentenceId', () => {
    const out = buildScriptReviewChapterInbox('m1', 2, sentences, roster, {
      turns: [
        { speakerId: 'wren', speakerName: 'Wren', text: '"Where to?"' },
        { speakerId: 'marlow', speakerName: 'Marlow', text: '"Somewhere safe."' },
      ],
    });
    expect(out).toContain('Prior chapter');
    expect(out).toContain('do NOT emit an op');
    expect(out).toContain('Wren (id: wren): "Where to?"');
    expect(out).toContain('Marlow (id: marlow): "Somewhere safe."');
    expect(out).not.toContain('sentenceId": 1\n');
    // block sits before the sentence list
    expect(out.indexOf('Prior chapter')).toBeLessThan(out.indexOf('## Sentences'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm run test -- script-review`
Expected: FAIL — the 5th-arg call is a type/arity error or the block is absent.

- [ ] **Step 3: Implement the param + block**

In `buildScriptReviewChapterInbox`, add the parameter and the block. Change the signature (line 78-83) to add `priorExchange: PriorExchange | null = null,` after `roster`, then build the block and inject it immediately before `## Sentences`:

```ts
export function buildScriptReviewChapterInbox(
  manuscriptId: string,
  chapterId: number,
  sentences: SentenceOutput[],
  roster: CastCharacterSlim[],
  priorExchange: PriorExchange | null = null,
): string {
  const sentencePayload = buildReviewSentencesInput(sentences);
  const rosterPayload = roster.map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.role ? { role: c.role } : {}),
  }));
  const priorBlock = priorExchange
    ? '## Prior chapter — final exchange (reference only — not reviewable lines; do NOT emit an op on them)\n\n' +
      priorExchange.turns.map((t) => `${t.speakerName} (id: ${t.speakerId}): ${t.text}`).join('\n') +
      '\n\n'
    : '';
  return `---
manuscriptId: ${manuscriptId}
task: script-review
chapterId: ${chapterId}
---

## Cast roster (post-fold)

\`\`\`json
${JSON.stringify(rosterPayload, null, 2)}
\`\`\`

${priorBlock}## Sentences (already attributed)

\`\`\`json
${JSON.stringify(sentencePayload, null, 2)}
\`\`\`
`;
}
```

(When `priorBlock === ''`, `${priorBlock}## Sentences` reduces to the exact legacy text — the byte-identical test pins this.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm run test -- script-review`
Expected: PASS (both new cases + the existing route tests, which call the 4-arg form, stay green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): fs-64 render prior-chapter exchange block in script-review prompt"
```

---

### Task 3: `priorChapterIdFor` neighbor selector

Pick the immediately-preceding non-excluded story chapter (no cascade).

**Files:**
- Modify: `server/src/routes/script-review.ts` (add the pure helper near Task 1's code)
- Test: `server/src/routes/script-review.test.ts` (new `describe` block + binding)

**Interfaces:**
- Produces: `priorChapterIdFor(chapterId: number, allChapterIds: number[], excludedIds: Set<number>): number | null` — `allChapterIds` is the sorted-ascending key list of `byChapter`.

- [ ] **Step 1: Write the failing tests**

Add the type-import + binding (mirror Task 1), then:

```ts
describe('priorChapterIdFor (fs-64)', () => {
  it('returns the nearest lower chapter id', () => {
    expect(priorChapterIdFor(3, [1, 2, 3, 4], new Set())).toBe(2);
  });
  it('skips excluded chapters', () => {
    expect(priorChapterIdFor(3, [1, 2, 3], new Set([2]))).toBe(1);
  });
  it('returns null for the first chapter (no lower id)', () => {
    expect(priorChapterIdFor(1, [1, 2, 3], new Set())).toBeNull();
  });
  it('returns null when every lower chapter is excluded', () => {
    expect(priorChapterIdFor(3, [1, 2, 3], new Set([1, 2]))).toBeNull();
  });
  it('handles non-contiguous ids', () => {
    expect(priorChapterIdFor(10, [2, 5, 10, 11], new Set())).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm run test -- script-review`
Expected: FAIL — `priorChapterIdFor is not a function`.

- [ ] **Step 3: Implement the helper**

In `server/src/routes/script-review.ts`, add near the other fs-64 helpers:

```ts
/* The immediately-preceding non-excluded story chapter, or null. No cascade:
   selection skips only excluded chapters; whether that predecessor yields an
   exchange is a separate gate (priorChapterBoundaryExchange). */
export function priorChapterIdFor(
  chapterId: number,
  allChapterIds: number[],
  excludedIds: Set<number>,
): number | null {
  const lower = allChapterIds.filter((id) => id < chapterId && !excludedIds.has(id));
  return lower.length ? lower[lower.length - 1] : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm run test -- script-review`
Expected: PASS (5 new cases green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): fs-64 priorChapterIdFor neighbor selector (no cascade)"
```

---

### Task 4: Wire the helpers into the review route

Compute the prior exchange once per chapter and pass it to the first chunk only; lift the excluded-chapter set so it applies on single-chapter requests too.

**Files:**
- Modify: `server/src/routes/script-review.ts` (route handler, lines 128-142 and the chunk loop 233-291)
- Test: `server/src/routes/script-review.test.ts` (one new `it` in the existing route `describe`)

**Interfaces:**
- Consumes: `priorChapterIdFor`, `priorChapterBoundaryExchange` (Tasks 1, 3), `buildScriptReviewChapterInbox` 5th param (Task 2).

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('POST /api/books/:bookId/script-review', ...)`:

```ts
it('feeds the prior chapter exchange into the next chapter, first chunk only (fs-64)', async () => {
  writeBook([
    { id: 1, chapterId: 1, characterId: 'wren', text: '"Where to?"' },
    { id: 2, chapterId: 1, characterId: 'marlow', text: '"Somewhere safe."' },
    { id: 1, chapterId: 2, characterId: 'wren', text: '"I know this place."' },
  ], [
    { id: 1, title: 'One', excluded: false },
    { id: 2, title: 'Two', excluded: false },
  ]);
  const prompts: Record<number, string> = {};
  runReview.mockImplementation((_m: string, c: number, p: string) => {
    prompts[c] = p;
    return Promise.resolve({ ops: [] });
  });

  await request(app).post(`/api/books/${bookId}/script-review`).send({}).expect(200);

  expect(prompts[2]).toContain('Prior chapter');
  // The seeded cast.json has only `wren`, so `marlow` resolves to its id via the
  // off-roster fallback — assert the fallback form `marlow (id: marlow)`.
  expect(prompts[2]).toContain('marlow (id: marlow): "Somewhere safe."');
  expect(prompts[1] ?? '').not.toContain('Prior chapter'); // chapter 1 has no predecessor
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm run test -- script-review`
Expected: FAIL — `prompts[2]` does not contain `Prior chapter` (route not wired yet).

- [ ] **Step 3: Lift the excluded set + compute the prior exchange**

Replace the chapter-id setup block (currently lines 130-142):

```ts
    /* When chapterId is supplied in the body, limit the pass to that one chapter. */
    let chapterIds = [...byChapter.keys()].sort((a, b) => a - b);
    if (requestedChapterId !== undefined) {
      chapterIds = chapterIds.filter((id) => id === requestedChapterId);
    } else {
      /* Whole-book review skips chapters the user excluded from narration
         (front/back-matter). Mirrors the detect-emotions + generation filters.
         An explicit per-chapter request above is honoured even when excluded. */
      const excludedChapterIds = new Set<number>(
        located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
      );
      chapterIds = chapterIds.filter((id) => !excludedChapterIds.has(id));
    }
```

with (excluded set lifted so neighbor selection can use it regardless of request mode):

```ts
    const allChapterIds = [...byChapter.keys()].sort((a, b) => a - b);
    /* Chapters the user excluded from narration (front/back-matter). Mirrors the
       detect-emotions + generation filters, and gates fs-64 neighbour selection. */
    const excludedChapterIds = new Set<number>(
      located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
    );

    /* When chapterId is supplied in the body, limit the pass to that one chapter
       (honoured even when excluded). Otherwise skip the excluded chapters. */
    let chapterIds = allChapterIds;
    if (requestedChapterId !== undefined) {
      chapterIds = allChapterIds.filter((id) => id === requestedChapterId);
    } else {
      chapterIds = allChapterIds.filter((id) => !excludedChapterIds.has(id));
    }
```

- [ ] **Step 4: Compute `priorExchange` per chapter and pass it to the first chunk**

Inside the chapter loop, after `const chapterId = chapterIds[i];` and the `send({ kind: 'phase', ... })` call (around line 214-221), add:

```ts
        /* fs-64 — the prior chapter's final exchange (read-only) resolves a
           tagless chapter-opening line. Null unless the immediately-preceding
           non-excluded chapter ends in a live A/B exchange. */
        const priorId = priorChapterIdFor(chapterId, allChapterIds, excludedChapterIds);
        const priorExchange =
          priorId !== null ? priorChapterBoundaryExchange(byChapter.get(priorId) ?? [], roster) : null;
```

Then convert the inner chunk loop (currently `for (const chunk of chunks) {` at line 233) to an indexed loop and pass `priorExchange` to the first chunk only. Change the loop header and the `buildScriptReviewChapterInbox` call:

```ts
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (closed) break;
          const prompt = buildScriptReviewChapterInbox(
            manuscriptId,
            chapterId,
            chunkWithContext(chunk),
            roster,
            index === 0 ? priorExchange : null,
          );
```

(Leave the rest of the loop body — the `runScriptReviewChapter` call, the `owned` filter, the `catch` — unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm run test -- script-review`
Expected: PASS — `prompts[2]` contains the block; `prompts[1]` does not; all prior tests stay green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors). `byChapter.get(priorId)` is `SentenceOutput[]` and `roster` is `CastCharacterSlim[]` — both structurally satisfy the helper's param types.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): fs-64 wire prior-chapter exchange into the first chunk of each chapter"
```

---

### Task 5: Document the context block in the review skill prompt

Tell the model the block is read-only, carries no `sentenceId`, and must never be an op target.

**Files:**
- Modify: `skills/audiobook-script-review.md` (the `## Input` section, after item 2 at line 24; and one line in `## Rules` if a "never target" reinforcement fits the existing list)

- [ ] **Step 1: Add the input description**

In `skills/audiobook-script-review.md`, after item `2.` of `## Input` (line 24), add:

```markdown
3. OPTIONALLY, a `## Prior chapter — final exchange` block above the sentences.
   It names the previous chapter's last two speakers and their closing lines —
   read-only turn-taking context to help you attribute a tagless **opening**
   line of THIS chapter. It carries **no `sentenceId`** and is **not reviewable**:
   never emit an op targeting it; use only the named alternation to inform the
   attribution of this chapter's own opening sentences.
```

- [ ] **Step 2: Verify the skill file reads coherently**

Run: `git diff skills/audiobook-script-review.md`
Expected: only the additive paragraph; numbering and surrounding sections intact.

- [ ] **Step 3: Commit**

```bash
git add skills/audiobook-script-review.md
git commit -m "docs(skill): fs-64 document the read-only prior-chapter exchange block"
```

---

### Task 6: Full verify + ship docs

**Files:**
- Modify: `docs/BACKLOG.md` (remove the `fs-64` row, lines 70-74)
- (PR body carries `Closes #1120`.)

- [ ] **Step 1: Run the full pre-push battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. If a pre-existing/unrelated flake fires (e.g. a `voices` e2e under parallel load — a documented repo flake), re-run that spec in isolation and note it; do not fix unrelated breakage in this branch.

- [ ] **Step 2: Remove the BACKLOG row**

Delete the `fs-64` entry in `docs/BACKLOG.md` (the `#### `fs-64` — cross-chapter context …` heading through its `_Full detail + acceptance:_` line, lines 70-74).

Run: `grep -n "fs-64" docs/BACKLOG.md`
Expected: no matches.

- [ ] **Step 3: Commit the backlog removal**

```bash
git add docs/BACKLOG.md
git commit -m "docs(docs): drop fs-64 backlog row (shipped via #1120)"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/server-fs64-cross-chapter-reattribute
gh pr create --title "feat(server): fs-64 cross-chapter context for reattribute" \
  --body "$(cat <<'BODY'
## Summary
Feeds the prior chapter's final two-speaker exchange into the script-review prompt as read-only context, gated on a genuine alternating exchange, so the LLM can resolve a tagless chapter-opening line via cross-chapter turn-taking. Strictly additive — gate-fail ⇒ today's prompt byte-for-byte. Zero new LLM calls.

Spec: `docs/superpowers/specs/2026-06-26-fs64-cross-chapter-reattribute-context-design.md`

Closes #1120

## Test plan
- `npm run verify` — typecheck + all tests + e2e + build green.
- New unit tests: the live-exchange gate (`priorChapterBoundaryExchange`), the prompt block render + byte-identical-when-absent, the neighbour selector (`priorChapterIdFor`), and a route integration test (block on chapter 2's first chunk, absent on chapter 1).
- `status: stable` for the spec still owes the on-box render acceptance (§9.5) — NOT included here.
BODY
)"
```

---

## Self-Review

**1. Spec coverage** — every section maps to a task:
- §4.1 helper + gate + constants + cap → **Task 1**.
- §4.3 prompt block + byte-identical → **Task 2**.
- §4.2 neighbor selection (no cascade) → **Task 3**.
- §4.5 first-chunk-only wiring + lifted excluded set + full-budget chunking → **Task 4**.
- §4.4 skill note → **Task 5**.
- §4.6 read-only (no `sentenceId`) → enforced in Task 2's render + asserted in Tasks 2/4; documented in Task 5.
- §6 tests → Tasks 1-4 land them; **Task 6** runs the full battery.
- §9 ship (Closes #1120, BACKLOG row, on-box deferred to acceptance) → **Task 6**.
- §5 edge cases → all covered by Task 1's nine cases (narration, monologue, unknown-male, beyond-window, residue, off-roster, empty) + Task 3 (first chapter, excluded, non-contiguous) + Task 4 (first-chunk/no-predecessor).

**2. Placeholder scan** — no `TBD`/`TODO`/"handle edge cases"; every code step shows the full code; every test step shows real assertions.

**3. Type consistency** — `priorChapterBoundaryExchange` returns `PriorExchange | null` (Task 1) and is consumed as the 5th arg of `buildScriptReviewChapterInbox(... , priorExchange: PriorExchange | null = null)` (Task 2) and in the route (Task 4). `priorChapterIdFor(... ): number | null` (Task 3) feeds `byChapter.get(priorId)` (Task 4). `BoundaryTurn`/`PriorExchange` names are identical across tasks. The on-box acceptance (§9.5) is intentionally NOT a task — it gates `status: stable` after merge.
