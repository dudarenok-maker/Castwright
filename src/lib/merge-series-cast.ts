/* Merge an anchor book's cast with the full casts of its series-mates into
   ONE deduped candidate list for the "Rebaseline the series" modal (plan 108
   follow-up). Without this the modal only ever sees a single representative
   book's cast — a character introduced in a later volume is invisible, and
   the principal-cast default reflects one book's line counts, not the series'.

   Dedup key = `voiceId ?? id` — the SAME key the series-scoped override write
   uses (server `applyOverrideToCastFiles`: `original.voiceId ?? original.id`).
   Two cast entries across books that share this key are one write target, so
   they collapse to one row; approving it propagates by voiceId across every
   book in the series. Characters that aren't linked across books (distinct
   voiceIds) stay as separate rows — honest, because a single approve only
   propagates to the books sharing that key.

   The anchor is authoritative: its entries win identity fields (name, colour,
   role) and KEEP their ids, so for the open book those ids still match redux
   and the approve step's `castActions.updateCharacter` mirror lands. Line
   counts are summed across the whole series (the rebaseline targets the
   SERIES' principal cast). An already-designed Qwen voice on any sibling is
   carried onto the representative so the modal's skip-already-approved logic
   fires even when the anchor book hasn't been rebaselined yet. */

import type { Character } from './types';

function writeKey(c: Character): string {
  return c.voiceId ?? c.id;
}

export function mergeSeriesCast(anchor: Character[], siblings: Character[]): Character[] {
  const byKey = new Map<string, Character>();
  /* Preserve first-seen order (anchor entries first) so the modal's own
     line-count sort has a stable, deterministic input. */
  const order: string[] = [];

  const add = (c: Character, isAnchor: boolean) => {
    const key = writeKey(c);
    const rep = byKey.get(key);
    if (!rep) {
      /* Fresh copy — never mutate the redux/source object. */
      byKey.set(key, { ...c, lines: c.lines ?? 0 });
      order.push(key);
      return;
    }
    /* Aggregate series-wide prominence. */
    rep.lines = (rep.lines ?? 0) + (c.lines ?? 0);
    if (isAnchor) return; // anchor identity already won when first added
    /* Carry a sibling's approved Qwen voice + persona onto the representative
       when the anchor lacks them, so a recurring character already moved onto
       Qwen in another book reads as "already on Qwen — kept" here. */
    const repQwen = rep.overrideTtsVoices?.qwen;
    const cQwen = c.overrideTtsVoices?.qwen;
    if (!repQwen && cQwen) {
      rep.overrideTtsVoices = { ...(rep.overrideTtsVoices ?? {}), qwen: cQwen };
      if (c.ttsEngine) rep.ttsEngine = c.ttsEngine;
    }
    if (!rep.voiceStyle && c.voiceStyle) rep.voiceStyle = c.voiceStyle;
  };

  for (const c of anchor) add(c, true);
  for (const c of siblings) add(c, false);

  return order.map((k) => byKey.get(k)!);
}
