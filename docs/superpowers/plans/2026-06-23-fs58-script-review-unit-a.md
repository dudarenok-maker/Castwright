# fs-58 LLM Script Review (Unit A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator-triggered, per-chapter, read-only LLM pass that proposes annotation repairs (strip stray attribution tags, split/extract/merge sentence boundaries, correct a wrong emotion) and applies the accepted ones client-side by dispatching the existing manual-edit reducers.

**Architecture:** The server review pass mirrors fs-33's `runEmotionChapter` (a per-chapter analyzer call over already-attributed sentences) but **writes no manuscript state** — it streams suggestions over SSE. Accepted suggestions are applied in the browser by dispatching Redux reducers (`splitSentence`, `setSentenceEmotion`, plus two new ones: `setSentenceText`, `mergeSentences`), so apply inherits the existing ID-allocation and debounced persistence. Audio staleness for the edits the precise `characterId`-only diff misses (text change, retained split piece, `angry→neutral`) is fixed once by adding a per-sentence **content hash** to the render-time map.

**Tech Stack:** TypeScript, Vitest (frontend `npm test`, server `npm run test:server`), Redux Toolkit (Immer reducers), Zod (analyzer schemas), Playwright (`npm run test:e2e`), Express SSE, Ollama/Gemini analyzers.

**Spec:** `docs/superpowers/specs/2026-06-23-fs58-llm-script-review-design.md` (read it; this plan implements Unit A = 5 classes incl `merge`).

## Global Constraints

- **OpenAPI is the type source of truth.** A new endpoint path goes in `openapi.yaml`. Unit A persists **no new types** (suggestions are ephemeral) → **no `npm run openapi:types` regen**.
- **No hex literals in component code** — use the CSS custom properties / Tailwind tokens (`--peach`, `--ink`, …).
- **RTK reducers mutate via Immer drafts** — match the existing slice style; don't rewrite to spreads.
- **Commit convention:** `<type>(<scope>): <subject>`; scopes used here: `frontend`, `server`, `docs`. End every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Mocks behind `api = USE_MOCKS ? mock : real`** — every new `api.*` method needs BOTH a real and a mock impl, registered in both objects.
- **Tests are required** — new behaviour ships paired tests; this plan is TDD (failing test first).
- **Run before declaring done:** `npm run verify` (typecheck + all tests + e2e + build).
- **Engine-agnostic = no TTS engine load.** This feature never loads Kokoro/Coqui/Qwen; it uses the analyzer path (Ollama/Gemini).

---

## Phase 0 — Governance (file with the plan; the #998/BACKLOG rewrite is the hard gate to leave `draft`)

### Task 0: Re-scope the tracking artifacts

**Files:**
- Modify: `docs/BACKLOG.md` (the `fs-58` row, ~line 153)
- (GitHub, via `gh`): issue #998; new issues for Unit B, `validate_instruct`; edits to #996 (fs-56) and #721 (fs-44)

- [ ] **Step 1: Rewrite the `fs-58` BACKLOG row** to the Unit A scope — replace "five error classes … validate/repair instruct fields … Engine-agnostic (no GPU)" with: "Unit A: strip_tag/split/extract_dialogue/merge + fix_emotion; read-only per-chapter LLM pass, client-side apply; engine-agnostic (no TTS engine — uses the analyzer)." Link the spec + plan.

- [ ] **Step 2: Rewrite issue #998** to match (What/Acceptance/Key files), noting `validate_instruct`→fs-56, `reattribute`/`flag_nonstory`→Unit B, placement is now standalone-anytime.

```bash
gh issue edit 998 --body-file -   # paste the rewritten body
```

- [ ] **Step 3: File the Unit B issue** (`reattribute` + `flag_nonstory`) with its deps (spec §13) and add a thin BACKLOG row.

