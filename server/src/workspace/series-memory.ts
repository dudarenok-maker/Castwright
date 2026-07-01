// server/src/workspace/series-memory.ts
import type { VoiceKind } from './voice-kind.js';

export interface SeriesCharacterInput {
  characterId: string; name: string; aliases: string[];
  // Two facets of a character's voice identity, EITHER of which may be null in a
  // given book: `voiceId` is the cross-book reuse-linkage key (null in the book
  // where a character DEBUTS — only stamped once it's matched FROM a prior book);
  // `voiceName` is the per-engine voice file (overrideTtsVoices[engine].name, null
  // when the character is a bare mention with no assigned voice). Carried-voice
  // consistency is judged across BOTH facets — see deriveSeriesMemory.
  voiceId: string | null; voiceName: string | null;
  voiceLabel: string; engine: string | null;
  voiceKind: VoiceKind; isPrincipal: boolean;
  matchedFrom: { bookId?: string; characterId?: string } | null;
  // Lines spoken in THIS book — summed across the chain into CarriedCharacter.totalLines,
  // the "most-speaking-first" ordering for the reveal list. Optional/defaults to 0 so
  // existing test fixtures that don't care about ordering need no changes.
  lineCount?: number;
}
export interface SeriesBookInput { bookId: string; index: number; title: string; characters: SeriesCharacterInput[]; }
export interface CarriedCharacter {
  character: string; aliases: string[]; voiceId: string; voiceLabel: string;
  engine: string | null; voiceKind: VoiceKind;
  firstBookId: string; lastBookId: string; bookIndices: number[]; carriedFullSpan: boolean;
  totalLines: number;
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

  // Second merge: appearances of ONE character that `matchedFrom` failed to link —
  // a missed cross-book match (e.g. Keefe re-detected fresh in one book) or
  // alias/spelling drift that gave the same person different ids ("Wylie"/"Wylie
  // Endal", "Jurek"/"Neverseen Figure"). PRESET voices are shared across characters
  // by design (two guards on one kokoro voice), so they're excluded throughout —
  // preserving the "two characters, one preset voice → two carried rows" invariant.
  //
  // Pass A — union by the reuse `voiceId`: a per-character key, distinct per
  // character, only null in a debut book. Unambiguous, so always safe to merge.
  const repByVoiceId = new Map<string, string>();
  for (const [key, { ch }] of byKey) {
    if (ch.voiceKind === 'preset' || !ch.voiceId) continue;
    const rep = repByVoiceId.get(ch.voiceId);
    if (rep) union(key, rep);
    else repByVoiceId.set(ch.voiceId, key);
  }
  // Pass B — union by the engine voice name, but ONLY when that name maps to a
  // single character (all its non-null voiceIds agree). A voice name shared across
  // DIFFERENT voiceIds means distinct characters reusing one voice (or a generic
  // placeholder), which must NOT be merged. This is what links a fresh-detected
  // fragment (null voiceId) back to its main character (e.g. Keefe).
  const byVoiceName = new Map<string, { keys: string[]; ids: Set<string> }>();
  for (const [key, { ch }] of byKey) {
    if (ch.voiceKind === 'preset' || !ch.voiceName) continue;
    let g = byVoiceName.get(ch.voiceName);
    if (!g) byVoiceName.set(ch.voiceName, (g = { keys: [], ids: new Set() }));
    g.keys.push(key);
    if (ch.voiceId) g.ids.add(ch.voiceId);
  }
  for (const g of byVoiceName.values()) {
    if (g.ids.size > 1) continue; // ambiguous voice name → leave components alone
    for (let i = 1; i < g.keys.length; i++) union(g.keys[i], g.keys[0]);
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
    // Voice consistency across BOTH facets. Each facet is null in legitimate
    // cases (debut book → null voiceId; bare mention → null voiceName), so a
    // null in one appearance must NOT poison the component — only a CONFLICT
    // (≥2 distinct non-null values) of either facet signals a real re-voicing.
    // Keying on `voiceId` alone (the old rule) wrongly dropped every character
    // that debuts in book 1, where the reuse voiceId is never stamped.
    const ids = new Set(chain.map((a) => a.ch.voiceId).filter((v): v is string => !!v));
    const names = new Set(chain.map((a) => a.ch.voiceName).filter((v): v is string => !!v));
    if (ids.size > 1 || names.size > 1) continue; // voice changed → not carried
    if (ids.size === 0 && names.size === 0) continue; // never voiced → not carried
    // Order explicitly by book index — earliest = first book, latest = canonical
    // name. Dedup indices: a component can hold >1 appearance in the same
    // book (two characters reused from one shared source merge into one component).
    const byIndex = [...chain].sort((a, b) => a.book.index - b.book.index);
    const indices = [...new Set(byIndex.map((a) => a.book.index))];
    if (indices.length < 2) continue; // present in <2 distinct books → not carried
    const earliest = byIndex[0], latest = byIndex[byIndex.length - 1];
    // Voice metadata (id/label/engine/kind) from the LATEST appearance that
    // actually carries a voice — the latest overall may be a bare unvoiced
    // mention whose label/engine are blank. The display NAME still comes from
    // the latest appearance overall (canonical-latest, e.g. an alias reveal).
    const voiced = [...byIndex].reverse().find((a) => a.ch.voiceId || a.ch.voiceName) ?? latest;
    const carriedVoiceId = (voiced.ch.voiceId ?? [...ids][0] ?? voiced.ch.voiceName ?? [...names][0]) as string;
    // carriedFullSpan: present in EVERY confirmed book 1..M (no gap). `ordered`
    // is the confirmed set by contract.
    const fullSpan = indices.length === ordered.length &&
      indices.every((v, i) => v === ordered[i].index);
    const totalLines = chain.reduce((sum, a) => sum + (a.ch.lineCount ?? 0), 0);
    carried.push({
      character: latest.ch.name, aliases: latest.ch.aliases,
      voiceId: carriedVoiceId, voiceLabel: voiced.ch.voiceLabel,
      engine: voiced.ch.engine, voiceKind: voiced.ch.voiceKind,
      firstBookId: earliest.book.bookId, lastBookId: latest.book.bookId,
      bookIndices: indices, carriedFullSpan: fullSpan, totalLines,
    });
  }

  const bespokeCount = carried.filter((c) => c.voiceKind !== 'preset').length;
  if (carried.length < MIN_CARRIED || bespokeCount < 1) return null;

  const designedCount = carried.filter((c) => c.voiceKind === 'designed').length;
  const carriedIndices = new Set(carried.flatMap((c) => c.bookIndices));
  const spanBooks = ordered.filter((b) => carriedIndices.has(b.index)).length;
  // Most lines across the series first (the biggest speaking parts lead the
  // reveal/card), then bespoke before preset, then by first appearance, then name.
  carried.sort((a, b) =>
    b.totalLines - a.totalLines ||
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
