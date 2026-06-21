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
  carriedCount: number; bespokeCount: number; designedCount: number;
  confirmedBookCount: number; // M for in-app surfaces (chip + reveal) — NOT series.books.length
  spanBooks: number;          // for exported artifacts (card + JSON)
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
    designedCount: detail.carried.designedCount,
    confirmedBookCount: detail.series.confirmedBookCount, spanBooks: detail.series.spanBooks,
    perBook: detail.series.books.map((b) => ({ bookId: b.bookId, index: b.index,
      principalCount: b.principalCount, carriedPresent: carriedByIndex.get(b.index) ?? 0 })),
  };
}
