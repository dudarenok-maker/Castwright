/* Merge an anchor book's cast with the full casts of its series-mates into
   ONE deduped candidate list for the "Rebaseline the series" modal (plan 108
   follow-up). Without this the modal only ever sees a single representative
   book's cast — a character introduced in a later volume is invisible, and
   the principal-cast default reflects one book's line counts, not the series'.

   Two characters collapse into one row when EITHER:
     1. they share the series-override write key `voiceId ?? id` (the SAME key
        the server's `applyOverrideToCastFiles` uses), OR
     2. they look like the same person by name/alias — `sameCharacterByNameAlias`
        (plan 122): normalised name/alias token match, respecting the user's
        `notLinkedTo` "intentionally different" markers and never matching a
        fold bucket.
   Never, though, when the server's own group would keep the two apart: a "Don't reuse"
   decline between them, or a decliner's voice against another (see `keptApart` below).

   Rule 2 is why a recurring character detected under divergent ids across
   books ("Wren" / "Wren Sparrow", "Castor" / "bron-te") now reads as ONE
   row even when the books never shared a voiceId. The keystone that keeps this
   honest on APPROVE lives server-side: the rebaseline approve calls
   `voice-override-linked`, which rediscovers the same name/alias group and
   unifies their `voiceId` before propagating — so a single approve reaches
   every collapsed book (see `src/modals/rebaseline-modal.tsx::runApprove` and
   `server/src/routes/voice-override-linked.ts`).

   The anchor is authoritative: anchor entries are first in the node list, so
   the union root (lowest index) is always an anchor member when one is present
   — its identity fields (name, colour, role) and id win, and for the open book
   that id still matches redux. Line counts are summed across the whole series.
   An already-designed Qwen voice on any member is carried onto the
   representative so the modal's skip-already-approved logic fires even when the
   anchor book hasn't been rebaselined yet. Inputs are never mutated. */

import type { Character } from './types';
import { sameCharacterByNameAlias, type CharacterIdentity } from './cross-book-duplicates';

function writeKey(c: Character): string {
  return c.voiceId ?? c.id;
}

interface Node {
  c: Character;
  /** Home book of this entry — anchor rows use `anchorBookId`, siblings carry
      `sourceBookId` (stamped by GET /series-cast). Empty when unknown (tests /
      a book outside any series); the notLinkedTo guard simply can't fire then. */
  bookId: string;
}

/**
 * @param anchor        the modal's target book cast (open book = redux, else fetched)
 * @param siblings      every OTHER confirmed series-mate's cast (carries sourceBookId)
 * @param anchorBookId  the anchor's bookId, so the notLinkedTo guard works across the seam
 */
export function mergeSeriesCast(
  anchor: Character[],
  siblings: Character[],
  anchorBookId = '',
): Character[] {
  /* Anchors first so a component's lowest index — its union root — is an
     anchor member whenever one exists (anchor identity wins). */
  const nodes: Node[] = [
    ...anchor.map((c) => ({ c, bookId: anchorBookId })),
    ...siblings.map((c) => ({ c, bookId: c.sourceBookId ?? '' })),
  ];
  const n = nodes.length;

  /* PR #4109 review pass 3 -- two rows the server's group (voice-override-linked `inGroup`)
     keeps apart never share a row here, or the row would carry the decliner's voice onto the
     declined book (marked "unchanged", or a refused Approve). A "Don't reuse" pair, in either
     direction; and rows on different uuids when either uuid is held by a decline-marked row,
     since only the decliner carries the marker and its followers sit on its uuid. The server
     also reads a separation record the client cannot see, so a "Don't reuse" voice whose
     decliner is not in this series cast (an unconfirmed book) still collapses here. */
  const declinerUuids = new Set(
    nodes
      .filter((x) => !!x.c.voiceUuid && (x.c.declinedVoiceFrom ?? []).length > 0)
      .map((x) => x.c.voiceUuid as string),
  );
  const declines = (row: Character, other: Node) =>
    (!!other.bookId && (row.declinedVoiceFrom ?? []).includes(other.bookId)) ||
    (!!other.c.voiceUuid && (row.declinedVoiceUuids ?? []).includes(other.c.voiceUuid));
  const keptApart = (a: Node, b: Node) =>
    declines(a.c, b) ||
    declines(b.c, a) ||
    (a.c.voiceUuid !== b.c.voiceUuid &&
      [a.c.voiceUuid, b.c.voiceUuid].some((u) => !!u && declinerUuids.has(u)));

  /* Union-find; `parent[max] = min` so the root is always the lowest index. A union that
     would put a kept-apart pair in one component is skipped, checked over both components'
     members so no third row bridges the pair. */
  const parent = nodes.map((_, i) => i);
  const members = nodes.map((_, i) => [i]);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (members[ra].some((x) => members[rb].some((y) => keptApart(nodes[x], nodes[y])))) return;
    const [lo, hi] = [Math.min(ra, rb), Math.max(ra, rb)];
    parent[hi] = lo;
    members[lo].push(...members[hi]);
  };

  /* Pass 1 — union by write key (voiceId ?? id). Every earlier holder of the key is tried,
     since a kept-apart pair can leave the key's rows in more than one component. */
  const keyHolders = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const k = writeKey(nodes[i].c);
    const prev = keyHolders.get(k) ?? [];
    for (const j of prev) union(j, i);
    keyHolders.set(k, [...prev, i]);
  }

  /* Pass 2 — union by name/alias identity (respects notLinkedTo, skips buckets).
     Quadratic, but n is one series' cast rendered on modal open, not a hot loop. */
  const identityOf = (node: Node): CharacterIdentity => ({
    bookId: node.bookId,
    characterId: node.c.id,
    name: node.c.name,
    aliases: node.c.aliases,
    notLinkedTo: node.c.notLinkedTo,
  });
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (find(i) === find(j)) continue;
      if (sameCharacterByNameAlias(identityOf(nodes[i]), identityOf(nodes[j]))) union(i, j);
    }
  }

  /* Build one row per component. The first node seen for a root is the root
     itself (lowest index = anchor-most/earliest), so its identity wins; every
     other member folds its line count + (if the rep lacks one) its Qwen voice
     in. Fresh copies — never mutate the source objects. */
  const order: number[] = [];
  const repByRoot = new Map<number, Character>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const node = nodes[i];
    const rep = repByRoot.get(root);
    if (!rep) {
      repByRoot.set(root, { ...node.c, lines: node.c.lines ?? 0 });
      order.push(root);
      continue;
    }
    rep.lines = (rep.lines ?? 0) + (node.c.lines ?? 0);
    const repQwen = rep.overrideTtsVoices?.qwen;
    const cQwen = node.c.overrideTtsVoices?.qwen;
    if (!repQwen && cQwen) {
      rep.overrideTtsVoices = { ...(rep.overrideTtsVoices ?? {}), qwen: cQwen };
      if (node.c.ttsEngine) rep.ttsEngine = node.c.ttsEngine;
    }
    if (!rep.voiceStyle && node.c.voiceStyle) rep.voiceStyle = node.c.voiceStyle;
  }

  return order.map((root) => repByRoot.get(root)!);
}
