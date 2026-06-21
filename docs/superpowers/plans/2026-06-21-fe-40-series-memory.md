# fe-40 Series Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface and prove Castwright's series-memory moat — a library chip + per-book sparkline, a reveal panel, and a shareable card + JSON — driven by a new server-side per-series "carried characters" derivation.

**Architecture:** A pure derivation (`server/src/workspace/series-memory.ts`) assembles **carried characters** (a cast member who held the same `voiceId` across ≥2 confirmed books, identity via the persisted `matchedFrom` links) from a normalized per-book character input. `scanLibrary` attaches a lightweight `seriesMemory` *summary* to each `LibrarySeries` for the chip + sparkline; a new detail endpoint returns the full roster for the reveal + JSON export. Frontend renders three surfaces off that data.

**Tech Stack:** Node 20 + Express + Vitest (server), Vite + React 18 + Redux Toolkit + Vitest/RTL + Playwright (frontend), OpenAPI as the contract.

**Spec:** `docs/superpowers/specs/2026-06-21-fe-40-series-memory-design.md` — read it before starting.

## Global Constraints

_Copied verbatim from the spec. Every task's requirements implicitly include this section._

- **Unit = carried *characters*** (not voiceIds). `N` = how many cast members kept their voice. Chip number == reveal row count == `N`. The card's hero number is `D` (designed count), a subset of `N`.
- **Carried predicate:** a character is carried iff they appear in **≥ 2 books** of the series AND hold the **same `voiceId` in every book in which they appear**. Identity across books is via the persisted `matchedFrom` links (never an `id`/`voiceId` shortcut — character `id` is per-book; voices are shared across characters).
- **Confirmed casts only** (`castConfirmed === true`); analysing/cast_pending books never count.
- **`voiceKind ∈ {designed, cloned, preset}`**: Qwen→`designed`, XTTS/Coqui-clone→`cloned`, Kokoro/Gemini→`preset`. Bespoke = designed + cloned.
- **Marker threshold:** show only when **≥ 3 carried characters** across **≥ 3 confirmed books**, **including ≥ 1 bespoke** carried character. Below threshold → server omits `seriesMemory`; frontend renders nothing.
- **Book numbering:** `index` 1..M by the library's existing sort (`seriesPosition ?? 0`, then title) — never trust raw `seriesPosition`. Books keyed by durable `bookId`.
- **`spanBooks`** = count of confirmed books containing ≥1 carried character. In-app surfaces (chip + reveal) use `M` (series length); exported artifacts (card + JSON) use `spanBooks`.
- **`carriedFullSpan`** ≔ present in *every* confirmed book of the series (1..M, no gap). Late joiner or mid-series gap → `false`.
- **Copy / brand rules:** no catalogue slugs (`bf_emma`) in any user-facing surface — JSON only; voice label is `describeVoice()` output; **no engine name** ("Kokoro"/"Qwen") in the reveal. Marker glyph is the **Castwave** mark, never a sparkle. Ownership via "yours", never "you cast". Brand gradient `magenta → peach`; Lora for numbers/headlines/names, General Sans for frame text. Brand tokens only — no hex literals in component code. Card branding (wordmark + `castwright.ai`) is **mandatory and non-removable**.
- **Testing discipline:** every behaviour ships a paired test; UI crossing router/redux/layout seams ships a Playwright spec; never `.skip` without a follow-up.

---

## File Structure

**Server (new):**
- `server/src/workspace/voice-kind.ts` — pure: engine + override → `voiceKind`.
- `server/src/workspace/series-memory.ts` — pure: normalized inputs → `SeriesMemoryDetail | null` + `summarize()`.
- `server/src/workspace/series-memory.test.ts`, `voice-kind.test.ts` — colocated tests.
- `server/src/routes/series-memory.ts` — `GET /api/library/series-memory` (detail).

**Server (modify):**
- `server/src/workspace/scan.ts` — attach `seriesMemory` summary in `scanLibrary`.
- `server/src/server.ts` (or the router index) — mount the new route.
- `openapi.yaml` — `SeriesMemorySummary`, `SeriesMemoryDetail`, `CarriedCharacter` schemas; attach summary to `LibrarySeries`.

**Frontend (new):**
- `src/components/series-memory/series-memory-chip.tsx` (+ test)
- `src/components/series-memory/series-sparkline.tsx` (+ test)
- `src/components/series-memory/series-memory-reveal.tsx` (+ test)
- `src/components/series-memory/series-share-card.tsx` (+ test)
- `src/lib/castwave-glyph.tsx` — the brand waveform mark as an inline SVG component.

**Frontend (modify):**
- `src/lib/types.ts` — `SeriesMemorySummary`, `SeriesMemoryDetail`, `CarriedCharacter`; `seriesMemory?` on `LibrarySeries`.
- `src/components/library/library-grid.tsx:90-99` — render chip + sparkline in the series header.
- `src/lib/api.ts` — `getSeriesMemory(author, series)` real + mock.
- `src/lib/api-types.ts` — regenerated.
- `e2e/responsive/coverage.spec.ts` + a new `e2e/series-memory.spec.ts`.
- `src/mocks/` — library fixture gains a `seriesMemory` series + the detail mock.

---

## Task 1: `voiceKind` helper (pure)

**Files:**
- Create: `server/src/workspace/voice-kind.ts`
- Test: `server/src/workspace/voice-kind.test.ts`

**Interfaces:**
- Consumes: `TtsEngine` from `../tts/types` (the union `'kokoro'|'qwen'|'coqui'|'gemini'`).
- Produces: `export type VoiceKind = 'designed' | 'cloned' | 'preset';` and `export function voiceKindFor(engine: TtsEngine | null | undefined, opts?: { cloned?: boolean }): VoiceKind` — Qwen→`designed`; Coqui→`cloned` when `opts.cloned`, else `preset`; everything else→`preset`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/workspace/voice-kind.test.ts
import { describe, it, expect } from 'vitest';
import { voiceKindFor } from './voice-kind.js';

