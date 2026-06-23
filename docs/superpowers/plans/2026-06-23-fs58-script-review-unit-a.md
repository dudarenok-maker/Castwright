# fs-58 LLM Script Review (Unit A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator-triggered, per-chapter, read-only LLM pass that proposes annotation repairs (strip stray attribution tags, split/extract/merge sentence boundaries, correct a wrong emotion) and applies the accepted ones client-side by dispatching the existing manual-edit reducers.

**Architecture:** The server review pass mirrors fs-33's `runEmotionChapter` (a per-chapter analyzer call over already-attributed sentences) but **writes no manuscript state** — it streams suggestions over SSE. Accepted suggestions are applied in the browser by dispatching Redux reducers (`splitSentence`, `setSentenceEmotion`, plus three new: `setSentenceText`, `mergeSentences`). Apply inherits ID-allocation + debounced persistence. Audio staleness is signalled the way manual edits already do it: every accepted op emits a `boundary_move` change-log event, and the Generate-view stale gate is widened so a post-render `boundary_move` marks a rendered chapter stale even when a precise render-map exists.

**Tech Stack:** TypeScript, Vitest (frontend `npm test`, server `npm run test:server`), Redux Toolkit (Immer), Zod, Playwright (`npm run test:e2e`), Express SSE, Ollama/Gemini analyzers.

**Spec:** `docs/superpowers/specs/2026-06-23-fs58-llm-script-review-design.md` (Unit A = 5 classes incl `merge`). This plan supersedes the spec's §5.3 content-hash idea with the simpler `boundary_move` + OR-gate staleness (decided after plan review — `segments.json` does not persist rendered text/emotion, so a content hash has nothing to hash).

## Global Constraints

- **OpenAPI is the type source of truth.** The new endpoint path goes in `openapi.yaml` (transcribed, Task 8). Unit A persists **no new sentence type** → **no `npm run openapi:types` regen**.
- **No hex literals in component code** — use the CSS-custom-property / Tailwind tokens.
- **RTK reducers mutate via Immer drafts** — match the existing slice style.
- **Commit convention:** `<type>(<scope>): <subject>`; scopes: `frontend`, `server`, `docs`. **One scope per commit** where possible (the husky `verify:fast:scoped` pre-commit runs only the legs the staged diff touches). End every body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Mocks behind `api = USE_MOCKS ? mock : real`** — every new `api.*` method needs BOTH a real and a mock impl, registered in both objects.
- **TDD** — failing test first; verify it fails for the RIGHT reason before implementing.
- **Run before declaring done:** `npm run verify`.
- **Engine-agnostic = no TTS engine load** — uses the analyzer (Ollama/Gemini) only.
- **No regression plan under `docs/features/` is owed** — this superpowers spec + the paired tests below ARE the spec (per CLAUDE.md "say so" rule for localized work).

---

## Phase 0 — Governance (file with the plan; the #998/BACKLOG rewrite is the hard gate to leave `draft`)

### Task 0: Re-scope the tracking artifacts

