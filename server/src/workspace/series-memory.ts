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

/** Group each character's cross-book appearances into one carried record by
    CONNECTED COMPONENTS over the `matchedFrom` graph (union-find), then keep
    the components that share a single bespoke/preset voice across ≥2 books.

    Why components and not a directional walk: `matchedFrom` USUALLY points
    backward (a later book → its earlier self), but the client confirm-matcher
    links against ANY prior confirmed book — so a voice DESIGNED in a later book
    and reused into an EARLIER one yields a FORWARD edge. That makes the shared
    source a node with multiple incoming edges (e.g. book1→book2 AND book3→book2),
    which a singly-linked tail-walk can't reconstruct: it dropped appearances or
    split one character into two carried rows (over/under-count). Treating the
    edges as undirected and bucketing by component is direction-agnostic and
    fork-safe; it also subsumes the old cycle / shared-ancestor guards. */
export function deriveSeriesMemory(books: SeriesBookInput[]): SeriesMemoryDetail | null {
  if (books.length < MIN_BOOKS) return null;
  const ordered = [...books].sort((a, b) => a.index - b.index);

  // Index every appearance by bookId::characterId.
  const byKey = new Map<string, Appearance>();
  for (const book of ordered) for (const ch of book.characters) byKey.set(`${book.bookId}::${ch.characterId}`, { book, ch });

  // Union-find over appearance keys. `find` uses path-halving; missing parents
  // (a matchedFrom target not in this series) are simply never unioned.
  const parent = new Map<string, string>();
  for (const key of byKey.keys()) parent.set(key, key);
  const find = (k: string): string => {
    while (parent.get(k) !== k) {
      const grand = parent.get(parent.get(k)!)!;
      parent.set(k, grand);
      k = grand;
    }
    return k;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [key, { ch }] of byKey) {
    if (ch.matchedFrom?.bookId && ch.matchedFrom?.characterId) {
      const target = `${ch.matchedFrom.bookId}::${ch.matchedFrom.characterId}`;
      if (byKey.has(target)) union(key, target); // ignore links to other series / dropped chars
    }
  }

  // Bucket appearances by component root — each component is one logical character.
  const components = new Map<string, Appearance[]>();
  for (const [key, app] of byKey) {
    const root = find(key);
    let bucket = components.get(root);
    if (!bucket) components.set(root, (bucket = []));
    bucket.push(app);
  }

  const carried: CarriedCharacter[] = [];
  for (const chain of components.values()) {
    const voiceIds = new Set(chain.map((a) => a.ch.voiceId ?? ''));
    if (voiceIds.size !== 1 || voiceIds.has('')) continue; // voice changed/missing → not carried
    // Order explicitly by book index — earliest = first book, latest = canonical
    // name/voice. Dedup indices: a component can hold >1 appearance in the same
    // book (two characters reused from one shared source merge into one component).
    const byIndex = [...chain].sort((a, b) => a.book.index - b.book.index);
    const indices = [...new Set(byIndex.map((a) => a.book.index))];
    if (indices.length < 2) continue; // present in <2 distinct books → not carried
    const earliest = byIndex[0], latest = byIndex[byIndex.length - 1].ch;
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