- [ ] **Step 4: File the `validate_instruct` issue** (blocked on fs-56's per-sentence `instruct`) and **edit #996 (fs-56)** to carry the move-here note (bidirectional capture).

- [ ] **Step 5: Edit #721 (fs-44)** to add the dependency note: "script-review apply is client-side (Redux dispatch); a headless/MCP apply path needs a server-side equivalent."

- [ ] **Step 6: Commit the BACKLOG change**

```bash
git add docs/BACKLOG.md
git commit -m "docs(docs): re-scope fs-58 row to Unit A"
```

---

## Phase 1 — Apply foundations (client-side; highest-risk, test-first)

This phase builds everything needed to *apply* an accepted suggestion, independent of where suggestions come from. It carries the latent-bug staleness fixes, so it's valuable even before the review pass exists.

### Task 1: `setSentenceText` reducer (`strip_tag` apply target)

**Files:**
- Modify: `src/store/manuscript-slice.ts` (add reducer next to `setSentenceCharacter` ~line 254)
- Test: `src/store/manuscript-slice.test.ts`

**Interfaces:**
- Produces: action `manuscriptActions.setSentenceText({ chapterId: number; sentenceId: number; text: string })` — mutates the matching sentence's `text` in place; no-op if not found.

- [ ] **Step 1: Write the failing test**

```typescript
// src/store/manuscript-slice.test.ts
import { describe, it, expect } from 'vitest';
import reducer, { manuscriptActions } from './manuscript-slice';

describe('setSentenceText', () => {
  it('replaces the text of the matching sentence and leaves others untouched', () => {
    const start = reducer(undefined, manuscriptActions.hydrateFromAnalysis({
      manuscriptId: 'm1', bookId: 'b1',
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narrator', text: 'He ran. "Stop," she said.' },
        { id: 2, chapterId: 1, characterId: 'narrator', text: 'Quiet.' },
      ],
    } as never));
    const next = reducer(start, manuscriptActions.setSentenceText({
      chapterId: 1, sentenceId: 1, text: 'He ran. "Stop,"',
    }));
    expect(next.sentences.find((s) => s.id === 1)?.text).toBe('He ran. "Stop,"');
    expect(next.sentences.find((s) => s.id === 2)?.text).toBe('Quiet.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/store/manuscript-slice.test.ts -t setSentenceText`
Expected: FAIL — `manuscriptActions.setSentenceText is not a function`.

- [ ] **Step 3: Add the reducer** (after `setSentenceCharacter`, mirroring its shape)

```typescript
setSentenceText: (
  s,
  a: PayloadAction<{ chapterId: number; sentenceId: number; text: string }>,
) => {
  const sent = s.sentences.find(
    (x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId,
  );
  if (sent) sent.text = a.payload.text;
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/store/manuscript-slice.test.ts -t setSentenceText`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/manuscript-slice.test.ts
git commit -m "feat(frontend): add setSentenceText reducer for script-review strip_tag"
```

### Task 2: `mergeSentences` reducer + merge tombstone (survives re-analysis)

**Files:**
- Modify: `src/store/manuscript-slice.ts` — add `mergedAwayKeys: string[]` to `ManuscriptState` (init `[]`), the `mergeSentences` reducer, and a guard in `hydrateFromAnalysis`'s incoming-append branch; clear the tombstone in `reset` and on a manuscript re-upload (`applyReupload`).
- Test: `src/store/manuscript-slice.test.ts`

**Interfaces:**
- Produces: action `manuscriptActions.mergeSentences({ chapterId: number; sentenceIds: number[] })` — concatenates the named sentences (document order) into the lowest id, drops the rest, records dropped `${chapterId}:${id}` in `mergedAwayKeys`. State gains `mergedAwayKeys: string[]`.

- [ ] **Step 1: Write the failing tests** (merge behaviour + resurrection guard)

```typescript
describe('mergeSentences', () => {
  const hydrate = (sentences: unknown[]) =>
    reducer(undefined, manuscriptActions.hydrateFromAnalysis({
      manuscriptId: 'm1', bookId: 'b1', sentences,
    } as never));

  it('merges into the lowest id, concatenates text in order, drops the rest', () => {
    const start = hydrate([
      { id: 5, chapterId: 3, characterId: 'narrator', text: 'The hall was dark.' },
      { id: 6, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
    ]);
    const next = reducer(start, manuscriptActions.mergeSentences({ chapterId: 3, sentenceIds: [5, 6] }));
    const ch3 = next.sentences.filter((s) => s.chapterId === 3);
    expect(ch3).toHaveLength(1);
    expect(ch3[0].id).toBe(5);
    expect(ch3[0].text).toBe('The hall was dark. Dust hung in the air.');
    expect(next.mergedAwayKeys).toContain('3:6');
  });

  it('does NOT resurrect the merged-away id on a subsequent re-analysis', () => {
    const start = hydrate([
      { id: 5, chapterId: 3, characterId: 'narrator', text: 'The hall was dark.' },
      { id: 6, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
    ]);
    const merged = reducer(start, manuscriptActions.mergeSentences({ chapterId: 3, sentenceIds: [5, 6] }));
    // Re-analysis re-mints ids 5 and 6 from the unchanged source text:
    const reanalysed = reducer(merged, manuscriptActions.hydrateFromAnalysis({
      manuscriptId: 'm1', bookId: 'b1',
      sentences: [
        { id: 5, chapterId: 3, characterId: 'narrator', text: 'The hall was dark.' },
        { id: 6, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
      ],
    } as never));
    const ch3 = reanalysed.sentences.filter((s) => s.chapterId === 3);
    expect(ch3.map((s) => s.id)).toEqual([5]); // 6 stays dead; no duplicate
    expect(ch3[0].text).toBe('The hall was dark. Dust hung in the air.');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- src/store/manuscript-slice.test.ts -t mergeSentences`
Expected: FAIL — `mergeSentences is not a function`.

- [ ] **Step 3: Add `mergedAwayKeys` to state + init**

In `ManuscriptState` add `mergedAwayKeys: string[];`. In the slice's `initialState` add `mergedAwayKeys: []`. In the `reset` reducer set `s.mergedAwayKeys = []`. In `applyReupload` set `s.mergedAwayKeys = []` (a new manuscript invalidates old merges).

- [ ] **Step 4: Add the `mergeSentences` reducer**

```typescript
mergeSentences: (
  s,
  a: PayloadAction<{ chapterId: number; sentenceIds: number[] }>,
) => {
  const ids = [...a.payload.sentenceIds].sort((x, y) => x - y);
  if (ids.length < 2) return;
  const members = ids
    .map((id) => s.sentences.find((x) => x.chapterId === a.payload.chapterId && x.id === id))
    .filter((x): x is (typeof s.sentences)[number] => Boolean(x));
  if (members.length !== ids.length) return; // some id missing — reject
  const surviving = members[0]; // lowest id (ids sorted)
  surviving.text = members.map((m) => m.text).join(' ');
  for (const m of members.slice(1)) {
    const i = s.sentences.findIndex((x) => x.chapterId === a.payload.chapterId && x.id === m.id);
    if (i >= 0) s.sentences.splice(i, 1);
    s.mergedAwayKeys.push(`${a.payload.chapterId}:${m.id}`);
  }
},
```

- [ ] **Step 5: Guard the resurrection branch in `hydrateFromAnalysis`**

Change the incoming-append loop (currently lines ~149-151) to skip tombstoned keys:

```typescript
const tomb = new Set(s.mergedAwayKeys);
for (const inc of incoming) {
  if (!stateKeys.has(key(inc)) && !tomb.has(key(inc))) merged.push(inc);
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `npm test -- src/store/manuscript-slice.test.ts -t mergeSentences`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add src/store/manuscript-slice.ts src/store/manuscript-slice.test.ts
git commit -m "feat(frontend): add mergeSentences reducer + merge tombstone (re-analysis-safe)"
```

### Task 3: Content-hash on the render map (the unified staleness fix)

The precise staleness path (`isChapterReassignedSinceRender`) compares `characterId` only, so it misses `strip_tag` (text change), the retained `split`/`extract` piece (text shrinks, id+characterId unchanged), and `fix_emotion` `angry→neutral`. Fix once: make the render map carry a per-sentence **content hash**, and diff hashes.

**Files:**
- Create: `src/lib/sentence-hash.ts`
- Modify: `src/lib/stale-chapters.ts` (`isChapterReassignedSinceRender` accepts a hash map), `src/views/generation.tsx` (build the current-hash input)
- Modify (server): `server/src/audio/segments-io.ts` (`collectRenderedSpeakerMaps` → also emit a hash map) and the book-state GET that ships `renderedSpeakersByChapter`; `src/store/chapters-slice.ts` (carry `renderedSentenceHashesByChapter`)
- Test: `src/lib/stale-chapters.test.ts`, `src/lib/sentence-hash.test.ts`

**Interfaces:**
- Produces: `sentenceContentHash(s: { text: string; characterId: string; emotion?: string }): string` (stable, order-independent of object key order).
- Produces: `isChapterStaleSinceRender(renderedHashes: Record<number, string> | undefined, current: Array<{ id: number; text: string; characterId: string; emotion?: string }>): boolean` — true if any rendered id's current hash differs (or the id is gone).
- Consumes (server): the existing render-map builder; adds a sibling `renderedSentenceHashesByChapter: Record<number, Record<number, string>>` to the book-state GET and `hydrateFromBookState` payload.

- [ ] **Step 1: Write the failing hash test**

```typescript
// src/lib/sentence-hash.test.ts
import { describe, it, expect } from 'vitest';
import { sentenceContentHash } from './sentence-hash';

describe('sentenceContentHash', () => {
  it('changes when text, characterId, or emotion change; stable otherwise', () => {
    const base = { text: 'Hello.', characterId: 'narrator', emotion: undefined as string | undefined };
    const h = sentenceContentHash(base);
    expect(sentenceContentHash({ ...base })).toBe(h);
    expect(sentenceContentHash({ ...base, text: 'Hello!' })).not.toBe(h);
    expect(sentenceContentHash({ ...base, characterId: 'maerin' })).not.toBe(h);
    expect(sentenceContentHash({ ...base, emotion: 'angry' })).not.toBe(h);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/sentence-hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hash** (a tiny stable string hash; no crypto dep needed)

```typescript
// src/lib/sentence-hash.ts
/** Stable content fingerprint for staleness: any change to the spoken text,
    the speaker, or the delivery emotion produces a different hash, so a
    rendered chapter whose sentence content drifted reads stale. */
export function sentenceContentHash(s: {
  text: string;
  characterId: string;
  emotion?: string;
}): string {
  const payload = `${s.characterId} ${s.emotion ?? ''} ${s.text}`;
  let h = 5381;
  for (let i = 0; i < payload.length; i++) h = ((h << 5) + h + payload.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
```

- [ ] **Step 4: Write the failing staleness test**

```typescript
// src/lib/stale-chapters.test.ts (add)
import { isChapterStaleSinceRender } from './stale-chapters';
import { sentenceContentHash } from './sentence-hash';

describe('isChapterStaleSinceRender (content hash)', () => {
  const s1 = { id: 1, text: '"Stop," she said.', characterId: 'maerin', emotion: undefined as string | undefined };
  const rendered = { 1: sentenceContentHash(s1) };

  it('not stale when content is unchanged', () => {
    expect(isChapterStaleSinceRender(rendered, [s1])).toBe(false);
  });
  it('stale on a strip_tag text change', () => {
    expect(isChapterStaleSinceRender(rendered, [{ ...s1, text: '"Stop,"' }])).toBe(true);
  });
  it('stale on fix_emotion angry->neutral (rendered had a variant)', () => {
    const renderedAngry = { 1: sentenceContentHash({ ...s1, emotion: 'angry' }) };
    expect(isChapterStaleSinceRender(renderedAngry, [{ ...s1, emotion: undefined }])).toBe(true);
  });
  it('stale when a rendered id no longer exists (merged away)', () => {
    expect(isChapterStaleSinceRender(rendered, [])).toBe(true);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npm test -- src/lib/stale-chapters.test.ts -t "content hash"`
Expected: FAIL — `isChapterStaleSinceRender` not exported.

- [ ] **Step 6: Implement `isChapterStaleSinceRender`** (add next to `isChapterReassignedSinceRender`)

```typescript
import { sentenceContentHash } from './sentence-hash';

export function isChapterStaleSinceRender(
  renderedHashes: Record<number, string> | undefined,
  current: Array<{ id: number; text: string; characterId: string; emotion?: string }>,
): boolean {
  if (!renderedHashes || Object.keys(renderedHashes).length === 0) return false;
  const byId = new Map(current.map((s) => [s.id, s]));
  for (const sidStr of Object.keys(renderedHashes)) {
    const sid = Number(sidStr);
    const s = byId.get(sid);
    if (!s || sentenceContentHash(s) !== renderedHashes[sid]) return true;
  }
  return false;
}
```

- [ ] **Step 7: Wire the server render map** — in `server/src/audio/segments-io.ts` where `collectRenderedSpeakerMaps` builds `{ [chapterId]: { [sentenceId]: characterId } }`, build a parallel `{ [chapterId]: { [sentenceId]: sentenceContentHash(...) } }` from the same rendered sentences (port `sentenceContentHash` to a server util or duplicate the 6-line function in `server/src/audio/`), and include it in the book-state GET response as `renderedSentenceHashesByChapter`. Add the field to `chapters-slice.ts` `hydrateFromBookState` payload + state (mirror `renderedSpeakersByChapter`).

- [ ] **Step 8: Flip `generation.tsx` to the hash path** — where the `stale={…}` gate (lines ~1108-1115) uses `reassignedSinceRenderSet`, compute staleness from `renderedSentenceHashesByChapter[ch.id]` + the live chapter sentences via `isChapterStaleSinceRender`. Keep the `isChapterStaleFromReassign` time-based fallback for chapters with no hash map (older servers/mocks).

- [ ] **Step 9: Run frontend + server tests**

Run: `npm test -- src/lib/stale-chapters.test.ts src/lib/sentence-hash.test.ts` then `npm run test:server`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/sentence-hash.ts src/lib/stale-chapters.ts src/views/generation.tsx src/store/chapters-slice.ts server/src/audio/segments-io.ts src/lib/sentence-hash.test.ts src/lib/stale-chapters.test.ts
git commit -m "feat(frontend,server): content-hash render map for script-review staleness"
```

### Task 4: Client anchor resolver + op validation/ordering (closes TOCTOU)

**Files:**
- Create: `src/lib/script-review-apply.ts`
- Test: `src/lib/script-review-apply.test.ts`

**Interfaces:**
- Consumes: the suggestion op type (define here, frontend-side, structurally matching the server `ScriptReviewOp`): `interface ReviewOp { id: number; op: 'strip_tag'|'split'|'extract_dialogue'|'merge'|'fix_emotion'; newText?: string; anchor?: string; pieceCharacterIds?: string[]; mergeIds?: number[]; emotion?: string; rationale: string; confidence?: number; }`
- Produces:
  - `normalizeForMatch(text: string): string` — NFC + fold curly→straight quotes, em/en-dash→`-`, ellipsis→`...`, collapse whitespace.
  - `resolveAnchorOffset(text: string, anchor: string): number | null` — normalized `indexOf` that is unique (`indexOf === lastIndexOf`), returns the offset **in the original text** of the split point (end of the anchor's "before" half), else null.
  - `planApply(ops: ReviewOp[], live: Array<{ id: number; chapterId: number; text: string; characterId: string }>): { appliable: ReviewOp[]; unappliable: Array<{ op: ReviewOp; reason: string }> }` — applies §5.6 ordering/validation: structural ops first, reject a field edit whose id a structural op consumed, reject >1 structural op per id, reject anchors that don't resolve uniquely against live text, reject merges whose members aren't adjacent + same characterId.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/script-review-apply.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeForMatch, resolveAnchorOffset, planApply } from './script-review-apply';

describe('anchor resolution', () => {
  it('matches across curly/straight quote + em-dash normalization', () => {
    const text = 'He paused—then ran. “Stop,” she said.';
    // anchor uses straight quotes / hyphen as an LLM might "normalize" them:
    const off = resolveAnchorOffset(text, 'ran. "Stop,"');
    expect(off).not.toBeNull();
    expect(text.slice(0, off!)).toContain('ran.');
  });
  it('returns null when the anchor is not unique', () => {
    expect(resolveAnchorOffset('he said, he said', 'he said')).toBeNull();
  });
  it('returns null when the anchor is absent (mid-review edit / TOCTOU)', () => {
    expect(resolveAnchorOffset('totally different now', 'ran. "Stop,"')).toBeNull();
  });
});

describe('planApply ordering + validation', () => {
  const live = [
    { id: 5, chapterId: 3, text: 'The hall was dark.', characterId: 'narrator' },
    { id: 6, chapterId: 3, text: 'Dust hung in the air.', characterId: 'narrator' },
  ];
  it('rejects a field edit whose id a structural op consumed', () => {
    const r = planApply(
      [
        { id: 6, op: 'merge', mergeIds: [5, 6], rationale: 'over-split' },
        { id: 6, op: 'strip_tag', newText: 'x', rationale: 'tag' },
      ],
      live,
    );
    expect(r.appliable.map((o) => o.op)).toEqual(['merge']);
    expect(r.unappliable[0].reason).toMatch(/consumed/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/script-review-apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver + planner**

```typescript
// src/lib/script-review-apply.ts
export interface ReviewOp {
  id: number;
  op: 'strip_tag' | 'split' | 'extract_dialogue' | 'merge' | 'fix_emotion';
  newText?: string;
  anchor?: string;
  pieceCharacterIds?: string[];
  mergeIds?: number[];
  emotion?: string;
  rationale: string;
  confidence?: number;
}

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Locate the split point: the anchor is a boundary-spanning substring; the
    returned offset is the END of its match in the ORIGINAL text (so callers
    can slice [0,off] / [off,len]). Null if not found OR not unique. */
export function resolveAnchorOffset(text: string, anchor: string): number | null {
  const nText = normalizeForMatch(text);
  const nAnchor = normalizeForMatch(anchor);
  if (!nAnchor) return null;
  const first = nText.indexOf(nAnchor);
  if (first < 0 || first !== nText.lastIndexOf(nAnchor)) return null;
  // Map the normalized end-offset back to the original text by proportional
  // re-scan: walk the original, normalizing incrementally, until we reach the
  // normalized end index. (Whitespace collapse is the only length-changing op
  // we apply; quote/dash/ellipsis swaps are handled char-wise below.)
  const targetNormEnd = first + nAnchor.length;
  let normCount = 0;
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeForMatch(text[i]);
    normCount += piece.length;
    if (normCount >= targetNormEnd) return i + 1;
  }
  return text.length;
}

export function planApply(
  ops: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string }>,
): { appliable: ReviewOp[]; unappliable: Array<{ op: ReviewOp; reason: string }> } {
  const byId = new Map(live.map((s) => [s.id, s]));
  const appliable: ReviewOp[] = [];
  const unappliable: Array<{ op: ReviewOp; reason: string }> = [];
  const STRUCTURAL = new Set(['split', 'extract_dialogue', 'merge']);
  const consumed = new Set<number>(); // ids removed/reshaped by a structural op
  const structuralTargets = new Set<number>();

  // Pass 1: structural ops first.
  for (const op of ops.filter((o) => STRUCTURAL.has(o.op))) {
    if (structuralTargets.has(op.id)) {
      unappliable.push({ op, reason: 'second structural op on the same id' });
      continue;
    }
    if (op.op === 'merge') {
      const ids = [...(op.mergeIds ?? [])].sort((a, b) => a - b);
      const members = ids.map((id) => byId.get(id));
      if (members.some((m) => !m)) { unappliable.push({ op, reason: 'merge member missing' }); continue; }
      const ch = members[0]!.chapterId;
      const sameChar = members.every((m) => m!.characterId === members[0]!.characterId);
      const adjacent = ids.every((id, k) => k === 0 || id === ids[k - 1] + 1);
      if (!sameChar || !adjacent || members.some((m) => m!.chapterId !== ch)) {
        unappliable.push({ op, reason: 'merge members not adjacent / same character / same chapter' });
        continue;
      }
      ids.forEach((id) => { consumed.add(id); structuralTargets.add(id); });
      appliable.push(op);
    } else {
      const s = byId.get(op.id);
      if (!s) { unappliable.push({ op, reason: 'target id missing' }); continue; }
      if (resolveAnchorOffset(s.text, op.anchor ?? '') === null) {
        unappliable.push({ op, reason: 'anchor not found or not unique' });
        continue;
      }
      consumed.add(op.id);
      structuralTargets.add(op.id);
      appliable.push(op);
    }
  }

  // Pass 2: field edits, skipping consumed ids.
  for (const op of ops.filter((o) => !STRUCTURAL.has(o.op))) {
    if (consumed.has(op.id)) { unappliable.push({ op, reason: 'id consumed by a structural op' }); continue; }
    if (!byId.has(op.id)) { unappliable.push({ op, reason: 'target id missing' }); continue; }
    appliable.push(op);
  }
  return { appliable, unappliable };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/lib/script-review-apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/script-review-apply.ts src/lib/script-review-apply.test.ts
git commit -m "feat(frontend): client-side anchor resolver + op validation for script review"
```

### Task 5: The accept→dispatch wiring (pure function over ops → reducer dispatches)

**Files:**
- Modify: `src/lib/script-review-apply.ts` (add `dispatchAcceptedOps`)
- Test: `src/lib/script-review-apply.test.ts`

**Interfaces:**
- Consumes: `manuscriptActions` (`splitSentence`, `setSentenceText`, `setSentenceEmotion`, `mergeSentences`), `changeLogActions.bumpBoundaryMove`, the `planApply` output, the live sentence list.
- Produces: `dispatchAcceptedOps(dispatch, accepted: ReviewOp[], live, { onBoundaryMove })` — for each op resolves the anchor against live text and dispatches the matching reducer; counts boundary moves for the change-log.

- [ ] **Step 1: Write the failing test** (capture dispatched actions)

```typescript
import { manuscriptActions } from '../store/manuscript-slice';
import { dispatchAcceptedOps } from './script-review-apply';

it('dispatches the mapped reducer per op type', () => {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const dispatch = ((a: { type: string; payload: unknown }) => calls.push(a)) as never;
  const live = [
    { id: 1, chapterId: 1, text: 'He ran. "Stop," she said.', characterId: 'maerin' },
  ];
  dispatchAcceptedOps(dispatch, [
    { id: 1, op: 'strip_tag', newText: 'He ran. "Stop,"', rationale: 'tag' },
    { id: 1, op: 'fix_emotion', emotion: 'neutral', rationale: 'calm' },
  ], live, { onBoundaryMove: () => {} });
  expect(calls.map((c) => c.type)).toEqual([
    manuscriptActions.setSentenceText.type,
    manuscriptActions.setSentenceEmotion.type,
  ]);
});
```

- [ ] **Step 2: Run to verify it fails** (`dispatchAcceptedOps` not exported).

Run: `npm test -- src/lib/script-review-apply.test.ts -t "mapped reducer"`

- [ ] **Step 3: Implement**

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
      case 'split':
      case 'extract_dialogue': {
        const off = resolveAnchorOffset(target.text, op.anchor ?? '');
        if (off === null) break;
        dispatch(manuscriptActions.splitSentence({
          chapterId, sentenceId: op.id, offsets: [off],
          characterIds: op.pieceCharacterIds ?? [target.characterId, target.characterId],
        }));
        onBoundaryMove(chapterId);
        break;
      }
      case 'merge':
        dispatch(manuscriptActions.mergeSentences({ chapterId, sentenceIds: op.mergeIds ?? [] }));
        onBoundaryMove(chapterId);
        break;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npm test -- src/lib/script-review-apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/script-review-apply.ts src/lib/script-review-apply.test.ts
git commit -m "feat(frontend): script-review accept->reducer dispatch"
```

---

## Phase 2 — Read-only review pass + endpoint (server)

Mirrors fs-33's `runEmotionChapter` exactly; the only novelty is the op schema and the prompt.

### Task 6: The review op schema (envelope + imperative-validated payloads)

**Files:**
- Modify: `server/src/handoff/schemas.ts` (add `scriptReviewSchema` next to `emotionAnnotationSchema`)
- Test: `server/src/handoff/schemas.test.ts`

**Interfaces:**
- Produces: `scriptReviewSchema` (Zod), `ScriptReviewOp`, `ScriptReviewOutput`. Envelope-only: payload fields optional; per-op shape is enforced imperatively in the client planner (Task 4) — the schema deliberately does NOT use a discriminated union (Gemini can't constrain it; Ollama only softly).

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/handoff/schemas.test.ts (add)
import { scriptReviewSchema } from './schemas';
it('parses a flat review envelope of heterogeneous ops', () => {
  const r = scriptReviewSchema.safeParse({
    ops: [
      { id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' },
      { id: 2, op: 'merge', mergeIds: [2, 3], rationale: 'over-split' },
      { id: 4, op: 'fix_emotion', emotion: 'neutral', rationale: 'calm' },
    ],
  });
  expect(r.success).toBe(true);
});
it('rejects an unknown op', () => {
  expect(scriptReviewSchema.safeParse({ ops: [{ id: 1, op: 'rewrite', rationale: 'x' }] }).success).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm run test:server -- schemas.test.ts`

- [ ] **Step 3: Implement the schema**

```typescript
export const scriptReviewSchema = z
  .object({
    ops: z.array(
      z
        .object({
          id: z.number().int().positive(),
          op: z.enum(['strip_tag', 'split', 'extract_dialogue', 'merge', 'fix_emotion']),
          newText: z.string().optional(),
          anchor: z.string().optional(),
          pieceCharacterIds: z.array(z.string()).optional(),
          mergeIds: z.array(z.number().int().positive()).optional(),
          emotion: z.enum(EMOTIONS).optional(),
          rationale: z.string(),
          confidence: z.number().min(0).max(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ScriptReviewOp = z.infer<typeof scriptReviewSchema>['ops'][number];
export type ScriptReviewOutput = z.infer<typeof scriptReviewSchema>;
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm run test:server -- schemas.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts
git commit -m "feat(server): scriptReviewSchema (flat envelope) for the review pass"
```

### Task 7: Analyzer extension — `runScriptReviewChapter` (interface + both impls + fallback)

**Files:**
- Modify: `server/src/analyzer/index.ts` (interface method + `FallbackAnalyzer` delegation)
- Modify: `server/src/analyzer/gemini.ts` (impl + `SKILL_FILES` + `SkillName` + `SKILL_TO_PROMPT_ID`)
- Modify: `server/src/analyzer/ollama.ts` (impl)
- Modify: `server/src/handoff/protocol.ts` (`HandoffKey` += `` `review-ch${number}` ``)
- Modify: `server/src/config/registry.ts` (`prompt.scriptReview` knob, `isPrompt:true`)
- Create: `skills/audiobook-script-review.md` (the prompt)
- Test: `server/src/analyzer/script-review.test.ts` (mock the HTTP layer like the existing analyzer tests)

**Interfaces:**
- Produces: `Analyzer.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call): Promise<ScriptReviewOutput>`.

- [ ] **Step 1: Add the `HandoffKey` variant**

```typescript
// server/src/handoff/protocol.ts
export type HandoffKey =
  | '1' | `1-ch${number}` | '2' | `2-ch${number}`
  | `emotion-ch${number}`
  | `review-ch${number}`;
```

- [ ] **Step 2: Extend the `Analyzer` interface** (add after `runEmotionChapter`)

```typescript
// server/src/analyzer/index.ts
  runScriptReviewChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<ScriptReviewOutput>;
```

- [ ] **Step 3: Add the `FallbackAnalyzer` delegation** (copy the `runEmotionChapter` fallback verbatim, renamed)

```typescript
  async runScriptReviewChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<ScriptReviewOutput> {
    try {
      return await this.primary.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      if (err instanceof LocalUnreachableError) {
        return await this.fallback.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call);
      }
      throw err;
    }
  }
```

- [ ] **Step 4: Register the skill + prompt id (gemini.ts)** — add to `SKILL_FILES`: `script_review: 'audiobook-script-review.md',` and to `SKILL_TO_PROMPT_ID`: `script_review: 'prompt.scriptReview',`.

- [ ] **Step 5: Add the `prompt.scriptReview` registry knob** (registry.ts, mirror `prompt.emotionAnnotation`)

```typescript
{
  key: 'prompt.scriptReview', env: '', group: 'analyzer-prompts',
  label: 'Script review prompt',
  help: 'Skill sent to the analysis model for the LLM Script Review pass. Editing forks a local copy; live.',
  type: 'string', isPrompt: true,
  default: 'skills/audiobook-script-review.md', apply: 'live', risk: 'high',
},
```

- [ ] **Step 6: Add the impls** (gemini.ts and ollama.ts — identical bodies, mirror `runEmotionChapter`)

```typescript
  async runScriptReviewChapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<ScriptReviewOutput> {
    const key = `review-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'script_review', promptMd, scriptReviewSchema, scriptReviewSchema, call);
  }
```

- [ ] **Step 7: Write the prompt** `skills/audiobook-script-review.md` — instruct the model: given a chapter's attributed sentences + cast, return `{ ops: [...] }` for the 5 classes; **never strip intentional vocalizations** ("Ah!", "Haah…"); for `split`/`extract_dialogue` return a short **boundary-spanning `anchor`** substring (copy it verbatim from the sentence text) + `pieceCharacterIds`; for `merge` return `mergeIds` of adjacent same-speaker narrator sentences; for `fix_emotion` only when the current emotion is clearly wrong; always include a one-line `rationale`. Output JSON only.

- [ ] **Step 8: Write a failing impl test** (mock the chat/generate layer to return a canned envelope; assert the analyzer returns the parsed ops). Follow the existing `server/src/analyzer/*.test.ts` mocking pattern.

- [ ] **Step 9: Run → fail → (code already added) → pass.** Run: `npm run test:server -- script-review.test.ts`

- [ ] **Step 10: Commit**

```bash
git add server/src/analyzer/index.ts server/src/analyzer/gemini.ts server/src/analyzer/ollama.ts server/src/handoff/protocol.ts server/src/config/registry.ts skills/audiobook-script-review.md server/src/analyzer/script-review.test.ts
git commit -m "feat(server): runScriptReviewChapter analyzer pass (Ollama+Gemini+fallback)"
```

### Task 8: The SSE endpoint `POST /api/books/:bookId/script-review`

**Files:**
- Create: `server/src/routes/script-review.ts` (copy `annotate-emotion.ts` structure)
- Modify: `server/src/app.ts` (mount the router under `/api/books`, beside `annotateEmotionRouter`)
- Modify: `openapi.yaml` (add the path entry, mirroring the annotate-emotion path)
- Test: `server/src/routes/script-review.test.ts`

**Interfaces:**
- Consumes: `selectAnalyzerForPhase`, `loadPostFoldSentencesByChapter`, `runScriptReviewChapter`.
- Produces: SSE events `phase` / `ops` (`{ kind:'ops', chapterId, ops }`) / `throttle` / `chapter-failed` / `error` / `result`. Accepts `{ chapterId?: number, model?: string }` in the POST body.

- [ ] **Step 1: Write the failing route test** (supertest against the app; mock the analyzer to emit a canned envelope; assert the SSE stream contains an `ops` event and a `result`). Mirror `annotate-emotion.test.ts`.

- [ ] **Step 2: Run → fail.** Run: `npm run test:server -- script-review.test.ts`

- [ ] **Step 3: Implement the route** — copy `annotate-emotion.ts` verbatim, then: rename the router/path to `script-review`; honor an optional `req.body.chapterId` (filter `chapterIds` to `[chapterId]` when present); build the prompt from the chapter's post-fold sentences + the post-fold roster; call `runScriptReviewChapter`; emit `{ kind:'ops', chapterId, ops: result.ops }` instead of `annotation`. Keep the same SSE scaffolding, keep-alive, abort, `DailyQuotaExhaustedError` handling, and per-chapter `chapter-failed` resilience.

- [ ] **Step 4: Mount + openapi** — `app.use('/api/books', scriptReviewRouter);` (after annotate-emotion); add the `openapi.yaml` path block (copy annotate-emotion's, adjust path + request body `chapterId?`).

- [ ] **Step 5: Run → pass.** Run: `npm run test:server -- script-review.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/script-review.ts server/src/app.ts openapi.yaml server/src/routes/script-review.test.ts
git commit -m "feat(server): POST /api/books/:bookId/script-review SSE endpoint"
```

### Task 9: Frontend api client (`reviewScript`) — real + mock

**Files:**
- Modify: `src/lib/api.ts` (add `realReviewScript`, `mockReviewScript`, `ReviewScriptOpts`/`Result`/`Error`, register in both `real`/`mock`)
- Test: `src/lib/api.test.ts` (mock `fetch` streaming, mirror the detect-emotions test if present)

**Interfaces:**
- Produces: `api.reviewScript(bookId, { chapterId?, model?, signal?, onPhase?, onThrottle?, onOps? }): Promise<{ reviewedChapters: number; totalOps: number }>` where `onOps({ chapterId, ops })` delivers `ReviewOp[]`.

- [ ] **Step 1: Write the failing test** (mock a streamed SSE body with one `ops` + `result`; assert `onOps` fired and the result returned). Mirror `realDetectEmotions`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — copy `realDetectEmotions`/`mockDetectEmotions` verbatim; change the URL to `/script-review`; send `{ chapterId, model }`; handle `kind:'ops'` → `onOps`. Register `reviewScript: realReviewScript` / `reviewScript: mockReviewScript` in both api objects.

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): api.reviewScript client (real+mock)"
```

---

## Phase 3 — Operator UX

### Task 10: The dedicated suggestions slice (non-polled, bookId-keyed)

**Files:**
- Create: `src/store/script-review-slice.ts`
- Modify: `src/store/index.ts` (register `scriptReview: scriptReviewSlice.reducer`)
- Test: `src/store/script-review-slice.test.ts`

**Interfaces:**
- Produces: state `{ byBook: Record<string, { ops: ReviewOp[]; selected: Record<string, boolean>; unappliable: Array<{ op: ReviewOp; reason: string }> } | undefined> }`; actions `setReview({ bookId, ops, unappliable })`, `toggleOp({ bookId, key, on })`, `toggleClass({ bookId, op, on })`, `clearReview({ bookId })`; selector `selectActiveReview(state, bookId)` reads ONLY that book's bucket. (Op key = `${chapterId}:${id}:${op}`.)

- [ ] **Step 1: Write the failing test** — `setReview` then `selectActiveReview` returns only that book's ops; a second book's `setReview` doesn't wipe the first; `toggleClass` flips all ops of a class.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement the slice** (RTK `createSlice`, Immer; default-ON selection for all Unit A classes — initialize `selected[key] = true` in `setReview`).

- [ ] **Step 4: Register in `store/index.ts`** under the reducer map (beside `revisions`).

- [ ] **Step 5: Run → pass.**

- [ ] **Step 6: Commit**

```bash
git add src/store/script-review-slice.ts src/store/index.ts src/store/script-review-slice.test.ts
git commit -m "feat(frontend): dedicated non-polled script-review suggestions slice"
```

### Task 11: `ScriptReviewDiff` modal + the "Review Script" trigger

**Files:**
- Create: `src/components/script-review-diff.tsx`
- Modify: the manuscript editing surface (`src/views/manuscript.tsx`) — add the "Review Script" button + the run/stream wiring (calls `api.reviewScript`, runs `planApply` on completion, dispatches `setReview`)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: `selectActiveReview`, `scriptReviewActions`, `dispatchAcceptedOps`, `planApply`, `manuscriptActions`, `changeLogActions.bumpBoundaryMove`.
- Behaviour: groups rows by class; per-class + per-change toggles; before→after preview; `Apply` runs `planApply` against the LIVE manuscript (re-validates at accept — TOCTOU), `dispatchAcceptedOps` for the selected appliable set, emits `bumpBoundaryMove` per affected chapter, then `clearReview`.

- [ ] **Step 1: Write the failing component test** — render with a seeded review (one `strip_tag`, one `fix_emotion`), toggle one off, click Apply, assert the expected reducer actions dispatched (spy the store) and the modal cleared.

- [ ] **Step 2: Run → fail.** Run: `npm test -- src/components/script-review-diff.test.tsx`

- [ ] **Step 3: Implement the modal** — follow the DriftReport accept-reject layout pattern; use design tokens (no hex). On Apply: `const { appliable } = planApply(selectedOps, liveSentences); dispatchAcceptedOps(dispatch, appliable, liveSentences, { onBoundaryMove: (c) => dispatch(changeLogActions.bumpBoundaryMove({ chapterId: c, count: 1 })) }); dispatch(scriptReviewActions.clearReview({ bookId }));`

- [ ] **Step 4: Add the "Review Script" button** to `manuscript.tsx` — min-h-[44px] sm:min-h-0 touch target; on click, stream `api.reviewScript(bookId, { chapterId: currentChapterId, onOps })`, accumulate ops, then `planApply` + `dispatch(setReview(...))` to open the modal.

- [ ] **Step 5: Run → pass.**

- [ ] **Step 6: Commit**

```bash
git add src/components/script-review-diff.tsx src/views/manuscript.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): ScriptReviewDiff modal + Review Script trigger"
```

### Task 12: E2E — per-chapter review → accept → stale

**Files:**
- Create: `e2e/script-review.spec.ts`
- Modify: `e2e/responsive/coverage.spec.ts` (append a case for the new modal)
- (mock-mode driven: `mockReviewScript` returns a deterministic op so the flow is testable without an LLM)

- [ ] **Step 1: Write the spec** — open a book to the manuscript view, click "Review Script", assert the `ScriptReviewDiff` modal opens with the mock op, accept it, assert the sentence text/emotion updated and (navigating to Generate) the chapter shows the stale badge.

- [ ] **Step 2: Run** — `npm run test:e2e -- script-review.spec.ts`. Expected: PASS (chromium).

- [ ] **Step 3: Commit**

```bash
git add e2e/script-review.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): script-review per-chapter accept flow"
```

### Task 13: Full verify + plan/index hygiene

- [ ] **Step 1:** Run `npm run verify` (typecheck + all tests + e2e + build). Fix any red leg in-scope; surface anything pre-existing to the user rather than bundling.
- [ ] **Step 2:** Move the spec to `status: active`/`stable` per the project's shipping checklist; add the spec/plan to `docs/features/INDEX.md` if it's tracked there. Fill the spec's Ship notes when merged.
- [ ] **Step 3:** Open the PR with `Closes #998` (Unit A scope), `## Summary` + `## Test plan` filled, linking the spec.

---

## Self-Review (completed by plan author)

**Spec coverage:** every §3 class has an apply path (Task 1 `strip_tag`; Task 4/5 `split`/`extract`; Task 2 `merge`; existing `setSentenceEmotion` `fix_emotion`); §5.3 unified staleness = Task 3; §5.6 op-validation/TOCTOU = Task 4; §4.2 ~16-site pass = Tasks 6-9; §4.3 flat-envelope = Task 6; §5.5 dedicated slice = Task 10; §6 UX = Task 11; §8 tests distributed per task (merge-resurrection = Task 2; staleness gaps = Task 3; anchor normalization + TOCTOU = Task 4; M5 abstention = Task 7 prompt + a Task-7 test; E2E = Task 12); §9 follow-ups = Task 0. **No api-types regen** (Global Constraints) — Unit A persists no new type.

**Placeholder scan:** the prompt content (Task 7 Step 7) and the openapi block (Task 8 Step 4) are described, not transcribed verbatim — these are content-authoring steps, not code with a fixed answer; every code step shows real code.

**Type consistency:** `ReviewOp` (frontend, Task 4) and `ScriptReviewOp` (server Zod, Task 6) carry the same fields; `setSentenceText` / `mergeSentences` / `setSentenceEmotion` / `splitSentence` payloads match the reducers; `isChapterStaleSinceRender` signature is consistent across Tasks 3's definition and `generation.tsx` use.