**Files:** Modify `docs/BACKLOG.md` (the `fs-58` row); GitHub via `gh` (#998, new Unit B + `validate_instruct` issues, edits to #996 + #721).

- [ ] **Step 1:** Rewrite the `fs-58` BACKLOG row to the Unit A scope (strip_tag/split/extract_dialogue/merge + fix_emotion; read-only per-chapter pass; client-side apply; "engine-agnostic — no TTS engine"). Link spec + plan.
- [ ] **Step 2:** Rewrite issue #998 to match (`gh issue edit 998 --body-file -`), noting `validate_instruct`→fs-56, `reattribute`/`flag_nonstory`→Unit B, placement now standalone-anytime, "no TTS engine" (not "no GPU").
- [ ] **Step 3:** File the Unit B issue (`reattribute` + `flag_nonstory`) with its deps (spec §13) + a thin BACKLOG row.
- [ ] **Step 4:** File the `validate_instruct` issue (blocked on fs-56) and **edit #996 (fs-56)** with the move-here note.
- [ ] **Step 5:** Edit #721 (fs-44): "script-review apply is client-side (Redux dispatch); a headless/MCP apply path needs a server-side equivalent."
- [ ] **Step 6:** Commit `docs/BACKLOG.md`: `docs(docs): re-scope fs-58 row to Unit A`.

---

## Phase 1 — Apply foundations (client-side; highest-risk, test-first)

### Task 1: `setSentenceText` reducer (`strip_tag` apply target)

**Files:** Modify `src/store/manuscript-slice.ts` (add reducer near `setSentenceCharacter`); Test `src/store/manuscript-slice.test.ts`.

**Interfaces:** Produces `manuscriptActions.setSentenceText({ chapterId: number; sentenceId: number; text: string })` — mutates the matching sentence's `text`; no-op if not found.

- [ ] **Step 1: Write the failing test** — build the start state as a literal with `manuscriptId` set (so we don't depend on `hydrateFromAnalysis`, which never sets `manuscriptId`):

```typescript
// src/store/manuscript-slice.test.ts
import { describe, it, expect } from 'vitest';
import reducer, { manuscriptActions } from './manuscript-slice';

const seeded = (sentences: Array<{ id: number; chapterId: number; characterId: string; text: string; emotion?: string }>) =>
  reducer(undefined, manuscriptActions.reset()); // reset → initialState; then patch via a known reducer below

// Helper: a real starting state with manuscriptId set + sentences present.
function start(sentences: Parameters<typeof seeded>[0]) {
  // hydrateFromBookState is the reducer that sets manuscriptId from disk; use it to seed.
  return reducer(
    { ...reducer(undefined, manuscriptActions.reset()), manuscriptId: 'm1', bookId: 'b1', sentences } as never,
    { type: '@@noop' } as never,
  );
}

describe('setSentenceText', () => {
  it('replaces the matching sentence text, leaves others untouched', () => {
    const s = start([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'He ran. "Stop," she said.' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'Quiet.' },
    ]);
    const next = reducer(s, manuscriptActions.setSentenceText({ chapterId: 1, sentenceId: 1, text: 'He ran. "Stop,"' }));
    expect(next.sentences.find((x) => x.id === 1)?.text).toBe('He ran. "Stop,"');
    expect(next.sentences.find((x) => x.id === 2)?.text).toBe('Quiet.');
  });
});
```

- [ ] **Step 2: Run → fail.** `npm test -- src/store/manuscript-slice.test.ts -t setSentenceText` → `setSentenceText is not a function`.
- [ ] **Step 3: Add the reducer** (after `setSentenceCharacter`):

```typescript
setSentenceText: (s, a: PayloadAction<{ chapterId: number; sentenceId: number; text: string }>) => {
  const sent = s.sentences.find((x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId);
  if (sent) sent.text = a.payload.text;
},
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(frontend): add setSentenceText reducer for script-review strip_tag`.

### Task 2: `mergeSentences` reducer + in-memory tombstone + re-analysis guard

**Files:** Modify `src/store/manuscript-slice.ts` (`mergedAwayKeys: string[]` on `ManuscriptState` + init in `initialState`/`reset`/`applyReupload`; the reducer; the guard in `hydrateFromAnalysis`'s append loop); Test `src/store/manuscript-slice.test.ts`.

**Interfaces:** Produces `manuscriptActions.mergeSentences({ chapterId: number; sentenceIds: number[] })` — concatenates (document order) into the lowest id, drops the rest, records dropped `${chapterId}:${id}` in `mergedAwayKeys`. State gains `mergedAwayKeys: string[]`.

- [ ] **Step 1: Write the failing tests** (note the start-state helper sets `manuscriptId`, so the re-analysis hydrate reaches the merge/append branch — this is the fix for the broken scaffold the review caught):

```typescript
import { start } from './manuscript-slice.test-helpers'; // extract the start() helper from Task 1 into a shared file

describe('mergeSentences', () => {
  it('merges into the lowest id, concatenates in order, drops the rest, tombstones', () => {
    const s = start([
      { id: 5, chapterId: 3, characterId: 'narrator', text: 'The hall was dark.' },
      { id: 6, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
    ]);
    const next = reducer(s, manuscriptActions.mergeSentences({ chapterId: 3, sentenceIds: [5, 6] }));
    const ch3 = next.sentences.filter((x) => x.chapterId === 3);
    expect(ch3.map((x) => x.id)).toEqual([5]);
    expect(ch3[0].text).toBe('The hall was dark. Dust hung in the air.');
    expect(next.mergedAwayKeys).toContain('3:6');
  });

  it('does NOT resurrect the merged-away id on a subsequent re-analysis', () => {
    const merged = reducer(
      start([
        { id: 5, chapterId: 3, characterId: 'narrator', text: 'The hall was dark.' },
        { id: 6, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
      ]),
      manuscriptActions.mergeSentences({ chapterId: 3, sentenceIds: [5, 6] }),
    );
    // manuscriptId is set (via start()), so hydrateFromAnalysis takes the merge/append branch:
    const reanalysed = reducer(merged, manuscriptActions.hydrateFromAnalysis({
      bookId: 'b1',
      sentences: [
        { id: 5, chapterId: 3, characterId: 'narrator', text: 'The hall was dark.' },
        { id: 6, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
      ],
    } as never));
    const ch3 = reanalysed.sentences.filter((x) => x.chapterId === 3);
    expect(ch3.map((x) => x.id)).toEqual([5]); // 6 stays dead
    expect(ch3[0].text).toBe('The hall was dark. Dust hung in the air.');
  });

  it('rejects a merge naming a missing id, and a single-id merge', () => {
    const s = start([{ id: 5, chapterId: 3, characterId: 'narrator', text: 'A.' }]);
    expect(reducer(s, manuscriptActions.mergeSentences({ chapterId: 3, sentenceIds: [5, 9] })).sentences).toHaveLength(1);
    expect(reducer(s, manuscriptActions.mergeSentences({ chapterId: 3, sentenceIds: [5] })).sentences).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run → fail.** (`mergeSentences is not a function`.)
- [ ] **Step 3: Add `mergedAwayKeys` to state + init.** Add `mergedAwayKeys: string[];` to `ManuscriptState`; `mergedAwayKeys: []` in `initialState`; `s.mergedAwayKeys = []` in `reset` and `applyReupload`.
- [ ] **Step 4: Add the reducer:**

```typescript
mergeSentences: (s, a: PayloadAction<{ chapterId: number; sentenceIds: number[] }>) => {
  const ids = [...a.payload.sentenceIds].sort((x, y) => x - y);
  if (ids.length < 2) return;
  const members = ids.map((id) => s.sentences.find((x) => x.chapterId === a.payload.chapterId && x.id === id));
  if (members.some((m) => !m)) return;
  const live = members as NonNullable<(typeof members)[number]>[];
  live[0].text = live.map((m) => m.text).join(' ');
  for (const m of live.slice(1)) {
    const i = s.sentences.findIndex((x) => x.chapterId === a.payload.chapterId && x.id === m.id);
    if (i >= 0) s.sentences.splice(i, 1);
    s.mergedAwayKeys.push(`${a.payload.chapterId}:${m.id}`);
  }
},
```

- [ ] **Step 5: Guard the resurrection branch in `hydrateFromAnalysis`** (the final append loop ~line 149-151):

```typescript
const tomb = new Set(s.mergedAwayKeys);
for (const inc of incoming) {
  if (!stateKeys.has(key(inc)) && !tomb.has(key(inc))) merged.push(inc);
}
```

- [ ] **Step 6: Run → pass** (all three cases).
- [ ] **Step 7: Commit** `feat(frontend): add mergeSentences reducer + in-memory merge tombstone`.

### Task 2b: Persist the merge tombstone across reload

A merge is a *committed* manuscript edit, but the tombstone is in-memory — after a reload (`hydrateFromBookState`) a re-analysis could resurrect the merged id. Persist `mergedAwayKeys` in book state and rehydrate it; also clear it on cross-book load (fixes the cross-book leak the review flagged).

**Files:** Modify `src/store/manuscript-slice.ts` (`hydrateFromBookState` sets `s.mergedAwayKeys = a.payload.mergedAwayKeys ?? []`); `src/store/persistence-middleware.ts` (include `mergedAwayKeys` in the manuscript PUT payload); `server/src/routes/book-state.ts` (persist + return `mergedAwayKeys` on the book-state GET; accept it on the PUT `manuscript` case); Test `src/store/manuscript-slice.test.ts` + a server book-state test.

**Interfaces:** Consumes/produces: book-state GET response gains `mergedAwayKeys?: string[]`; `hydrateFromBookState` payload gains `mergedAwayKeys?: string[]`.

- [ ] **Step 1: Write the failing test** — `hydrateFromBookState` with `mergedAwayKeys: ['3:6']` sets state; the same payload for a *different* book clears a prior book's keys.

```typescript
it('rehydrates and book-scopes the merge tombstone', () => {
  const a = reducer(undefined, manuscriptActions.hydrateFromBookState({ bookId: 'A', chapters: [], completedSlugs: [], characters: [], mergedAwayKeys: ['3:6'] } as never));
  expect(a.mergedAwayKeys).toEqual(['3:6']);
  const b = reducer(a, manuscriptActions.hydrateFromBookState({ bookId: 'B', chapters: [], completedSlugs: [], characters: [] } as never));
  expect(b.mergedAwayKeys).toEqual([]); // B's load doesn't inherit A's tombstone
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Frontend** — add `mergedAwayKeys?: string[]` to the `hydrateFromBookState` payload type and set `s.mergedAwayKeys = a.payload.mergedAwayKeys ?? []`. In `persistence-middleware.ts`, include `mergedAwayKeys` in the manuscript slice's PUT body.
- [ ] **Step 4: Server** — in `book-state.ts`: persist `mergedAwayKeys` (store alongside the manuscript edits, e.g. a `merged-away.json` sibling or a field in state.json) on the PUT `manuscript` case; include it in the GET response. Add a server test asserting round-trip.
- [ ] **Step 5: Run → pass** (frontend `npm test`, server `npm run test:server`).
- [ ] **Step 6: Commit** `feat(frontend,server): persist the script-review merge tombstone across reload` *(mixed scope is unavoidable here — it's one feature spanning the PUT/GET contract).*

### Task 3: Staleness — emit `boundary_move` for all ops + widen the stale gate

The precise render-map diff (`isChapterReassignedSinceRender`) compares `characterId` only, so it misses `strip_tag` (text), the retained `split`/`extract` piece, and `fix_emotion`. Fix the simple way: every accepted op emits a `boundary_move` (done in Tasks 5/11), and the Generate-view gate marks a rendered chapter stale if EITHER the precise diff OR the time-based `boundary_move` heuristic fires.

**Files:** Modify `src/views/generation.tsx` (the `stale={…}` gate ~line 1108-1115); Test `src/views/generation.test.tsx` (or the nearest existing staleness test) + triage existing #650 staleness tests.

**Interfaces:** No new exports. Behavior change: `stale = precise || timeBased` (was `renderMap ? precise : timeBased`).

- [ ] **Step 1: Write the failing test** — a rendered chapter (has a render map) whose only post-render change is a `boundary_move` event (no characterId change) reads **stale**.

```typescript
// assert via the gate's logic: with a render map present AND a post-render boundary_move,
// the chapter is stale even though isChapterReassignedSinceRender returns false.
```

(Render the Generate view with a `done` chapter that has `renderedSpeakersByChapter[id]` matching current characterIds, plus a `boundary_move` change-log event dated after `audioRenderedAt`; assert the stale badge shows.)

- [ ] **Step 2: Run → fail** (current gate ignores the time-based path when a render map exists).
- [ ] **Step 3: Widen the gate:**

```typescript
stale={
  // Stale if the precise render-map diff flags a speaker change OR a post-render
  // boundary_move was logged (covers text/emotion edits the characterId-only
  // precise diff can't see — script-review strip_tag/fix_emotion + the retained
  // split/extract piece).
  (renderedSpeakersByChapter[ch.id] ? reassignedSinceRenderSet.has(ch.id) : false) ||
  isChapterStaleFromReassign(ch, activityEvents)
}
```

- [ ] **Step 4: Triage existing staleness tests** — any #650 test asserting "move-then-undo reads NOT stale" will now read stale (the OR path catches the boundary_move). Update those tests to reflect the conservative behavior, and add a comment that the OR-gate intentionally trades a rare move-then-undo false positive for catching text/emotion edits. If a test is genuinely about a different invariant, leave it.
- [ ] **Step 5: Run → pass** (`npm test -- src/views/generation.test.tsx`).
- [ ] **Step 6: Commit** `feat(frontend): widen Generate stale gate to OR the boundary_move heuristic`.

### Task 4: Client anchor resolver + op validation/ordering (TOCTOU + two-anchor extract)

**Files:** Create `src/lib/script-review-apply.ts`; Test `src/lib/script-review-apply.test.ts`.

**Interfaces:**
- `ReviewOp` (frontend type, mirrors the server Zod): `{ id; op: 'strip_tag'|'split'|'extract_dialogue'|'merge'|'fix_emotion'; newText?; anchor?; anchorEnd?; pieceCharacterIds?; mergeIds?; emotion?; rationale; confidence? }`. `anchorEnd` is for `extract_dialogue` (mid-run = two boundaries → 3 pieces).
- `normalizeForMatch(text): string` — NFC + curly→straight quotes + em/en-dash→`-` + `…`→`...`. **No whitespace collapse** (it isn't position-preserving — the review caught this).
- `resolveAnchorOffset(text, anchor): number | null` — builds an original→normalized index map in ONE pass, finds a unique normalized match, returns the **original** offset of the anchor's end (or null if absent / non-unique).
- `planApply(ops, live): { appliable; unappliable }` — §5.6 ordering/validation (structural first; reject consumed-id field edits, 2nd structural op on one id, non-resolving anchors, merge members not adjacent/same-char/same-chapter, `fix_emotion` to a non-`EMOTIONS` value).

- [ ] **Step 1: Write the failing tests** (incl. the EXACT-offset assertion the review demanded + two-anchor extract + planApply TOCTOU + merge rejections + invalid-enum):

```typescript
import { resolveAnchorOffset, planApply } from './script-review-apply';

describe('resolveAnchorOffset', () => {
  it('returns the EXACT original offset across quote/dash normalization', () => {
    const text = 'He paused—then ran. "Stop," she said.';
    const off = resolveAnchorOffset(text, 'ran. "Stop,"'); // anchor uses straight quotes
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' she said.'); // exact, not toContain
  });
  it('null when not unique', () => expect(resolveAnchorOffset('he said, he said', 'he said')).toBeNull());
  it('null when absent (TOCTOU edit)', () => expect(resolveAnchorOffset('totally different', 'ran.')).toBeNull());
});

describe('planApply', () => {
  const live = [
    { id: 5, chapterId: 3, text: 'The hall was dark.', characterId: 'narrator' },
    { id: 6, chapterId: 3, text: 'Dust hung in the air.', characterId: 'narrator' },
    { id: 7, chapterId: 3, text: 'He sighed. "At last," she said. He left.', characterId: 'narrator' },
  ];
  it('rejects a field edit whose id a structural op consumed', () => {
    const r = planApply([
      { id: 6, op: 'merge', mergeIds: [5, 6], rationale: 'over-split' },
      { id: 6, op: 'strip_tag', newText: 'x', rationale: 'tag' },
    ], live);
    expect(r.appliable.map((o) => o.op)).toEqual(['merge']);
    expect(r.unappliable[0].reason).toMatch(/consumed/);
  });
  it('rejects a non-adjacent / cross-character merge', () => {
    const r = planApply([{ id: 5, op: 'merge', mergeIds: [5, 7], rationale: 'x' }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/adjacent|character/);
  });
  it('TOCTOU: a structural op whose anchor no longer resolves is unappliable', () => {
    const r = planApply([{ id: 5, op: 'split', anchor: 'no such text', pieceCharacterIds: ['narrator', 'maerin'], rationale: 'x' }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/anchor/);
  });
  it('rejects fix_emotion to an invalid enum', () => {
    const r = planApply([{ id: 5, op: 'fix_emotion', emotion: 'furious', rationale: 'x' }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/emotion/);
  });
});
```

- [ ] **Step 2: Run → fail** (module not found).
- [ ] **Step 3: Implement** (index-map resolver — the per-char-rescan bug is gone; whitespace is preserved by NOT collapsing it):

```typescript
// src/lib/script-review-apply.ts
export const REVIEW_EMOTIONS = ['neutral', 'whisper', 'angry', 'excited', 'sad'] as const;

export interface ReviewOp {
  id: number;
  op: 'strip_tag' | 'split' | 'extract_dialogue' | 'merge' | 'fix_emotion';
  newText?: string;
  anchor?: string;
  anchorEnd?: string;
  pieceCharacterIds?: string[];
  mergeIds?: number[];
  emotion?: string;
  rationale: string;
  confidence?: number;
}

/** NFC + quote/dash/ellipsis folds ONLY — every fold maps 1 original char to a
    known number of normalized chars, so an index map is exact. No whitespace
    collapse (it would desync positions — the plan-review bug). */
function normChar(c: string): string {
  if (c === '‘' || c === '’') return "'";
  if (c === '“' || c === '”') return '"';
  if (c === '–' || c === '—') return '-';
  if (c === '…') return '...';
  return c.normalize('NFC');
}
export function normalizeForMatch(text: string): string {
  let out = '';
  for (const ch of text) out += normChar(ch);
  return out;
}

/** Returns the ORIGINAL-text offset of the END of a unique anchor match, or null. */
export function resolveAnchorOffset(text: string, anchor: string): number | null {
  // Build normalized string + a map from each normalized index to the original index AFTER it.
  let norm = '';
  const origEndForNormLen: number[] = [0]; // origEndForNormLen[k] = original index after k normalized chars
  for (let i = 0; i < text.length; i++) {
    const piece = normChar(text[i]);
    for (let j = 0; j < piece.length; j++) origEndForNormLen.push(i + 1);
    norm += piece;
  }
  const nAnchor = normalizeForMatch(anchor);
  if (!nAnchor) return null;
  const first = norm.indexOf(nAnchor);
  if (first < 0 || first !== norm.lastIndexOf(nAnchor)) return null;
  return origEndForNormLen[first + nAnchor.length];
}

export function planApply(
  ops: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string }>,
): { appliable: ReviewOp[]; unappliable: Array<{ op: ReviewOp; reason: string }> } {
  const byId = new Map(live.map((s) => [s.id, s]));
  const appliable: ReviewOp[] = [];
  const unappliable: Array<{ op: ReviewOp; reason: string }> = [];
  const STRUCTURAL = new Set(['split', 'extract_dialogue', 'merge']);
  const consumed = new Set<number>();
  const structTargets = new Set<number>();

  for (const op of ops.filter((o) => STRUCTURAL.has(o.op))) {
    const primary = op.op === 'merge' ? (op.mergeIds ?? [])[0] : op.id;
    if (structTargets.has(primary)) { unappliable.push({ op, reason: 'second structural op on the same id' }); continue; }
    if (op.op === 'merge') {
      const ids = [...(op.mergeIds ?? [])].sort((a, b) => a - b);
      const members = ids.map((id) => byId.get(id));
      if (members.some((m) => !m)) { unappliable.push({ op, reason: 'merge member missing' }); continue; }
      const ch = members[0]!.chapterId;
      const sameChar = members.every((m) => m!.characterId === members[0]!.characterId);
      const sameChapter = members.every((m) => m!.chapterId === ch);
      const adjacent = ids.every((id, k) => k === 0 || id === ids[k - 1] + 1);
      if (!sameChar || !adjacent || !sameChapter) { unappliable.push({ op, reason: 'merge members not adjacent / same character / same chapter' }); continue; }
      ids.forEach((id) => { consumed.add(id); structTargets.add(id); });
      appliable.push(op);
    } else {
      const s = byId.get(op.id);
      if (!s) { unappliable.push({ op, reason: 'target id missing' }); continue; }
      if (resolveAnchorOffset(s.text, op.anchor ?? '') === null) { unappliable.push({ op, reason: 'anchor not found or not unique' }); continue; }
      if (op.op === 'extract_dialogue' && resolveAnchorOffset(s.text, op.anchorEnd ?? '') === null) { unappliable.push({ op, reason: 'extract anchorEnd not found or not unique' }); continue; }
      consumed.add(op.id); structTargets.add(op.id); appliable.push(op);
    }
  }

  for (const op of ops.filter((o) => !STRUCTURAL.has(o.op))) {
    if (consumed.has(op.id)) { unappliable.push({ op, reason: 'id consumed by a structural op' }); continue; }
    if (!byId.has(op.id)) { unappliable.push({ op, reason: 'target id missing' }); continue; }
    if (op.op === 'fix_emotion' && !REVIEW_EMOTIONS.includes(op.emotion as never)) { unappliable.push({ op, reason: 'invalid emotion value' }); continue; }
    appliable.push(op);
  }
  return { appliable, unappliable };
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(frontend): script-review anchor resolver + op validation (TOCTOU, two-anchor extract)`.

### Task 5: Accept→dispatch wiring (all 5 classes, real reducers, boundary_move for every op)

**Files:** Modify `src/lib/script-review-apply.ts` (add `dispatchAcceptedOps`); Test `src/lib/script-review-apply.test.ts` (run against a REAL store + assert state + ID allocation).

**Interfaces:** `dispatchAcceptedOps(dispatch, accepted: ReviewOp[], live, { onBoundaryMove })` — dispatches the mapped reducer per op; resolves anchors against `live` text; calls `onBoundaryMove(chapterId)` for **every** op (so staleness fires per Task 3).

- [ ] **Step 1: Write the failing test** — use a REAL store (`configureStore({ reducer: { manuscript } })`), seed via the `start()` helper's state, dispatch `dispatchAcceptedOps` for one of each class, assert the resulting manuscript state (split offspring id = global max+1; merge survivor text; strip_tag text; fix_emotion emotion) and that `onBoundaryMove` fired once per op.

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement:**

```typescript
import type { Dispatch } from '@reduxjs/toolkit';
import { manuscriptActions } from '../store/manuscript-slice';

export function dispatchAcceptedOps(
  dispatch: Dispatch,
  accepted: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string }>,
  { onBoundaryMove }: { onBoundaryMove: (chapterId: number) => void },
): void {
  const byId = new Map(live.map((s) => [s.id, s]));
  for (const op of accepted) {
    const target = byId.get(op.op === 'merge' ? (op.mergeIds?.[0] ?? op.id) : op.id);
    if (!target) continue;
    const chapterId = target.chapterId;
    switch (op.op) {
      case 'strip_tag':
        dispatch(manuscriptActions.setSentenceText({ chapterId, sentenceId: op.id, text: op.newText ?? target.text }));
        break;
      case 'fix_emotion':
        dispatch(manuscriptActions.setSentenceEmotion({ chapterId, sentenceId: op.id, emotion: op.emotion ?? 'neutral' }));
        break;
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
    onBoundaryMove(chapterId);
  }
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(frontend): script-review accept->reducer dispatch (all 5 classes)`.

---

## Phase 2 — Read-only review pass + endpoint (server)

### Task 6: The review op schema (flat envelope, incl. `anchorEnd`)

**Files:** Modify `server/src/handoff/schemas.ts`; Test `server/src/handoff/schemas.test.ts`.

**Interfaces:** Produces `scriptReviewSchema`, `ScriptReviewOp`, `ScriptReviewOutput`. Flat envelope (no discriminated union — Gemini can't constrain it; Ollama only softly); per-op payload validated imperatively client-side (Task 4) and server pre-apply is N/A (apply is client-side).

- [ ] **Step 1: Write the failing test** — parses a heterogeneous `{ ops: [...] }` incl. an `extract_dialogue` with `anchor`+`anchorEnd`; rejects an unknown op.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** (note `EMOTIONS` is already exported from this same file, `schemas.ts:11`):

```typescript
export const scriptReviewSchema = z.object({
  ops: z.array(z.object({
    id: z.number().int().positive(),
    op: z.enum(['strip_tag', 'split', 'extract_dialogue', 'merge', 'fix_emotion']),
    newText: z.string().optional(),
    anchor: z.string().optional(),
    anchorEnd: z.string().optional(),
    pieceCharacterIds: z.array(z.string()).optional(),
    mergeIds: z.array(z.number().int().positive()).optional(),
    emotion: z.enum(EMOTIONS).optional(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  }).strict()),
}).strict();
export type ScriptReviewOp = z.infer<typeof scriptReviewSchema>['ops'][number];
export type ScriptReviewOutput = z.infer<typeof scriptReviewSchema>;
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(server): scriptReviewSchema (flat envelope) for the review pass`.

### Task 7a: Analyzer interface + fallback delegation (testable red-first)

**Files:** Modify `server/src/analyzer/index.ts` (interface method + `FallbackAnalyzer` delegation), `server/src/handoff/protocol.ts` (`HandoffKey += \`review-ch${number}\``); Test `server/src/analyzer/fallback.test.ts` (mirror the existing `runEmotionChapter` delegation test).

**Interfaces:** `Analyzer.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call): Promise<ScriptReviewOutput>`.

- [ ] **Step 1: Write the failing delegation test** — mirror `fallback.test.ts`'s `runEmotionChapter` case: a primary that throws `LocalUnreachableError` falls back; `AnalysisAbortedError` rethrows.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Add the `HandoffKey` variant** (`| \`review-ch${number}\``), the interface method (after `runEmotionChapter`), and the `FallbackAnalyzer.runScriptReviewChapter` delegation (copy the `runEmotionChapter` fallback body, renamed). Add a stub `runScriptReviewChapter` to any test-double analyzers so the interface compiles.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(server): runScriptReviewChapter on the Analyzer interface + fallback`.

### Task 7b: Ollama + Gemini impls, skill prompt, registry knob

**Files:** Modify `server/src/analyzer/gemini.ts` (impl + `SKILL_FILES` + `SkillName` + `SKILL_TO_PROMPT_ID` + **`scriptReviewSchema`/`ScriptReviewOutput` imports**), `server/src/analyzer/ollama.ts` (impl + **the same imports**), `server/src/config/registry.ts` (`prompt.scriptReview` knob); Create `skills/audiobook-script-review.md`; Test `server/src/analyzer/script-review.test.ts` (copy the two-schema `runStage` mock block from `ollama.test.ts`), `skills/audiobook-script-review.test.ts` (M5 snapshot).

- [ ] **Step 1: Register skill + prompt id (gemini.ts)** — `SKILL_FILES`: `script_review: 'audiobook-script-review.md',`; `SKILL_TO_PROMPT_ID`: `script_review: 'prompt.scriptReview',`.
- [ ] **Step 2: Add the registry knob** (registry.ts, mirror `prompt.emotionAnnotation`): key `prompt.scriptReview`, `isPrompt: true`, `default: 'skills/audiobook-script-review.md'`, `apply: 'live'`, `risk: 'high'`.
- [ ] **Step 3: Add the impls** (gemini.ts AND ollama.ts — add the imports first, then the method; passing `scriptReviewSchema` for both grammar+validation mirrors `runEmotionChapter` exactly):

```typescript
async runScriptReviewChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<ScriptReviewOutput> {
  const key = `review-ch${chapterId}` as const;
  return this.runStage(manuscriptId, key, 'script_review', promptMd, scriptReviewSchema, scriptReviewSchema, call);
}
```

- [ ] **Step 4: Write the prompt** `skills/audiobook-script-review.md` — instruct: given a chapter's attributed sentences + cast, return `{ ops: [...] }` for the 5 classes. **Transcribe the M5 clause verbatim:** "NEVER strip intentional non-verbal vocalizations such as \"Ah!\", \"Haah…\", \"Mmm\" — these are spoken content, not attribution tags. Only strip true speech-attribution tags (\"he said\", \"she whispered\")." For `split`: return a boundary-spanning `anchor` (copied verbatim from the sentence) + `pieceCharacterIds`. For `extract_dialogue`: return `anchor` (start of the dialogue span) + `anchorEnd` (end of it) + 3-element `pieceCharacterIds` (narrator, speaker, narrator). For `merge`: `mergeIds` of adjacent same-speaker narrator sentences. For `fix_emotion`: only when the current emotion is clearly wrong; `emotion` ∈ neutral|whisper|angry|excited|sad. Always a one-line `rationale`. Output JSON only.
- [ ] **Step 5: Write the M5 snapshot test** `skills/audiobook-script-review.test.ts` — read the skill file, assert it contains the vocalization-protection clause (so the constraint can't silently disappear). (Abstention is model behavior — this snapshot is the automated guard; full behavioral check is manual/eval, noted in the spec.)
- [ ] **Step 6: Write the impl test** `script-review.test.ts` — copy the two-schema `runStage` HTTP-mock block from `ollama.test.ts`; mock the chat layer to return a canned `{ops:[...]}`; assert `runScriptReviewChapter` returns the parsed ops + writes the inbox/outbox handoff. Run → fail (before Step 3 lands for the engine under test) → pass.
- [ ] **Step 7: Run → pass.** `npm run test:server -- script-review.test.ts` + `npm test -- skills/audiobook-script-review.test.ts`.
- [ ] **Step 8: Commit** `feat(server): runScriptReviewChapter Ollama+Gemini impls + skill + M5 guard`.

### Task 8: The SSE endpoint `POST /api/books/:bookId/script-review`

**Files:** Create `server/src/routes/script-review.ts` (copy `annotate-emotion.ts`); Modify `server/src/app.ts` (mount under `/api/books`), `openapi.yaml` (transcribe the path); Test `server/src/routes/script-review.test.ts` (mirror `annotate-emotion.test.ts`).

**Interfaces:** Body `{ chapterId?: number; model?: string }`. SSE events: `phase` / `ops` (`{kind:'ops', chapterId, ops}`) / `throttle` / `chapter-failed` / `error` / `result`.

- [ ] **Step 1: Write the failing route test** — supertest POST; mock the analyzer to emit a canned envelope; assert the SSE stream contains an `ops` event + a `result`; assert `{chapterId: N}` limits the pass to one chapter.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — copy `annotate-emotion.ts`; rename router/path; honor optional `req.body.chapterId` (filter `chapterIds` to `[chapterId]`); build the prompt from the chapter's post-fold sentences + **post-fold roster**; **overflow:** if a chapter's prompt would exceed the model budget, chunk-with-overlap (reuse the `stage2-chunk.ts` budget constant) — **OR**, if deferring, emit a `chapter-failed` with a clear "chapter too large — split it first" message and state this assumption in a code comment. Call `runScriptReviewChapter`; emit `{kind:'ops', chapterId, ops: result.ops}`. Keep the SSE scaffolding/keep-alive/abort/`DailyQuotaExhaustedError`/per-chapter `chapter-failed`.
- [ ] **Step 4: Mount + openapi** — `app.use('/api/books', scriptReviewRouter);` (after annotate-emotion). **Transcribe** the `openapi.yaml` path block (copy the annotate-emotion path operation; change the path to `/books/{bookId}/script-review`; add `requestBody` with optional `chapterId: integer` + `model: string`; document the `text/event-stream` response). OpenAPI is the source of truth — write it out, don't describe it.
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** `feat(server): POST /api/books/:bookId/script-review SSE endpoint`.

### Task 9: Frontend api client (`reviewScript`) — real + mock + explicit stream test

**Files:** Modify `src/lib/api.ts` (`realReviewScript`, `mockReviewScript`, `ReviewScriptOpts`/`Result`/`Error`, register in both `real`/`mock`); Test `src/lib/api.test.ts`.

**Interfaces:** `api.reviewScript(bookId, { chapterId?, model?, signal?, onPhase?, onThrottle?, onOps? }): Promise<{ reviewedChapters: number; totalOps: number }>`; `onOps({ chapterId, ops: ReviewOp[] })`.

- [ ] **Step 1: Write the failing test EXPLICITLY** (there is no detect-emotions test to mirror — write the fetch stub):

```typescript
it('parses the SSE stream and surfaces ops', async () => {
  const chunks = [
    'data: {"kind":"ops","chapterId":1,"ops":[{"id":1,"op":"strip_tag","newText":"x","rationale":"tag"}]}\n\n',
    'data: {"kind":"result","reviewedChapters":1,"totalOps":1}\n\n',
  ].map((s) => new TextEncoder().encode(s));
  let i = 0;
  const body = { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) };
  global.fetch = (async () => ({ ok: true, status: 200, body })) as never;
  const seen: unknown[] = [];
  const res = await api.reviewScript('b1', { onOps: (e) => seen.push(e) });
  expect(seen).toHaveLength(1);
  expect(res.totalOps).toBe(1);
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — copy `realDetectEmotions`/`mockDetectEmotions`; change URL to `/script-review`; send `{ chapterId, model }`; handle `kind:'ops'` → `onOps`. Register `reviewScript` in both `real` and `mock` api objects.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(frontend): api.reviewScript client (real+mock) + SSE stream test`.

---

## Phase 3 — Operator UX

### Task 10: Dedicated suggestions slice (non-polled, bookId-keyed)

**Files:** Create `src/store/script-review-slice.ts`; Modify `src/store/index.ts` (register `scriptReview`); Test `src/store/script-review-slice.test.ts`.

**Interfaces:** State `{ byBook: Record<string, { ops: ReviewOp[]; unappliable: Array<{op,reason}>; selected: Record<string, boolean> } | undefined> }`; actions `setReview`, `toggleOp`, `toggleClass`, `clearReview`; selector `selectActiveReview(state, bookId)` reads ONLY that book's bucket. Op key = `${chapterId}:${id}:${op}` (chapterId carried on the ReviewOp envelope from the `ops` SSE event).

- [ ] **Step 1: Write the failing test** — `setReview` defaults all selected ON; `selectActiveReview` returns only that book; a second book's `setReview` doesn't wipe the first; `toggleClass` flips all of a class.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** (RTK, Immer; init `selected[key]=true` in `setReview`).
- [ ] **Step 4: Register** in `store/index.ts` reducer map beside `revisions`.
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** `feat(frontend): dedicated non-polled script-review suggestions slice`.

### Task 11: `ScriptReviewDiff` modal + "Review Script" trigger + RPD warning

**Files:** Create `src/components/script-review-diff.tsx`; Modify `src/views/manuscript.tsx` (button + run/stream wiring); Test `src/components/script-review-diff.test.tsx`.

**Interfaces:** Consumes `selectActiveReview`, `scriptReviewActions`, `dispatchAcceptedOps`, `planApply`, `changeLogActions.bumpBoundaryMove`.

- [ ] **Step 1: Write the failing component test** — render with a seeded review (one `strip_tag`, one `fix_emotion`), toggle one off, click Apply; assert the kept op's reducer action dispatched (real store), `bumpBoundaryMove` fired for the chapter, and the review cleared.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement the modal** — DriftReport accept-reject layout; group by class; per-class + per-change toggles; before→after; design tokens (no hex). On Apply: `const live = selectLiveSentences(); const { appliable } = planApply(selectedOps, live); dispatchAcceptedOps(dispatch, appliable, live, { onBoundaryMove: (c) => dispatch(changeLogActions.bumpBoundaryMove({ chapterId: c, count: 1 })) }); dispatch(scriptReviewActions.clearReview({ bookId }));` (re-running `planApply` against LIVE sentences at Apply time is the TOCTOU guard.)
- [ ] **Step 4: Add the "Review Script" button** to `manuscript.tsx` — `min-h-[44px] sm:min-h-0`; per-chapter by default (`chapterId: currentChapterId`); a whole-book opt-in that, when the book's chapter count exceeds the selected model's RPD (`rate-limit.ts` caps), shows a warning ("This book has N chapters; the selected model allows only M reviews/day — switch to a local model or review per chapter"). Stream `api.reviewScript`, accumulate ops, then `planApply` + `dispatch(setReview)` to open the modal. Model is **per-run** (passed to `reviewScript`); no persisted review-model knob in Unit A (descope; noted in spec follow-ups).
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** `feat(frontend): ScriptReviewDiff modal + Review Script trigger + RPD guard`.

### Task 12: E2E — per-chapter review → accept → stale

**Files:** Create `e2e/script-review.spec.ts`; Modify `e2e/responsive/coverage.spec.ts`. `mockReviewScript` returns a deterministic op so the flow runs without an LLM.

- [ ] **Step 1: Write the spec** — open a book to the manuscript view; click "Review Script"; assert the modal opens with the mock op; accept; assert the sentence updated and (navigating to Generate) the chapter shows the stale badge.
- [ ] **Step 2: Run** `npm run test:e2e -- script-review.spec.ts` → PASS (chromium).
- [ ] **Step 3: Commit** `test(e2e): script-review per-chapter accept flow`.

### Task 13: Full verify + hygiene + PR

- [ ] **Step 1:** `npm run verify` (typecheck + all tests + e2e + build). Fix in-scope red; surface pre-existing failures to the user rather than bundling.
- [ ] **Step 2:** Set the spec `status: active`. (No `docs/features/` regression plan owed — see Global Constraints. No `INDEX.md` entry, which tracks `docs/features/` plans only.) Fill the spec's Ship notes when merged → then `stable`.
- [ ] **Step 3:** Open the PR: title `feat(frontend,server): fs-58 LLM Script Review (Unit A)`, `Closes #998`, `## Summary` + `## Test plan` filled, linking the spec.

---

## Self-Review (completed by plan author, post-plan-review)

**Spec coverage:** every §3 class has an apply path (Task 1 strip_tag; Task 4/5 split + two-anchor extract; Task 2 merge; existing setSentenceEmotion fix_emotion); staleness (revised: §5.3 → boundary_move + OR-gate) = Task 3; op-validation/TOCTOU = Task 4; the ~16-site pass = Tasks 6-9 (interface/fallback 7a; impls/skill/registry 7b; protocol HandoffKey 7a; openapi 8; api real+mock 9; slice+store 10); §5.5 dedicated slice = Task 10; §6 UX = Task 11; per-chapter overflow = Task 8 Step 3 (handle or stated assumption); RPD warning = Task 11 Step 4; merge tombstone persistence = Task 2b. Follow-ups = Task 0.

**Plan-review fixes folded:** resolveAnchorOffset index-map (no whitespace-collapse) + exact-offset test (Task 4); extract_dialogue two-anchor (Tasks 4/5/6/7b); test scaffolds set manuscriptId via a state literal (Tasks 1/2); merge re-analysis test reaches the tombstone (Task 2); tombstone persisted + book-scoped (Task 2b); content-hash dropped for boundary_move+OR-gate (Task 3); Task 3/7 split for scope/TDD; ollama scriptReviewSchema import (Task 7b); openapi + M5 prompt clause transcribed (Tasks 8/7b); missing tests added (split-staleness via Task 3, planApply TOCTOU + merge-rejection + invalid-enum in Task 4, all-5 apply-via-real-reducer + ID alloc in Task 5, explicit SSE stream test in Task 9, M5 snapshot in Task 7b); the "distinct Ollama grammar schema" gap is a non-issue (fs-33 passes one schema for both — Task 7b mirrors it).

**Type consistency:** `ReviewOp` defined once (Task 4), consumed by Tasks 5/9/10/11; server `ScriptReviewOp` (Task 6) is the structural parallel; reducer payloads match across Tasks 1/2/5; `resolveAnchorOffset` signature consistent. No forward references (Task 4 precedes all `ReviewOp` consumers; Task 6 precedes the server impl in 7b).