describe('voiceKindFor', () => {
  it('maps qwen to designed', () => {
    expect(voiceKindFor('qwen')).toBe('designed');
  });
  it('maps a cloned coqui voice to cloned, a preset coqui to preset', () => {
    expect(voiceKindFor('coqui', { cloned: true })).toBe('cloned');
    expect(voiceKindFor('coqui')).toBe('preset');
  });
  it('maps kokoro and gemini to preset', () => {
    expect(voiceKindFor('kokoro')).toBe('preset');
    expect(voiceKindFor('gemini')).toBe('preset');
  });
  it('defaults null/undefined to preset', () => {
    expect(voiceKindFor(null)).toBe('preset');
    expect(voiceKindFor(undefined)).toBe('preset');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/voice-kind.test.ts`
Expected: FAIL — "Cannot find module './voice-kind.js'".

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/workspace/voice-kind.ts
import type { TtsEngine } from '../tts/types.js';

export type VoiceKind = 'designed' | 'cloned' | 'preset';

/** Designed (Qwen, bespoke per character) and cloned (Coqui/XTTS from a
    reference sample) are "bespoke" — the moat. Catalogue presets (Kokoro,
    Gemini) are not. Coqui defaults to preset unless the caller knows the
    voice came from a clone (a reference sample), signalled via opts.cloned. */
export function voiceKindFor(
  engine: TtsEngine | null | undefined,
  opts: { cloned?: boolean } = {},
): VoiceKind {
  if (engine === 'qwen') return 'designed';
  if (engine === 'coqui') return opts.cloned ? 'cloned' : 'preset';
  return 'preset';
}
```

> Note: confirm the import path/spelling of `TtsEngine` (search `export type TtsEngine` under `server/src/tts/`). If the union lives elsewhere, fix the import only.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/voice-kind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/voice-kind.ts server/src/workspace/voice-kind.test.ts
git commit -m "feat(server): voiceKind helper for series-memory bespoke split"
```

---

## Task 2: `series-memory` pure derivation core

**Files:**
- Create: `server/src/workspace/series-memory.ts`
- Test: `server/src/workspace/series-memory.test.ts`

**Interfaces:**
- Consumes: `VoiceKind` from `./voice-kind` (Task 1).
- Produces:

```typescript
export interface SeriesCharacterInput {
  characterId: string;            // per-book id (unstable across books)
  name: string;
  aliases: string[];
  voiceId: string | null;
  voiceLabel: string;             // describeVoice() output — never a slug
  engine: string | null;
  voiceKind: VoiceKind;
  isPrincipal: boolean;           // above the line-count floor (Task 3 decides)
  matchedFrom: { bookId?: string; characterId?: string } | null;
}
export interface SeriesBookInput {
  bookId: string;
  index: number;                  // 1..M library-sort order
  title: string;
  characters: SeriesCharacterInput[];
}
export interface CarriedCharacter {
  character: string; aliases: string[];
  voiceId: string; voiceLabel: string; engine: string | null; voiceKind: VoiceKind;
  firstBookId: string; lastBookId: string; bookIndices: number[];
  carriedFullSpan: boolean;
}
export interface SeriesMemorySummary {
  carriedCount: number; bespokeCount: number; designedCount: number; spanBooks: number;
  perBook: Array<{ bookId: string; index: number; principalCount: number; carriedPresent: number }>;
}
export interface SeriesMemoryDetail {
  series: { confirmedBookCount: number; spanBooks: number;
    books: Array<{ bookId: string; title: string; index: number; principalCount: number }> };
  carried: { count: number; bespokeCount: number; designedCount: number; characters: CarriedCharacter[] };
}
// `books` MUST be the CONFIRMED-cast set for the series, numbered 1..M by
// library sort (the caller guarantees this — Task 3). Returns null when below
// the marker threshold (≥3 carried characters, ≥3 books, ≥1 bespoke).
export function deriveSeriesMemory(books: SeriesBookInput[]): SeriesMemoryDetail | null;
export function summarize(detail: SeriesMemoryDetail): SeriesMemorySummary;
```

- [ ] **Step 1: Write the failing tests (the hard cases)**

```typescript
// server/src/workspace/series-memory.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSeriesMemory, summarize, type SeriesBookInput, type SeriesCharacterInput } from './series-memory.js';

const ch = (o: Partial<SeriesCharacterInput> & { characterId: string }): SeriesCharacterInput => ({
  name: o.name ?? o.characterId, aliases: [], voiceId: null, voiceLabel: 'Designed voice',
  engine: 'qwen', voiceKind: 'designed', isPrincipal: true, matchedFrom: null, ...o,
});
// A 3-book series: 3 designed principals carried 1->3; one preset principal carried; one late joiner.
function baseBooks(): SeriesBookInput[] {
  return [
    { bookId: 'b1', index: 1, title: 'One', characters: [
      ch({ characterId: 'b1-marrow', name: 'Marrow', voiceId: 'v_q_marrow' }),
      ch({ characterId: 'b1-edda', name: 'Edda', voiceId: 'v_q_edda' }),
      ch({ characterId: 'b1-vale', name: 'Vale', voiceId: 'v_q_vale' }),
      ch({ characterId: 'b1-narr', name: 'Narrator', voiceId: 'v_kok_emma', engine: 'kokoro', voiceKind: 'preset' }),
    ] },
    { bookId: 'b2', index: 2, title: 'Two', characters: [
      ch({ characterId: 'b2-marrow', name: 'Marrow', voiceId: 'v_q_marrow', matchedFrom: { bookId: 'b1', characterId: 'b1-marrow' } }),
      ch({ characterId: 'b2-edda', name: 'Edda', voiceId: 'v_q_edda', matchedFrom: { bookId: 'b1', characterId: 'b1-edda' } }),
      ch({ characterId: 'b2-vale', name: 'Vale', voiceId: 'v_q_vale', matchedFrom: { bookId: 'b1', characterId: 'b1-vale' } }),
      ch({ characterId: 'b2-narr', name: 'Narrator', voiceId: 'v_kok_emma', engine: 'kokoro', voiceKind: 'preset', matchedFrom: { bookId: 'b1', characterId: 'b1-narr' } }),
      ch({ characterId: 'b2-sela', name: 'Sela', voiceId: 'v_q_sela' }), // late joiner (no prior)
    ] },
    { bookId: 'b3', index: 3, title: 'Three', characters: [
      ch({ characterId: 'b3-marrow', name: 'Marrow', voiceId: 'v_q_marrow', matchedFrom: { bookId: 'b2', characterId: 'b2-marrow' } }),
      ch({ characterId: 'b3-edda', name: 'Edda', voiceId: 'v_q_edda', matchedFrom: { bookId: 'b2', characterId: 'b2-edda' } }),
      ch({ characterId: 'b3-vale', name: 'Vale', voiceId: 'v_q_vale', matchedFrom: { bookId: 'b2', characterId: 'b2-vale' } }),
      ch({ characterId: 'b3-narr', name: 'Narrator', voiceId: 'v_kok_emma', engine: 'kokoro', voiceKind: 'preset', matchedFrom: { bookId: 'b2', characterId: 'b2-narr' } }),
      ch({ characterId: 'b3-sela', name: 'Sela', voiceId: 'v_q_sela', matchedFrom: { bookId: 'b2', characterId: 'b2-sela' } }),
    ] },
  ];
}

describe('deriveSeriesMemory', () => {
  it('counts carried characters, not voiceIds, and reports bespoke/designed', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    expect(d).not.toBeNull();
    // Marrow, Edda, Vale (designed, full span), Narrator (preset, full span), Sela (designed, joined Bk2)
    expect(d.carried.count).toBe(5);
    expect(d.carried.designedCount).toBe(4); // Marrow,Edda,Vale,Sela
    expect(d.carried.bespokeCount).toBe(4);
    const marrow = d.carried.characters.find((c) => c.character === 'Marrow')!;
    expect(marrow.carriedFullSpan).toBe(true);
    expect(marrow.bookIndices).toEqual([1, 2, 3]);
    const sela = d.carried.characters.find((c) => c.character === 'Sela')!;
    expect(sela.carriedFullSpan).toBe(false); // joined Bk2
    expect(sela.firstBookId).toBe('b2');
  });

  it('treats two different characters sharing one preset voice as TWO carried, not one', () => {
    const books = baseBooks();
    // Add a second character on the SAME kokoro voice as Narrator, carried across all 3.
    for (const b of books) b.characters.push(ch({
      characterId: `${b.bookId}-guard`, name: 'Guard', voiceId: 'v_kok_emma',
      engine: 'kokoro', voiceKind: 'preset',
      matchedFrom: b.index === 1 ? null : { bookId: books[b.index - 2].bookId, characterId: `${books[b.index - 2].bookId}-guard` },
    }));
    const d = deriveSeriesMemory(books)!;
    expect(d.carried.count).toBe(6); // Narrator AND Guard both count
  });

  it('excludes a character re-cast mid-series (voiceId changed)', () => {
    const books = baseBooks();
    books[2].characters.find((c) => c.characterId === 'b3-vale')!.voiceId = 'v_q_vale_RECAST';
    const d = deriveSeriesMemory(books)!;
    expect(d.carried.characters.find((c) => c.character === 'Vale')).toBeUndefined();
    expect(d.carried.count).toBe(4);
  });

  it('returns null below threshold (no bespoke carry)', () => {
    // All-preset carried cast → no markers even if many carried.
    const books = baseBooks().map((b) => ({ ...b, characters: b.characters.map((c) => ({ ...c, engine: 'kokoro', voiceKind: 'preset' as const })) }));
    expect(deriveSeriesMemory(books)).toBeNull();
  });

  it('returns null below threshold (fewer than 3 books)', () => {
    expect(deriveSeriesMemory(baseBooks().slice(0, 2))).toBeNull();
  });

  it('summarize() reports per-book carriedPresent rising as joiners arrive', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    const s = summarize(d);
    expect(s.carriedCount).toBe(5);
    expect(s.perBook.find((p) => p.index === 1)!.carriedPresent).toBe(4); // Sela not yet
    expect(s.perBook.find((p) => p.index === 2)!.carriedPresent).toBe(5);
    expect(s.spanBooks).toBe(3);
  });

  it('handles a mid-series GAP (present 1 and 3, absent 2) → carried, not full span', () => {
    const books = baseBooks();
    // Remove Vale from book 2; book-3 Vale matchedFrom skips to book 1.
    books[1].characters = books[1].characters.filter((c) => c.characterId !== 'b2-vale');
    books[2].characters.find((c) => c.characterId === 'b3-vale')!.matchedFrom = { bookId: 'b1', characterId: 'b1-vale' };
    const d = deriveSeriesMemory(books)!;
    const vale = d.carried.characters.find((c) => c.character === 'Vale')!;
    expect(vale.bookIndices).toEqual([1, 3]);
    expect(vale.carriedFullSpan).toBe(false);
  });

  it('renamed-via-alias collapses to ONE carried row with the latest name + aliases', () => {
    const books = baseBooks();
    // Marrow is revealed as "The Warden" in book 3 (same voiceId, alias carries old name).
    const b3m = books[2].characters.find((c) => c.characterId === 'b3-marrow')!;
    b3m.name = 'The Warden'; b3m.aliases = ['Marrow'];
    const d = deriveSeriesMemory(books)!;
    const rows = d.carried.characters.filter((c) => c.voiceId === 'v_q_marrow');
    expect(rows).toHaveLength(1);              // one character, not two
    expect(rows[0].character).toBe('The Warden'); // canonical = latest
    expect(rows[0].aliases).toContain('Marrow');
  });

  it('chip N equals reveal row count (summarize.carriedCount === characters.length)', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    expect(summarize(d).carriedCount).toBe(d.carried.characters.length);
  });

  it('sorts bespoke (designed/cloned) rows above preset rows', () => {
    const d = deriveSeriesMemory(baseBooks())!;
    const lastBespokeIdx = d.carried.characters.map((c) => c.voiceKind !== 'preset').lastIndexOf(true);
    const firstPresetIdx = d.carried.characters.findIndex((c) => c.voiceKind === 'preset');
    expect(firstPresetIdx).toBeGreaterThan(lastBespokeIdx); // all bespoke before any preset
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/workspace/series-memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/workspace/series-memory.ts
import type { VoiceKind } from './voice-kind.js';

export interface SeriesCharacterInput {
  characterId: string; name: string; aliases: string[];
  voiceId: string | null; voiceLabel: string; engine: string | null;
  voiceKind: VoiceKind; isPrincipal: boolean;
  matchedFrom: { bookId?: string; characterId?: string } | null;
}
export interface SeriesBookInput { bookId: string; index: number; title: string; characters: SeriesCharacterInput[]; }
export interface CarriedCharacter {
  character: string; aliases: string[]; voiceId: string; voiceLabel: string;
  engine: string | null; voiceKind: VoiceKind;
  firstBookId: string; lastBookId: string; bookIndices: number[]; carriedFullSpan: boolean;
}
export interface SeriesMemorySummary {
  carriedCount: number; bespokeCount: number; designedCount: number; spanBooks: number;
  perBook: Array<{ bookId: string; index: number; principalCount: number; carriedPresent: number }>;
}
export interface SeriesMemoryDetail {
  series: { confirmedBookCount: number; spanBooks: number;
    books: Array<{ bookId: string; title: string; index: number; principalCount: number }> };
  carried: { count: number; bespokeCount: number; designedCount: number; characters: CarriedCharacter[] };
}

const MIN_CARRIED = 3;
const MIN_BOOKS = 3;

interface Appearance { book: SeriesBookInput; ch: SeriesCharacterInput; }

/** Walk newest→oldest, chaining matchedFrom into per-character appearance
    chains. A chain's head is a character with no incoming match in a LATER
    book; we reconstruct by following matchedFrom backward from each book. */
export function deriveSeriesMemory(books: SeriesBookInput[]): SeriesMemoryDetail | null {
  if (books.length < MIN_BOOKS) return null;
  const ordered = [...books].sort((a, b) => a.index - b.index);

  // Index every appearance by bookId::characterId.
  const byKey = new Map<string, Appearance>();
  for (const book of ordered) for (const ch of book.characters) byKey.set(`${book.bookId}::${ch.characterId}`, { book, ch });

  // `matchedFrom` points BACKWARD (a newer character → its older self). The set
  // of pointed-at keys are chain interiors/heads; the appearances NOT pointed at
  // are chain TAILS (the latest appearance). We start from each tail and walk
  // BACKWARD by following matchedFrom — this is the fix for the wrong-direction
  // walk: a forward walk from a tail goes nowhere.
  const pointedAt = new Set<string>();
  for (const book of ordered) for (const ch of book.characters) {
    if (ch.matchedFrom?.bookId && ch.matchedFrom?.characterId)
      pointedAt.add(`${ch.matchedFrom.bookId}::${ch.matchedFrom.characterId}`);
  }

  const carried: CarriedCharacter[] = [];
  for (const [key, tail] of byKey) {
    if (pointedAt.has(key)) continue; // keep only chain tails (latest appearance)
    const chain: Appearance[] = [tail];
    let cur = tail;
    while (cur.ch.matchedFrom?.bookId && cur.ch.matchedFrom?.characterId) {
      const prev = byKey.get(`${cur.ch.matchedFrom.bookId}::${cur.ch.matchedFrom.characterId}`);
      if (!prev) break;
      chain.push(prev); cur = prev;
    }
    if (chain.length < 2) continue; // appears in <2 books → not carried
    const voiceIds = new Set(chain.map((a) => a.ch.voiceId ?? ''));
    if (voiceIds.size !== 1 || voiceIds.has('')) continue; // voice changed/missing → not carried
    // Order explicitly by book index — DON'T rely on chain push-order (it's
    // tail→head). Earliest = first book, latest = canonical name/voice.
    const byIndex = [...chain].sort((a, b) => a.book.index - b.book.index);
    const earliest = byIndex[0], latest = byIndex[byIndex.length - 1].ch;
    const indices = byIndex.map((a) => a.book.index);
    // carriedFullSpan: present in EVERY confirmed book 1..M (no gap). `ordered`
    // is the confirmed set by contract.
    const fullSpan = indices.length === ordered.length &&
      indices.every((v, i) => v === ordered[i].index);
    carried.push({
      character: latest.name, aliases: latest.aliases,
      voiceId: latest.voiceId as string, voiceLabel: latest.voiceLabel,
      engine: latest.engine, voiceKind: latest.voiceKind,
      firstBookId: earliest.book.bookId, lastBookId: byIndex[byIndex.length - 1].book.bookId,
      bookIndices: indices, carriedFullSpan: fullSpan,
    });
  }

  const bespokeCount = carried.filter((c) => c.voiceKind !== 'preset').length;
  if (carried.length < MIN_CARRIED || bespokeCount < 1) return null;

  const designedCount = carried.filter((c) => c.voiceKind === 'designed').length;
  const carriedIndices = new Set(carried.flatMap((c) => c.bookIndices));
  const spanBooks = ordered.filter((b) => carriedIndices.has(b.index)).length;
  // bespoke first, then by first appearance, then name — the reveal/card sort.
  carried.sort((a, b) =>
    Number(b.voiceKind !== 'preset') - Number(a.voiceKind !== 'preset') ||
    a.bookIndices[0] - b.bookIndices[0] || a.character.localeCompare(b.character));

  return {
    series: {
      confirmedBookCount: ordered.length, spanBooks,
      books: ordered.map((b) => ({ bookId: b.bookId, title: b.title, index: b.index,
        principalCount: b.characters.filter((c) => c.isPrincipal).length })),
    },
    carried: { count: carried.length, bespokeCount, designedCount, characters: carried },
  };
}

export function summarize(detail: SeriesMemoryDetail): SeriesMemorySummary {
  const carriedByIndex = new Map<number, number>();
  for (const c of detail.carried.characters) for (const i of c.bookIndices)
    carriedByIndex.set(i, (carriedByIndex.get(i) ?? 0) + 1);
  return {
    carriedCount: detail.carried.count, bespokeCount: detail.carried.bespokeCount,
    designedCount: detail.carried.designedCount, spanBooks: detail.series.spanBooks,
    perBook: detail.series.books.map((b) => ({ bookId: b.bookId, index: b.index,
      principalCount: b.principalCount, carriedPresent: carriedByIndex.get(b.index) ?? 0 })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/workspace/series-memory.test.ts`
Expected: PASS (6 tests). If the "shared preset voice" test fails, the bug is grouping by voiceId instead of by chain — re-check that chains are built from `matchedFrom`, not from `voiceId`.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/series-memory.ts server/src/workspace/series-memory.test.ts
git commit -m "feat(server): carried-character series-memory derivation (pure core)"
```

---

## Task 3: Wire series-memory into `scanLibrary`

**Files:**
- Modify: `server/src/workspace/scan.ts` (add `seriesMemory` to the series grouping; read cast.json per book for inputs)
- Modify: `server/src/lib/types.ts` equivalent server type if the scan output type lives in scan.ts (it does — `LibraryBook`/`LibraryResponse` near line 241). Add `seriesMemory?` to the series shape.
- Test: `server/src/workspace/series-memory-scan.test.ts`

**Interfaces:**
- Consumes: `deriveSeriesMemory`, `summarize` (Task 2); `voiceKindFor` (Task 1); `describeVoice` from `../tts/voice-mapping.js`.
- Produces: each series object in `LibraryResponse` gains `seriesMemory?: SeriesMemorySummary | null` (present only above threshold).

**Implementation notes (read first):**
- `scanLibrary` (scan.ts:589) builds `authors → series → books`. After the books for a series are collected and **sorted into the library order**, assign each an `index` (1..M over confirmed books only), read each confirmed book's `cast.json` once, map characters to `SeriesCharacterInput`, call `deriveSeriesMemory`, then `summarize`, and attach to the series.
- **`isPrincipal`**: a character is a principal when its line count ≥ `PRINCIPAL_LINE_FLOOR` (define `const PRINCIPAL_LINE_FLOOR = 5;`). Read the line count from the cast character — confirm the field name in `cast.json` (the `CastCharacter` carries a `lines` field; check whether it is an array (use `.length`) or a number). Walk-ons below the floor are excluded from the sparkline denominator but a carried character is still carried regardless of principal status.
- **`voiceLabel`**: `describeVoice(engine, name)` where `engine = ch.ttsEngine ?? <run default>` and `name = ch.overrideTtsVoices?.[engine]?.name ?? <resolved voice name>`. Reuse whatever resolves the per-character display voice today (search for existing `describeVoice(` call sites).
- **`voiceKind`**: `voiceKindFor(engine, { cloned: <coqui-from-sample?> })`. If there is no reliable "this coqui voice is a clone" signal yet, pass `cloned: false` (so Coqui→preset) and note it: cloned detection is a refinement, designed (Qwen) is the headline case anyway.
- Only `castConfirmed === true` books contribute (the scan already knows each book's `castConfirmed`/status).

- [ ] **Step 1: Write the failing integration test**

```typescript
// server/src/workspace/series-memory-scan.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bootstrap a temp workspace with a 3-book confirmed series whose 3 Qwen
// principals carry across all books, then assert scanLibrary attaches a
// seriesMemory summary to that series. Follow the temp-workspace pattern in
// server/src/workspace/active-analyses.test.ts (mkdtemp + state.json + cast.json
// per book + module reimport pointing WORKSPACE_ROOT at the temp dir).

let scanLibrary: typeof import('./scan.js').scanLibrary;
let root: string;

function writeBook(author: string, series: string, title: string, pos: number, chars: unknown[]) {
  const dir = join(root, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.txt'), 'x');
  writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({
    title, author, series, seriesPosition: pos, isStandalone: false, castConfirmed: true,
    manuscriptFile: 'manuscript.txt', chapters: [{ id: 1, title: 'C1', slug: 'c1' }],
    coverGradient: ['#000', '#fff'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  }));
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'fe40-'));
  process.env.WORKSPACE_ROOT = root; // confirm the env var name the scan uses (search scan.ts/paths.ts)
  const c = (id: string, name: string, vid: string, from?: { bookId: string; characterId: string }) =>
    ({ id, name, voiceId: vid, ttsEngine: 'qwen', lines: Array(20).fill({}), matchedFrom: from ?? null });
  writeBook('Kell', 'Ninth House', 'One', 1, [c('marrow', 'Marrow', 'vqm'), c('edda', 'Edda', 'vqe'), c('vale', 'Vale', 'vqv')]);
  writeBook('Kell', 'Ninth House', 'Two', 2, [c('marrow', 'Marrow', 'vqm'), c('edda', 'Edda', 'vqe'), c('vale', 'Vale', 'vqv')]);
  writeBook('Kell', 'Ninth House', 'Three', 3, [c('marrow', 'Marrow', 'vqm'), c('edda', 'Edda', 'vqe'), c('vale', 'Vale', 'vqv')]);
  scanLibrary = (await import('./scan.js')).scanLibrary;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scanLibrary + series-memory', () => {
  it('attaches a seriesMemory summary to a carried series', async () => {
    const lib = await scanLibrary();
    const series = lib.authors.flatMap((a) => a.series).find((s) => s.name === 'Ninth House')!;
    expect(series.seriesMemory).toBeTruthy();
    expect(series.seriesMemory!.carriedCount).toBe(3);
    expect(series.seriesMemory!.designedCount).toBe(3);
    expect(series.seriesMemory!.spanBooks).toBe(3);
  });
});
```

> If the scan reads the workspace root from a different mechanism than `WORKSPACE_ROOT` (check `server/src/workspace/paths.ts`), set it the way `active-analyses.test.ts` does instead.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/workspace/series-memory-scan.test.ts`
Expected: FAIL — `series.seriesMemory` is `undefined`.

- [ ] **Step 3: Implement the wiring in `scan.ts`**

**First, export `describeVoice`** — it is currently declared *unexported* at `server/src/tts/voice-mapping.ts:320`. Add the keyword:

```typescript
export function describeVoice(engine: TtsEngine, name: string): string {  // was: function describeVoice(
```

Add near the other workspace imports in `scan.ts`. **The path/JSON helpers live in `./paths.js`, NOT in scan.ts** — `scan.ts` already imports from `paths.js` (line 11); reuse `castJsonPath` + the existing `readJson` and the book-dir builder from there (confirm the exact exported names in `paths.ts`):

```typescript
import { deriveSeriesMemory, summarize, type SeriesBookInput, type SeriesCharacterInput } from './series-memory.js';
import { voiceKindFor } from './voice-kind.js';
import { describeVoice } from '../tts/voice-mapping.js';
import { castJsonPath, readJson, bookDir } from './paths.js'; // use the real exported names from paths.ts
const PRINCIPAL_LINE_FLOOR = 5;
```

**Define `buildSeriesInputs` as an exported function** (Task 4's route reuses it — it must be a real export, not inline). It maps the series' confirmed books → `SeriesBookInput[]` with library-sort indices:

```typescript
interface CastCharForMemory {
  id: string; name?: string; aliases?: string[]; voiceId?: string;
  ttsEngine?: string | null;
  overrideTtsVoices?: Record<string, { name: string }> | null;
  lines?: unknown[] | number;
  matchedFrom?: { bookId?: string; characterId?: string } | null;
}

async function readCastForMemory(author: string, series: string, title: string): Promise<CastCharForMemory[]> {
  try {
    const json = await readJson<{ characters?: CastCharForMemory[] }>(castJsonPath(bookDir(author, series, title)));
    return json?.characters ?? [];
  } catch { return []; }
}

/** Confirmed-only, library-sorted SeriesBookInput[] for one series. Exported so
    the detail route (Task 4) reuses the exact same assembly as the library scan. */
export async function buildSeriesInputs(author: string, series: string): Promise<SeriesBookInput[]> {
  // Reuse scanBook to get each book's metadata+status, then keep confirmed only,
  // sort into library order, and read each cast.json once.
  const books = (await scanSeriesBooks(author, series)) // small helper: maps listDirs(titles) → scanBook, filters nulls
    .filter((b) => b.status === 'complete' || b.status === 'generating'); // castConfirmed statuses (NOT not_analysed/analysing/cast_pending)
  books.sort((a, b) => (a.seriesPosition ?? 0) - (b.seriesPosition ?? 0) || a.title.localeCompare(b.title));
  const inputs: SeriesBookInput[] = [];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const cast = await readCastForMemory(b.author, b.series, b.title);
    inputs.push({
      bookId: b.bookId, index: i + 1, title: b.title,
      characters: cast.map((ch): SeriesCharacterInput => {
        const engine = (ch.ttsEngine ?? null) as string | null;
        const name = engine ? (ch.overrideTtsVoices?.[engine]?.name ?? '') : '';
        const lineCount = Array.isArray(ch.lines) ? ch.lines.length : (typeof ch.lines === 'number' ? ch.lines : 0);
        return {
          characterId: ch.id, name: ch.name ?? ch.id, aliases: ch.aliases ?? [],
          voiceId: ch.voiceId ?? null,
          voiceLabel: engine ? describeVoice(engine as never, name) : '',
          engine, voiceKind: voiceKindFor(engine as never),
          isPrincipal: lineCount >= PRINCIPAL_LINE_FLOOR,
          matchedFrom: ch.matchedFrom ?? null,
        };
      }),
    });
  }
  return inputs;
}
```

> **Confirm two things in `scan.ts`/`paths.ts`:** (1) which statuses mean `castConfirmed === true` — the scan derives `status` from `castConfirmed` (a `cast_pending` book is NOT confirmed); filter to the confirmed set, NOT by a hardcoded list if a cleaner `castConfirmed` signal is reachable. (2) Factor the per-series book listing the existing `scanLibrary` loop already does into a small `scanSeriesBooks(author, series)` helper so `buildSeriesInputs` and the main loop share it (DRY).

Then, in `scanLibrary`'s series loop, attach the summary:

```typescript
const inputs = await buildSeriesInputs(authorName, seriesName);
const detail = deriveSeriesMemory(inputs);
seriesList.push({ name: seriesName, books, seriesMemory: detail ? summarize(detail) : null });
```

Update the series type (in scan.ts where `LibraryResponse`/series is declared, ~line 241 region):

```typescript
import type { SeriesMemorySummary } from './series-memory.js';
// in the series interface:
seriesMemory?: SeriesMemorySummary | null;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/workspace/series-memory-scan.test.ts`
Expected: PASS. Then run the existing scan suite to confirm no regression:
Run: `cd server && npx vitest run src/workspace/`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/scan.ts server/src/workspace/series-memory-scan.test.ts
git commit -m "feat(server): attach seriesMemory summary in scanLibrary"
```

---

## Task 4: Detail endpoint `GET /api/library/series-memory`

**Files:**
- Create: `server/src/routes/series-memory.ts`
- Modify: the router index (where `libraryRouter` is mounted — search `libraryRouter` / `app.use('/api/library'`)
- Test: `server/src/routes/series-memory.test.ts`

**Interfaces:**
- Produces: `GET /api/library/series-memory?author=<a>&series=<s>` → `SeriesMemoryDetail` (200) or 404 when the series is below threshold / not found. Reuses the same input-assembly as Task 3 (extract a shared `buildSeriesInputs(author, series)` helper in `scan.ts` or a new `series-memory-source.ts` so the route and the scan don't duplicate cast-reading).

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/routes/series-memory.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest'; // present in server/package.json devDeps (^7.2.2)
import { seriesMemoryRouter } from './series-memory.js';
// Build the app INLINE per the repo pattern (see accelerator-profile.test.ts) —
// there is NO shared make-app util.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/library', seriesMemoryRouter);
  return app;
}
// Bootstrap the same 3-book carried series as Task 3's test (mkdtemp temp
// workspace + state.json/cast.json per book; point WORKSPACE_ROOT at it in
// beforeAll, rm in afterAll — copy the helper from series-memory-scan.test.ts).

describe('GET /api/library/series-memory', () => {
  it('returns the carried roster for a series above threshold', async () => {
    const res = await request(makeApp()).get('/api/library/series-memory').query({ author: 'Kell', series: 'Ninth House' });
    expect(res.status).toBe(200);
    expect(res.body.carried.count).toBe(3);
    expect(res.body.carried.characters[0].voiceKind).toBe('designed');
  });
  it('404s for a series below threshold', async () => {
    const res = await request(makeApp()).get('/api/library/series-memory').query({ author: 'Nobody', series: 'None' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/series-memory.test.ts`
Expected: FAIL — route 404/unmounted.

- [ ] **Step 3: Implement the route**

```typescript
// server/src/routes/series-memory.ts
import { Router, type Request, type Response } from 'express';
import { buildSeriesInputs } from '../workspace/scan.js'; // exported in Task 3 refactor
import { deriveSeriesMemory } from '../workspace/series-memory.js';

export const seriesMemoryRouter = Router();

seriesMemoryRouter.get('/series-memory', async (req: Request, res: Response) => {
  const author = String(req.query.author ?? '');
  const series = String(req.query.series ?? '');
  if (!author || !series) return res.status(400).json({ error: 'author and series are required' });
  try {
    const inputs = await buildSeriesInputs(author, series);
    const detail = deriveSeriesMemory(inputs);
    if (!detail) return res.status(404).json({ error: 'No series memory for this series.' });
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || 'series-memory failed' });
  }
});
```

Mount it under the same `/api/library` base (so the path is `/api/library/series-memory`). Export `buildSeriesInputs(author, series): Promise<SeriesBookInput[]>` from scan.ts by extracting the per-series input assembly written in Task 3 into a reusable function.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/routes/series-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/series-memory.ts server/src/routes/series-memory.test.ts server/src/workspace/scan.ts
git commit -m "feat(server): GET /api/library/series-memory detail endpoint"
```

---

## Task 5: OpenAPI schemas + generated types + frontend type mirror

**Files:**
- Modify: `openapi.yaml` (add `SeriesMemorySummary`, `CarriedCharacter`, `SeriesMemoryDetail`; attach `seriesMemory` to `LibrarySeries` at lines 2923-2930; add the `/api/library/series-memory` path near line 338)
- Modify: `src/lib/api-types.ts` (regenerated — do not hand-edit)
- Modify: `src/lib/types.ts` (mirror `SeriesMemorySummary`/`SeriesMemoryDetail`/`CarriedCharacter`; add `seriesMemory?` to `LibrarySeries` at line 595)
- Test: none new (contract change; covered by the type-check + downstream component tests)

- [ ] **Step 1: Add schemas to `openapi.yaml`**

Under `components.schemas`, add:

```yaml
    SeriesMemorySummary:
      type: object
      required: [carriedCount, bespokeCount, designedCount, spanBooks, perBook]
      properties:
        carriedCount: { type: integer }
        bespokeCount: { type: integer }
        designedCount: { type: integer }
        spanBooks: { type: integer }
        perBook:
          type: array
          items:
            type: object
            required: [bookId, index, principalCount, carriedPresent]
            properties:
              bookId: { type: string }
              index: { type: integer }
              principalCount: { type: integer }
              carriedPresent: { type: integer }
    CarriedCharacter:
      type: object
      required: [character, aliases, voiceId, voiceLabel, voiceKind, firstBookId, lastBookId, bookIndices, carriedFullSpan]
      properties:
        character: { type: string }
        aliases: { type: array, items: { type: string } }
        voiceId: { type: string }
        voiceLabel: { type: string }
        engine: { type: string, nullable: true }
        voiceKind: { type: string, enum: [designed, cloned, preset] }
        firstBookId: { type: string }
        lastBookId: { type: string }
        bookIndices: { type: array, items: { type: integer } }
        carriedFullSpan: { type: boolean }
    SeriesMemoryDetail:
      type: object
      required: [series, carried]
      properties:
        series:
          type: object
          required: [confirmedBookCount, spanBooks, books]
          properties:
            confirmedBookCount: { type: integer }
            spanBooks: { type: integer }
            books:
              type: array
              items:
                type: object
                required: [bookId, title, index, principalCount]
                properties:
                  bookId: { type: string }
                  title: { type: string }
                  index: { type: integer }
                  principalCount: { type: integer }
        carried:
          type: object
          required: [count, bespokeCount, designedCount, characters]
          properties:
            count: { type: integer }
            bespokeCount: { type: integer }
            designedCount: { type: integer }
            characters: { type: array, items: { $ref: '#/components/schemas/CarriedCharacter' } }
```

Attach to `LibrarySeries` (lines 2923-2930):

```yaml
    LibrarySeries:
      type: object
      required: [name, books]
      properties:
        name: { type: string }
        books:
          type: array
          items: { $ref: '#/components/schemas/LibraryBook' }
        seriesMemory:
          allOf:
            - { $ref: '#/components/schemas/SeriesMemorySummary' }
          nullable: true
```

> **OpenAPI version note (verified):** `openapi.yaml` is **3.0.3**, not 3.1 — `type: 'null'` is invalid there. Use the `allOf` + `nullable: true` wrapper above. (3.0.3 can't put `nullable` directly on a `$ref`, hence the single-item `allOf`.)

Add the path near line 338:

```yaml
  /api/library/series-memory:
    get:
      summary: Per-series carried-character roster (series memory)
      operationId: getSeriesMemory
      parameters:
        - { in: query, name: author, required: true, schema: { type: string } }
        - { in: query, name: series, required: true, schema: { type: string } }
      responses:
        '200': { description: Carried roster, content: { application/json: { schema: { $ref: '#/components/schemas/SeriesMemoryDetail' } } } }
        '404': { description: Series below threshold or not found }
```

- [ ] **Step 2: Regenerate the types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` updates with the new schemas; no errors.

- [ ] **Step 3: Mirror hand types in `src/lib/types.ts`**

```typescript
// src/lib/types.ts — add near LibrarySeries (line 595)
export interface SeriesMemorySummary {
  carriedCount: number; bespokeCount: number; designedCount: number; spanBooks: number;
  perBook: Array<{ bookId: string; index: number; principalCount: number; carriedPresent: number }>;
}
export interface CarriedCharacter {
  character: string; aliases: string[]; voiceId: string; voiceLabel: string;
  engine: string | null; voiceKind: 'designed' | 'cloned' | 'preset';
  firstBookId: string; lastBookId: string; bookIndices: number[]; carriedFullSpan: boolean;
}
export interface SeriesMemoryDetail {
  series: { confirmedBookCount: number; spanBooks: number;
    books: Array<{ bookId: string; title: string; index: number; principalCount: number }> };
  carried: { count: number; bespokeCount: number; designedCount: number; characters: CarriedCharacter[] };
}
```

And add to `LibrarySeries`:

```typescript
export interface LibrarySeries {
  name: string;
  books: LibraryBook[];
  seriesMemory?: SeriesMemorySummary | null;
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts src/lib/types.ts
git commit -m "feat: openapi + types for series-memory summary, detail, carried character"
```

---

## Task 6: Castwave glyph + `getSeriesMemory` API client

**Files:**
- Create: `src/lib/castwave-glyph.tsx`
- Modify: `src/lib/api.ts` (add `getSeriesMemory`; real + mock)
- Test: `src/lib/castwave-glyph.test.tsx`

**Interfaces:**
- Produces: `export function CastwaveGlyph(props: { className?: string }): JSX.Element` — the inline brand waveform SVG (six ragged bars), `currentColor` fill so it inherits text colour. `api.getSeriesMemory(author: string, series: string): Promise<SeriesMemoryDetail>`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/lib/castwave-glyph.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CastwaveGlyph } from './castwave-glyph';

describe('CastwaveGlyph', () => {
  it('renders an svg with the brand waveform and inherits colour', () => {
    const { container } = render(<CastwaveGlyph className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('class')).toContain('x');
    expect(svg.querySelectorAll('rect, path').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/castwave-glyph.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the glyph** (source the bar geometry from `brand/` — the Castwave is six ragged bars in peach/magenta/white; here single-colour `currentColor` for inline use)

```tsx
// src/lib/castwave-glyph.tsx
export function CastwaveGlyph({ className }: { className?: string }) {
  // Six ragged bars — the brand "Castwave". currentColor so it tints to text.
  const bars = [
    [0, 4, 10], [3, 1, 13], [6, 5, 9], [9, 2, 12], [12, 6, 8], [15, 3, 11],
  ];
  return (
    <svg className={className} viewBox="0 0 18 16" fill="currentColor" aria-hidden="true">
      {bars.map(([x, top, h], i) => (
        <rect key={i} x={x} y={top} width="2" height={h} rx="1" />
      ))}
    </svg>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/castwave-glyph.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the API client** in `src/lib/api.ts` (mirror `realGetLibrary` at line 1748 and the mock wiring at line 84):

```typescript
async function realGetSeriesMemory(author: string, series: string): Promise<SeriesMemoryDetail> {
  const q = new URLSearchParams({ author, series });
  const res = await fetch(`/api/library/series-memory?${q}`);
  if (!res.ok) throw new Error(`series-memory failed (${res.status})`);
  return res.json();
}
// in the real export object: getSeriesMemory: realGetSeriesMemory,
// in the mock export object: getSeriesMemory: async (a, s) => MOCK_SERIES_MEMORY[`${a}::${s}`],
```

Import `SeriesMemoryDetail` from `./types`. Add `MOCK_SERIES_MEMORY` to the mocks in Task 11.

- [ ] **Step 6: Commit**

```bash
git add src/lib/castwave-glyph.tsx src/lib/castwave-glyph.test.tsx src/lib/api.ts
git commit -m "feat(frontend): Castwave glyph + getSeriesMemory api client"
```

---

## Task 7: `SeriesMemoryChip` component

**Files:**
- Create: `src/components/series-memory/series-memory-chip.tsx`
- Test: `src/components/series-memory/series-memory-chip.test.tsx`

**Interfaces:**
- Consumes: `SeriesMemorySummary` (types), `CastwaveGlyph` (Task 6).
- Produces: `export function SeriesMemoryChip(props: { summary: SeriesMemorySummary; bookCount: number; onOpen: () => void }): JSX.Element` — the brand-gradient pill, label `Your cast · {carriedCount} voices, {bookCount} books`, Castwave glyph, `data-testid="series-memory-chip"`, calls `onOpen` on click, min 44px touch target.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/series-memory/series-memory-chip.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeriesMemoryChip } from './series-memory-chip';

const summary = { carriedCount: 9, bespokeCount: 7, designedCount: 6, spanBooks: 12, perBook: [] };

describe('SeriesMemoryChip', () => {
  it('renders the warm carried-character label and book count', () => {
    render(<SeriesMemoryChip summary={summary} bookCount={12} onOpen={() => {}} />);
    expect(screen.getByTestId('series-memory-chip')).toHaveTextContent('Your cast · 9 voices, 12 books');
  });
  it('calls onOpen when clicked', () => {
    const onOpen = vi.fn();
    render(<SeriesMemoryChip summary={summary} bookCount={12} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('series-memory-chip'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/series-memory/series-memory-chip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (brand tokens only; gradient `--magenta → --peach`; ink label handled by a dark-mode utility class, no hex literals):

```tsx
// src/components/series-memory/series-memory-chip.tsx
import type { SeriesMemorySummary } from '../../lib/types';
import { CastwaveGlyph } from '../../lib/castwave-glyph';

export function SeriesMemoryChip({ summary, bookCount, onOpen }: {
  summary: SeriesMemorySummary; bookCount: number; onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="series-memory-chip"
      onClick={onOpen}
      className="inline-flex items-center gap-1.5 rounded-full px-3 min-h-[44px] sm:min-h-0 sm:py-1 text-xs font-semibold text-white dark:text-ink bg-gradient-to-r from-magenta to-peach hover:-translate-y-px transition-transform"
    >
      <CastwaveGlyph className="w-3.5 h-3.5" />
      Your cast · {summary.carriedCount} voices, {bookCount} books
    </button>
  );
}
```

> Confirm the Tailwind gradient utilities resolve the brand tokens (the config references `--magenta`/`--peach`). If `from-magenta`/`to-peach` aren't defined, use the existing brand-gradient utility class used elsewhere (search for `from-magenta` or `gradient-cta`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/series-memory/series-memory-chip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/series-memory/series-memory-chip.tsx src/components/series-memory/series-memory-chip.test.tsx
git commit -m "feat(frontend): SeriesMemoryChip (the library door)"
```

---

## Task 8: `SeriesSparkline` component

**Files:**
- Create: `src/components/series-memory/series-sparkline.tsx`
- Test: `src/components/series-memory/series-sparkline.test.tsx`

**Interfaces:**
- Consumes: `SeriesMemorySummary`.
- Produces: `export function SeriesSparkline(props: { summary: SeriesMemorySummary; onOpen: () => void }): JSX.Element` — one bar per `perBook` entry, full height = `principalCount`, gradient sub-bar = `carriedPresent`, faint sub-bar = `principalCount - carriedPresent`; caption `"{carriedCount} of your cast, kept true across the series."`; legend Carried / Other principals this book; `aria-label="{carriedCount} of your cast carried across {spanBooks} books"`; `data-testid="series-sparkline"`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/series-memory/series-sparkline.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeriesSparkline } from './series-sparkline';

const summary = {
  carriedCount: 9, bespokeCount: 7, designedCount: 6, spanBooks: 3,
  perBook: [
    { bookId: 'b1', index: 1, principalCount: 12, carriedPresent: 8 },
    { bookId: 'b2', index: 2, principalCount: 14, carriedPresent: 9 },
    { bookId: 'b3', index: 3, principalCount: 13, carriedPresent: 9 },
  ],
};

describe('SeriesSparkline', () => {
  it('renders one bar per book and the honest caption + aria', () => {
    render(<SeriesSparkline summary={summary} onOpen={() => {}} />);
    const strip = screen.getByTestId('series-sparkline');
    expect(strip).toHaveAttribute('aria-label', '9 of your cast carried across 3 books');
    expect(strip.querySelectorAll('[data-testid="sparkline-bar"]')).toHaveLength(3);
    expect(screen.getByText(/9 of your cast, kept true across the series\./)).toBeInTheDocument();
  });
  it('splits each bar into two buckets (carried + other principals)', () => {
    render(<SeriesSparkline summary={summary} onOpen={() => {}} />);
    const bar = screen.getAllByTestId('sparkline-bar')[0];
    expect(bar.children).toHaveLength(2); // gradient (carried) + faint (rest)
  });
  it('does not overflow when a carried character is below the principal floor (carriedPresent > principalCount)', () => {
    const odd = { ...summary, perBook: [{ bookId: 'b1', index: 1, principalCount: 2, carriedPresent: 5 }] };
    render(<SeriesSparkline summary={odd} onOpen={() => {}} />);
    const carried = screen.getByTestId('sparkline-bar').children[0] as HTMLElement;
    // base clamps to carriedPresent → carried fills 100%, never >100.
    expect(carried.style.height).toBe('100%');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/series-memory/series-sparkline.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement:**

```tsx
// src/components/series-memory/series-sparkline.tsx
import type { SeriesMemorySummary } from '../../lib/types';

export function SeriesSparkline({ summary, onOpen }: { summary: SeriesMemorySummary; onOpen: () => void }) {
  // Bar height base = principals, but never less than carried-present — a carried
  // character below the principal line-floor must not overflow the bar (ALG-3).
  const baseFor = (p: SeriesMemorySummary['perBook'][number]) => Math.max(p.principalCount, p.carriedPresent, 1);
  const max = Math.max(1, ...summary.perBook.map(baseFor));
  return (
    <div className="mt-1 rounded-xl border border-peach/20 bg-peach/8 px-3.5 py-2.5">
      <button
        type="button" onClick={onOpen}
        data-testid="series-sparkline"
        aria-label={`${summary.carriedCount} of your cast carried across ${summary.spanBooks} books`}
        className="flex items-end gap-1 h-8"
      >
        {summary.perBook.map((p) => {
          const base = baseFor(p);
          const h = (base / max) * 100;
          const carriedPct = (p.carriedPresent / base) * 100; // ≤ 100 by construction
          return (
            <span key={p.bookId} data-testid="sparkline-bar"
              className="flex flex-col-reverse w-2.5 rounded-sm overflow-hidden" style={{ height: `${h}%` }}>
              <span className="bg-gradient-to-t from-peach to-magenta block" style={{ height: `${carriedPct}%` }} />
              <span className="bg-ink/10 block" style={{ height: `${100 - carriedPct}%` }} />
            </span>
          );
        })}
      </button>
      <p className="mt-2 text-xs text-ink/60">{summary.carriedCount} of your cast, kept true across the series.</p>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/series-memory/series-sparkline.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/series-memory/series-sparkline.tsx src/components/series-memory/series-sparkline.test.tsx
git commit -m "feat(frontend): SeriesSparkline (per-book carried-vs-principals)"
```

---

## Task 9: Wire chip + sparkline into the library series header

**Files:**
- Modify: `src/components/library/library-grid.tsx:90-99` (the series header row)
- Test: `src/components/library/library-grid.test.tsx` (add cases — confirm the file exists; else `book-library.test.tsx`)

**Interfaces:**
- Consumes: `SeriesMemoryChip` (Task 7), `SeriesSparkline` (Task 8), `series.seriesMemory`.
- Produces: chip in the header row beside the count; sparkline strip beneath; both only when `series.seriesMemory` is present; clicking either calls a new `onOpenSeriesMemory(series)` prop the grid forwards up (the modal lives at the orchestrator — Task 10 wires it).

- [ ] **Step 1: Write the failing test**

```tsx
// add to src/components/library/library-grid.test.tsx
// `renderGrid` below: reuse this file's EXISTING render helper + book factory
// if present; otherwise build the minimal authors prop inline as shown.
const sm = { carriedCount: 5, bespokeCount: 4, designedCount: 4, spanBooks: 3,
  perBook: [
    { bookId: 'b1', index: 1, principalCount: 8, carriedPresent: 5 },
    { bookId: 'b2', index: 2, principalCount: 9, carriedPresent: 5 },
    { bookId: 'b3', index: 3, principalCount: 9, carriedPresent: 5 },
  ] };
const authorsWith = (seriesMemory: typeof sm | undefined) => [{
  name: 'A. Kell',
  series: [{ name: 'The Ninth House', seriesMemory, books: [
    makeBook({ bookId: 'b1', title: 'One', series: 'The Ninth House' }), // file's existing book factory
  ] }],
}];

it('renders the series-memory chip + sparkline when seriesMemory is present', () => {
  renderGrid({ authors: authorsWith(sm) }); // file's existing render wrapper for LibraryGrid props
  expect(screen.getByTestId('series-memory-chip')).toBeInTheDocument();
  expect(screen.getByTestId('series-sparkline')).toBeInTheDocument();
});
it('renders neither when seriesMemory is absent', () => {
  renderGrid({ authors: authorsWith(undefined) });
  expect(screen.queryByTestId('series-memory-chip')).toBeNull();
  expect(screen.queryByTestId('series-sparkline')).toBeNull();
});
```

> Open `library-grid.test.tsx` first and reuse its existing `makeBook`/render helper (the names above mirror the common pattern); if the file builds props differently, adapt the wrapper — but the four assertions are the binding contract, not placeholders.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/library/library-grid.test.tsx`
Expected: FAIL — chip not rendered.

- [ ] **Step 3: Implement** — in the series map (library-grid.tsx:90-99), add the props passthrough and render:

```tsx
// Props: add `onOpenSeriesMemory?: (series: LibrarySeries) => void` to LibraryGrid's Props.
// In the series header row (the flex justify-between at :92):
<div className="flex items-baseline justify-between mb-3">
  <h3 className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55">{series.name}</h3>
  <div className="flex items-center gap-2.5">
    {series.seriesMemory && (
      <SeriesMemoryChip summary={series.seriesMemory} bookCount={series.books.length}
        onOpen={() => onOpenSeriesMemory?.(series)} />
    )}
    <span className="text-[11px] text-ink/40">{series.books.length} {series.books.length === 1 ? 'book' : 'books'}</span>
  </div>
</div>
{series.seriesMemory && (
  <SeriesSparkline summary={series.seriesMemory} onOpen={() => onOpenSeriesMemory?.(series)} />
)}
```

Import both components + `LibrarySeries`. Thread `onOpenSeriesMemory` from the orchestrator **`src/views/book-library.tsx`** (it renders `<LibraryGrid>` at :385 AND `<LibraryTable>` at :413, both fed `authors={filteredAuthors}`). **v1 scope: wire the chip+sparkline into the card-view `LibraryGrid` only.** The table view (`library-table.tsx`) gets the same treatment as a noted follow-up (its series header differs) — call this out in the PR so it's a deliberate scope line, not an omission.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/library/library-grid.test.tsx`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/components/library/library-grid.tsx src/components/library/library-grid.test.tsx
git commit -m "feat(frontend): series-memory chip + sparkline in the library header"
```

---

## Task 10: `SeriesMemoryReveal` modal

**Files:**
- Create: `src/components/series-memory/series-memory-reveal.tsx`
- Test: `src/components/series-memory/series-memory-reveal.test.tsx`
- Modify: the library orchestrator (hold `openSeriesMemory` state; render the modal)

**Interfaces:**
- Consumes: `api.getSeriesMemory` (Task 6), `SeriesMemoryDetail`, `CastwaveGlyph`.
- Produces: `export function SeriesMemoryReveal(props: { author: string; series: string; bookCount: number; onClose: () => void; onShare: (detail: SeriesMemoryDetail) => void; fetcher?: (a: string, s: string) => Promise<SeriesMemoryDetail> }): JSX.Element` — fetches on mount (`fetcher` defaults to `api.getSeriesMemory`, injectable for tests), headline `"{spell(bookCount)} books in, and not a voice has changed."`, subtitle `"{spell(carriedCount)} voices, yours — book after book."`, one row per carried character (label = `voiceLabel`, no engine name; Designed/Cloned tag for bespoke; bespoke rows first — already sorted by the server; book-marker row; `· from Bk K` for late joiners; per-row aria), Share + Export actions. Dialog on desktop, full-screen sheet on phone.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/series-memory/series-memory-reveal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SeriesMemoryReveal } from './series-memory-reveal';
import type { SeriesMemoryDetail } from '../../lib/types';

const detail: SeriesMemoryDetail = {
  series: { confirmedBookCount: 3, spanBooks: 3, books: [
    { bookId: 'b1', title: 'One', index: 1, principalCount: 8 },
    { bookId: 'b2', title: 'Two', index: 2, principalCount: 9 },
    { bookId: 'b3', title: 'Three', index: 3, principalCount: 9 },
  ] },
  carried: { count: 3, bespokeCount: 3, designedCount: 3, characters: [
    { character: 'Marrow', aliases: [], voiceId: 'v1', voiceLabel: 'Designed voice', engine: 'qwen', voiceKind: 'designed', firstBookId: 'b1', lastBookId: 'b3', bookIndices: [1, 2, 3], carriedFullSpan: true },
    { character: 'Sela', aliases: [], voiceId: 'v2', voiceLabel: 'Designed voice', engine: 'qwen', voiceKind: 'designed', firstBookId: 'b2', lastBookId: 'b3', bookIndices: [2, 3], carriedFullSpan: false },
    { character: 'Narrator', aliases: [], voiceId: 'v3', voiceLabel: 'Deep · Female · UK', engine: 'kokoro', voiceKind: 'preset', firstBookId: 'b1', lastBookId: 'b3', bookIndices: [1, 2, 3], carriedFullSpan: true },
  ] },
};

describe('SeriesMemoryReveal', () => {
  it('renders headline, subtitle and a row per carried character', async () => {
    render(<SeriesMemoryReveal author="Kell" series="Ninth House" bookCount={3} onClose={() => {}} onShare={() => {}} fetcher={async () => detail} />);
    await waitFor(() => screen.getByText(/not a voice has changed/));
    expect(screen.getByText(/Three books in, and not a voice has changed\./)).toBeInTheDocument();
    expect(screen.getByText('Marrow')).toBeInTheDocument();
    expect(screen.getByText(/from Bk 2/)).toBeInTheDocument();   // Sela late joiner
    expect(screen.queryByText(/Kokoro|Qwen/)).toBeNull();        // no engine names
    expect(screen.queryByText(/bf_|am_|af_/)).toBeNull();        // no catalogue slugs (P2-3)
    expect(screen.getByLabelText('in books 1–3')).toBeInTheDocument(); // range-collapsed aria (P0-5)
  });
  it('uses numerals (not spelled words) in the headline above twenty', async () => {
    render(<SeriesMemoryReveal author="Kell" series="Ninth House" bookCount={25} onClose={() => {}} onShare={() => {}} fetcher={async () => detail} />);
    await waitFor(() => screen.getByText(/books in/));
    expect(screen.getByText(/^25 books in,/)).toBeInTheDocument(); // not "Twenty-five"
  });
  it('fires onShare with the detail', async () => {
    const onShare = vi.fn();
    render(<SeriesMemoryReveal author="Kell" series="Ninth House" bookCount={3} onClose={() => {}} onShare={onShare} fetcher={async () => detail} />);
    await waitFor(() => screen.getByText('Share this cast'));
    fireEvent.click(screen.getByText('Share this cast'));
    expect(onShare).toHaveBeenCalledWith(detail);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/series-memory/series-memory-reveal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (use the app's existing modal/dialog primitive — search for an existing `Modal`/`Dialog`/`Drawer` used by other modals; the snippet below uses a plain dialog shell, swap in the house primitive):

```tsx
// src/components/series-memory/series-memory-reveal.tsx
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SeriesMemoryDetail, CarriedCharacter } from '../../lib/types';

const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
// Spell out ≤20, numerals above (per the copy rule — "Fifty-six" is clumsy at headline size).
const spell = (n: number) => (n >= 0 && n <= 20 ? ONES[n][0].toUpperCase() + ONES[n].slice(1) : String(n));
// Collapse consecutive book indices into ranges: [1,2,4,5,6,12] → "1, 2, 4–6, 12".
function rangeLabel(indices: number[]): string {
  const s = [...indices].sort((a, b) => a - b); const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`); i = j + 1;
  }
  return out.join(', ');
}

function CarriedRow({ c, bookCount }: { c: CarriedCharacter; bookCount: number }) {
  const present = new Set(c.bookIndices);
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 items-center py-2 border-t border-ink/6">
      <div>
        <div className="font-serif text-ink">{c.character}</div>
        <div className="text-[11px] text-ink/55">
          {c.voiceLabel}
          {c.voiceKind !== 'preset' && (
            <span className="ml-1.5 rounded px-1 py-0.5 bg-magenta/10 text-magenta text-[10px] font-semibold">
              {c.voiceKind === 'designed' ? 'Designed' : 'Cloned'}
            </span>
          )}
          {!c.carriedFullSpan && <span className="text-ink/40"> · from Bk {c.bookIndices[0]}</span>}
        </div>
      </div>
      <div className="flex gap-1" aria-label={`in books ${rangeLabel(c.bookIndices)}`}>
        {Array.from({ length: bookCount }, (_, i) => i + 1).map((idx) => (
          <span key={idx} className={`w-3 h-3 rounded-full ${present.has(idx) ? 'bg-gradient-to-r from-magenta to-peach' : 'bg-ink/12'}`} />
        ))}
      </div>
    </div>
  );
}

export function SeriesMemoryReveal({ author, series, bookCount, onClose, onShare, fetcher = api.getSeriesMemory }: {
  author: string; series: string; bookCount: number; onClose: () => void;
  onShare: (d: SeriesMemoryDetail) => void; fetcher?: (a: string, s: string) => Promise<SeriesMemoryDetail>;
}) {
  const [detail, setDetail] = useState<SeriesMemoryDetail | null>(null);
  useEffect(() => { let live = true; fetcher(author, series).then((d) => { if (live) setDetail(d); }); return () => { live = false; }; }, [author, series, fetcher]);

  return (
    <div role="dialog" aria-modal className="fixed inset-0 z-50 grid sm:place-items-center bg-ink/40" onClick={onClose}>
      <div className="bg-[#1b1714] text-cream w-full sm:max-w-xl sm:rounded-2xl p-7 min-h-screen sm:min-h-0 overflow-auto" onClick={(e) => e.stopPropagation()}>
        {!detail ? <p className="text-cream/60">Loading…</p> : (
          <>
            <p className="text-[11px] uppercase tracking-[0.14em] text-magenta font-semibold">series memory · {series}</p>
            <h2 className="font-serif text-2xl mt-2">{spell(bookCount)} books in, and not a voice has changed.</h2>
            <p className="text-cream/60 mt-1 mb-5">{spell(detail.carried.count)} voices, yours — book after book.</p>
            {detail.carried.characters.map((c) => <CarriedRow key={c.voiceId + c.character} c={c} bookCount={bookCount} />)}
            <div className="mt-5 flex justify-between items-center">
              <button onClick={() => onShare(detail)} className="rounded-full px-5 py-2.5 font-semibold text-ink bg-gradient-to-r from-magenta to-peach">Share this cast</button>
              <a href={`/api/library/series-memory?author=${encodeURIComponent(author)}&series=${encodeURIComponent(series)}`} download={`${series}-series-memory.json`} className="text-xs text-cream/60 underline">Export data (.json)</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

> Replace the dialog shell with the app's existing modal primitive if one exists (keeps focus-trap + escape handling consistent). Keep `role="dialog"`, the testids/text the test asserts, and the mobile full-screen behaviour.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/series-memory/series-memory-reveal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into the orchestrator** — in the component that renders `<LibraryGrid>`, hold `const [openSM, setOpenSM] = useState<LibrarySeries | null>(null)`, pass `onOpenSeriesMemory={(s) => setOpenSM(s)}`, and render `{openSM && <SeriesMemoryReveal author={openSM.books[0].author} series={openSM.name} bookCount={openSM.books.length} onClose={() => setOpenSM(null)} onShare={(d) => setShareCard(d)} />}` (shareCard state added in Task 12).

- [ ] **Step 6: Commit**

```bash
git add src/components/series-memory/series-memory-reveal.tsx src/components/series-memory/series-memory-reveal.test.tsx src/views/book-library.tsx
git commit -m "feat(frontend): SeriesMemoryReveal modal + orchestrator wiring"
```

---

## Task 11: Mock fixtures for series-memory

**Files:**
- Modify: `src/mocks/` (the library fixture — add a `seriesMemory` to one series; add `MOCK_SERIES_MEMORY` map keyed `"<author>::<series>"`)
- Test: covered by existing mock-mode component/e2e tests

- [ ] **Step 1: Add the summary to a mock series and the detail map**

Find the mock library fixture (search `MOCK_LIBRARY` / the canned `authors` tree). Attach a `seriesMemory` summary to one multi-book series and add:

```typescript
// src/mocks/series-memory.ts
import type { SeriesMemoryDetail } from '../lib/types';
export const MOCK_SERIES_MEMORY: Record<string, SeriesMemoryDetail> = {
  'A. Kell::The Ninth House': {
    series: { confirmedBookCount: 3, spanBooks: 3, books: [
      { bookId: 'b1', title: 'House of Ash', index: 1, principalCount: 8 },
      { bookId: 'b2', title: 'The Undertow', index: 2, principalCount: 9 },
      { bookId: 'b3', title: 'Saltwake', index: 3, principalCount: 9 },
    ] },
    carried: { count: 4, bespokeCount: 3, designedCount: 3, characters: [
      { character: 'Marrow', aliases: [], voiceId: 'vqm', voiceLabel: 'Designed voice', engine: 'qwen', voiceKind: 'designed', firstBookId: 'b1', lastBookId: 'b3', bookIndices: [1,2,3], carriedFullSpan: true },
      { character: 'Edda', aliases: [], voiceId: 'vqe', voiceLabel: 'Designed voice', engine: 'qwen', voiceKind: 'designed', firstBookId: 'b1', lastBookId: 'b3', bookIndices: [1,2,3], carriedFullSpan: true },
      { character: 'Sela', aliases: [], voiceId: 'vqs', voiceLabel: 'Designed voice', engine: 'qwen', voiceKind: 'designed', firstBookId: 'b2', lastBookId: 'b3', bookIndices: [2,3], carriedFullSpan: false },
      { character: 'Narrator', aliases: [], voiceId: 'vkn', voiceLabel: 'Deep · Female · UK', engine: 'kokoro', voiceKind: 'preset', firstBookId: 'b1', lastBookId: 'b3', bookIndices: [1,2,3], carriedFullSpan: true },
    ] },
  },
};
```

Wire `getSeriesMemory` mock (Task 6) to return `MOCK_SERIES_MEMORY[`${author}::${series}`]`.

- [ ] **Step 2: Verify mock-mode renders**

Run: `npx vitest run src/components/library/library-grid.test.tsx src/components/series-memory/`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mocks/
git commit -m "test(frontend): mock series-memory summary + detail fixtures"
```

---

## Task 12: `SeriesShareCard` component

**Files:**
- Create: `src/components/series-memory/series-share-card.tsx`
- Test: `src/components/series-memory/series-share-card.test.tsx`

**Interfaces:**
- Consumes: `SeriesMemoryDetail`, `CastwaveGlyph`.
- Produces: `export function SeriesShareCard(props: { detail: SeriesMemoryDetail; seriesName: string; owner?: string }): JSX.Element` — portrait card (4:5), dark, **mandatory** Castwave wordmark + `castwright.ai`; big number = `designedCount` (label "designed voices") when `designedCount >= count/2`, else `count` (label "voices"); elevated line `"kept true across all {spanBooks} books"`; cast wall of every `character` name with auto-scaling font + a cap past 45 names; footer `"{owner ?? 'Your'} cast · kept true"`. `data-testid="series-share-card"`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/series-memory/series-share-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SeriesShareCard } from './series-share-card';
import type { SeriesMemoryDetail } from '../../lib/types';

const detail: SeriesMemoryDetail = {
  series: { confirmedBookCount: 12, spanBooks: 12, books: [] },
  carried: { count: 56, bespokeCount: 41, designedCount: 39,
    characters: Array.from({ length: 56 }, (_, i) => ({
      character: `Name${i}`, aliases: [], voiceId: `v${i}`, voiceLabel: 'Designed voice',
      engine: 'qwen', voiceKind: i < 39 ? 'designed' : 'preset', firstBookId: 'b1', lastBookId: 'b12',
      bookIndices: [1], carriedFullSpan: true,
    })) as SeriesMemoryDetail['carried']['characters'] },
};

describe('SeriesShareCard', () => {
  it('leads on the designed figure, the claim line, and mandatory branding', () => {
    render(<SeriesShareCard detail={detail} seriesName="The Ninth House" owner="Alex" />);
    const card = screen.getByTestId('series-share-card');
    expect(within(card).getByText(/39/)).toBeInTheDocument();
    expect(within(card).getByText(/designed voices/)).toBeInTheDocument();
    expect(within(card).getByText(/kept true across all 12 books/)).toBeInTheDocument();
    expect(within(card).getByText('12 books. The same cast.')).toBeInTheDocument(); // locked claim line
    expect(within(card).getByText('castwright.ai')).toBeInTheDocument();            // non-removable branding
    expect(within(card).getByText(/Alex's cast · kept true/)).toBeInTheDocument();
    expect(within(card).queryByText('✦')).toBeNull();                              // no stock sparkle separator
  });
  it('uses spanBooks (not series length) so the claim cannot overclaim', () => {
    const turnover = { ...detail, series: { ...detail.series, confirmedBookCount: 12, spanBooks: 10 } };
    render(<SeriesShareCard detail={turnover} seriesName="X" />);
    expect(screen.getByText(/kept true across all 10 books/)).toBeInTheDocument();
    expect(screen.getByText('10 books. The same cast.')).toBeInTheDocument();
  });
  it('falls back to "Your cast · kept true" when no owner is set (never "undefined")', () => {
    render(<SeriesShareCard detail={detail} seriesName="X" />);
    expect(screen.getByText(/Your cast · kept true/)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
  it('caps the wall past 45 names', () => {
    render(<SeriesShareCard detail={detail} seriesName="X" />);
    expect(screen.getByText(/and \d+ more of your cast/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/series-memory/series-share-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement:**

```tsx
// src/components/series-memory/series-share-card.tsx
import type { SeriesMemoryDetail } from '../../lib/types';
import { CastwaveGlyph } from '../../lib/castwave-glyph';

const CAP = 45;

export function SeriesShareCard({ detail, seriesName, owner }: {
  detail: SeriesMemoryDetail; seriesName: string; owner?: string;
}) {
  const { count, designedCount } = detail.carried;
  const leadDesigned = designedCount >= count / 2 && designedCount > 0;
  const heroNum = leadDesigned ? designedCount : count;
  const heroLabel = leadDesigned ? 'designed voices' : 'voices';
  const names = detail.carried.characters.map((c) => c.character);
  const shown = names.length > CAP ? names.slice(0, CAP) : names;
  const overflow = names.length - shown.length;
  const nameSize = names.length > 50 ? 'text-[10px]' : names.length > 34 ? 'text-xs' : 'text-sm';

  return (
    <div data-testid="series-share-card"
      className="aspect-[4/5] w-full max-w-sm mx-auto rounded-2xl bg-[#1b1714] text-cream p-7 flex flex-col">
      <div className="flex items-center gap-1.5 font-semibold"><CastwaveGlyph className="w-3.5 h-3.5 text-magenta" /> Castwright</div>
      <p className="text-[10px] uppercase tracking-[0.2em] text-magenta font-semibold mt-4">Series memory · {seriesName}</p>
      <div className="font-serif text-5xl font-bold mt-1">{heroNum} <span className="text-xl text-cream/70 font-normal">{heroLabel}</span></div>
      <p className="font-serif text-peach text-lg font-semibold">kept true across all {detail.series.spanBooks} books</p>
      <p className="text-cream/70 text-sm mt-1">{detail.series.spanBooks} books. The same cast.</p>
      <div className="flex-1 flex flex-wrap content-center justify-center items-center gap-x-2 gap-y-1 my-4 text-center">
        {shown.map((n, i) => (
          <span key={n + i} className={`font-serif ${nameSize} inline-flex items-center`}>
            {n}
            {i < shown.length - 1 && <CastwaveGlyph className="w-2 h-2 text-magenta/60 mx-1.5" />}
          </span>
        ))}
        {overflow > 0 && <span className={`${nameSize} text-cream/50`}> …and {overflow} more of your cast</span>}
      </div>
      <div className="flex justify-between items-end text-[11px]">
        <span className="text-cream/60">{owner ? `${owner}'s` : 'Your'} cast · kept true</span>
        <span className="text-magenta font-bold">castwright.ai</span>
      </div>
    </div>
  );
}
```

> The `✦` here is the **separator dot** in the wall, not the brand mark — confirm with design whether to swap for a Castwave dot; the brand glyph is already the wordmark mark. The card text colours use literal `#1b1714` (the same dark surface the reveal uses) — if a token exists for it, prefer the token.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/series-memory/series-share-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/series-memory/series-share-card.tsx src/components/series-memory/series-share-card.test.tsx
git commit -m "feat(frontend): SeriesShareCard (bespoke-led, scale-first)"
```

---

## Task 13: Share-card export (image download) + orchestrator wiring

**Files:**
- Modify: the library orchestrator (hold `shareCard` state; render `SeriesShareCard` in a modal with a "Download image" button)
- Create: `src/components/series-memory/share-card-modal.tsx` (+ test)

**Interfaces:**
- Consumes: `SeriesShareCard`. **Dependency decision (verified: NO image-render lib is in `package.json`).** v1 ships **zero-dep** — the modal renders `SeriesShareCard` as the in-app artifact (screenshot-ready) plus a **"Download data (.json)"** button (`Blob`-download the fetched detail; no new dep). The **one-click PNG download is a gated enhancement** needing `html-to-image` — a **dependency add requiring maintainer sign-off**; do NOT install it in this task, add the PNG button as a follow-up behind that approval. The acceptance criterion ("share card image + JSON") is met by the rendered card + JSON without blocking on the dep.

- [ ] **Step 1: Write the failing test** (logic only — assert the modal renders the card + a download control; mock the image lib):

```tsx
// src/components/series-memory/share-card-modal.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShareCardModal } from './share-card-modal';
import type { SeriesMemoryDetail } from '../../lib/types';

const detail: SeriesMemoryDetail = { // reuse Task 12's fixture shape (a real object — the card reads detail.carried)
  series: { confirmedBookCount: 3, spanBooks: 3, books: [] },
  carried: { count: 3, bespokeCount: 3, designedCount: 3, characters: [
    { character: 'Marrow', aliases: [], voiceId: 'v1', voiceLabel: 'Designed voice', engine: 'qwen', voiceKind: 'designed', firstBookId: 'b1', lastBookId: 'b3', bookIndices: [1,2,3], carriedFullSpan: true },
  ] },
};

describe('ShareCardModal', () => {
  it('renders the card and the zero-dep JSON download (no PNG dep in v1)', () => {
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    expect(screen.getByTestId('series-share-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download data \(\.json\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download image/i })).toBeNull(); // PNG is a gated follow-up
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/series-memory/share-card-modal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** the modal wrapping the card + a download handler (image lib call guarded so the unit test doesn't invoke it):

```tsx
// src/components/series-memory/share-card-modal.tsx
import { useRef } from 'react';
import type { SeriesMemoryDetail } from '../../lib/types';
import { SeriesShareCard } from './series-share-card';

export function ShareCardModal({ detail, seriesName, owner, onClose }: {
  detail: SeriesMemoryDetail; seriesName: string; owner?: string; onClose: () => void;
}) {
  function downloadJson() {
    const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${seriesName}-series-memory.json`; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div role="dialog" aria-modal className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <SeriesShareCard detail={detail} seriesName={seriesName} owner={owner} />
        <div className="mt-4 flex justify-center">
          <button onClick={downloadJson} className="rounded-full px-5 py-2.5 font-semibold text-ink bg-gradient-to-r from-magenta to-peach">Download data (.json)</button>
        </div>
        {/* PNG download button added here as a follow-up, behind the html-to-image dep sign-off. */}
      </div>
    </div>
  );
}
```

Render `{shareCard && <ShareCardModal detail={shareCard} seriesName={openSM?.name ?? ''} onClose={() => setShareCard(null)} />}` in the orchestrator; `onShare` from the reveal sets `shareCard`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/series-memory/share-card-modal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/series-memory/share-card-modal.tsx src/components/series-memory/share-card-modal.test.tsx src/views/book-library.tsx
git commit -m "feat(frontend): share-card modal + PNG export"
```

---

## Task 14: E2E + responsive coverage

**Files:**
- Create: `e2e/series-memory.spec.ts`
- Modify: `e2e/responsive/coverage.spec.ts` (append a series-memory case so it runs at phone/tablet/desktop)

**Interfaces:**
- Consumes: mock-mode app (Task 11 fixtures).

- [ ] **Step 1: Write the e2e spec**

```typescript
// e2e/series-memory.spec.ts
import { test, expect } from '@playwright/test';

test('library → series-memory chip → reveal → share card', async ({ page }) => {
  await page.goto('/'); // mock mode (port 5174 per the e2e config)
  const chip = page.getByTestId('series-memory-chip').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Your cast ·');
  await chip.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/not a voice has changed/)).toBeVisible();
  await page.getByText('Share this cast').click();
  await expect(page.getByTestId('series-share-card')).toBeVisible();
  await expect(page.getByText('castwright.ai')).toBeVisible();
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- series-memory`
Expected: PASS (after `npx playwright install chromium` if first run). If the chip isn't found, confirm the mock library fixture's series is above threshold (Task 11).

- [ ] **Step 3: Append the coverage case** in `e2e/responsive/coverage.spec.ts` following its existing per-view pattern (navigate to the library, assert the chip is visible/tappable at each project viewport).

- [ ] **Step 4: Run responsive**

Run: `npm run test:e2e -- responsive/coverage`
Expected: PASS at chromium (and mobile/tablet projects when run via `test:e2e:mobile`).

- [ ] **Step 5: Commit**

```bash
git add e2e/series-memory.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): series-memory chip → reveal → share card"
```

---

## Task 15: Regression plan doc + ship checklist

**Files:**
- Create: `docs/features/<n>-series-memory.md` (from `docs/features/TEMPLATE.md`; pick the next plan number — scan `docs/features/INDEX.md` and in-flight branch names)
- Modify: `docs/features/INDEX.md` (add the entry under its area)
- Modify: `docs/BACKLOG.md` (remove the `fe-40` row on ship)

- [ ] **Step 1: Write the regression plan** from `TEMPLATE.md` — invariants (carried predicate, threshold, bespoke gate, unit=characters, span vs M), the manual acceptance walkthrough (library chip → reveal → share/export), and the automated coverage map (Tasks 1-14).

- [ ] **Step 2: Update `INDEX.md`** with the new plan entry.

- [ ] **Step 2b: File the deferred follow-ups as Backlog issues + thin rows** (per CLAUDE.md — discovered out-of-scope work is captured, not silently dropped). Three: (1) **LibraryTable** series-memory treatment (chip+sparkline in the table view); (2) harmonise the cast-row **"Reused · Matched"** badge to the "carried / kept true" vocabulary; (3) **PNG share-card export** (needs the `html-to-image` dependency sign-off). Each gets a `<prefix>-<n>` issue with `area:`/`moscow:`/`type:` labels and a one-line row in `docs/BACKLOG.md`.

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 4: Commit**

```bash
git add docs/features/ docs/BACKLOG.md
git commit -m "docs(docs): fe-40 series-memory regression plan + index; close backlog row"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** chip+sparkline (T7-T9), reveal (T10), share card+JSON (T12-T13), carried predicate + bespoke + threshold + spanBooks + confirmed-only (T2-T3), data-sourcing via persisted `matchedFrom` (T2-T3), describeVoice label + no-slug/no-engine (T3, T10), Castwave glyph (T6), mandatory branding (T12), a11y text equivalents (T8, T10), no-cache v1 (T3-T4). All mapped.
- **Real decisions for the executor (call out in the PR):** (1) the `cloned` signal for Coqui — defaulted off, so Coqui counts as `preset` until a clone marker exists (the headline case is Qwen `designed` anyway); (2) **PNG share-card export needs the `html-to-image` dependency** — v1 ships zero-dep (rendered card + JSON), the PNG button is a sign-off-gated follow-up (T13, filed in T15).
- **v1 scope line:** chip+sparkline land in the **card-view `LibraryGrid`** only; the **`LibraryTable`** treatment + the **"Reused" badge** vocabulary harmonisation are filed follow-ups (T15).
- **Type consistency:** `SeriesCharacterInput`/`SeriesBookInput`/`CarriedCharacter`/`SeriesMemorySummary`/`SeriesMemoryDetail` are defined once (T2/T5) and reused verbatim; `voiceKindFor` (T1) is the only voiceKind source; `deriveSeriesMemory`/`summarize`/`buildSeriesInputs` names are stable across T2-T4.

## Corrections applied after the 3-angle adversarial review (binding)

The plan was revised after an adversarial review (algorithm / codebase-fit / spec-coverage). Fixes folded in above: the derivation now walks `matchedFrom` **backward** from chain tails (the forward walk produced zero carried); chain ordering is by `book.index` (latest = canonical name); `deriveSeriesMemory` contract is **confirmed-only, 1..M**; `describeVoice` gets an **export** (T3); path helpers come from **`paths.js`** not scan.ts; **`buildSeriesInputs`** is a real export (T3) consumed by T4; the OpenAPI nullable uses **3.0.3 `allOf`+`nullable`** (not `type: 'null'`); the orchestrator is **`src/views/book-library.tsx`**; route tests build the app **inline** (no `make-app` util); the card renders the **locked claim line** + a **Castwave-dot** separator (not `✦`); the sparkline **clamps** so carried can't overflow; the reveal aria is **range-collapsed**. New tests added: mid-series gap, renamed-via-alias single row, chip==reveal invariant, bespoke sort order, `spanBooks<M` card, owner fallback, num-to-words cap, two-bucket partition + overflow, no-slug.

**One test still owed (add when executing T3):** a confirmed-only exclusion case — write a 4th book with `castConfirmed: false` into the temp workspace and assert `series.seriesMemory.spanBooks` and `carriedCount` are unchanged (the `cast_pending` book contributes nothing).
