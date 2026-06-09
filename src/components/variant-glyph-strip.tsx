/* fe-32 — demand-driven per-emotion variant status for a cast row. One glyph per
   emotion the character's quotes USE; a green check badge = designed, an amber
   alert badge = needed (renders in the base voice until designed). Quiet when
   the character uses no emotion tags; "complete" when every in-use emotion is
   designed. Status badges are crisp SVG icons (IconCheck / IconAlertTri), not
   emoji-text, per the spec's icon-quality requirement. */
import type { JSX } from 'react';
import { IconCheck, IconAlertTri } from '../lib/icons';

const ORDER = ['whisper', 'angry', 'excited', 'sad'] as const;
const GLYPH: Record<string, string> = { whisper: '🤫', angry: '😠', excited: '🤩', sad: '😢' };
const LABEL: Record<string, string> = { whisper: 'Whisper', angry: 'Angry', excited: 'Excited', sad: 'Sad' };

export function VariantGlyphStrip({
  usedEmotions,
  designedEmotions,
}: {
  usedEmotions: Set<string>;
  designedEmotions: Set<string>;
}): JSX.Element {
  const inUse = ORDER.filter((e) => usedEmotions.has(e));
  if (inUse.length === 0) {
    return (
      <span data-testid="variants-no-tags" className="text-[10px] text-ink/35 italic">no emotion tags</span>
    );
  }
  if (inUse.every((e) => designedEmotions.has(e))) {
    return (
      <span data-testid="variants-complete" className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
        <IconCheck className="w-3 h-3" /> variants complete
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {inUse.map((e) => {
        const designed = designedEmotions.has(e);
        return (
          <span
            key={e}
            data-testid={`variant-glyph-${e}`}
            data-state={designed ? 'designed' : 'needed'}
            title={`${LABEL[e]} — ${designed ? 'designed' : 'needs a variant'}`}
            className={`relative w-6 h-6 rounded-full grid place-items-center text-[13px] ${designed ? 'bg-emerald-500/10' : 'bg-amber-500/10'}`}
          >
            <span aria-hidden>{GLYPH[e]}</span>
            <span className={`absolute -right-1 -top-1 w-3 h-3 rounded-full grid place-items-center text-white ring-2 ring-canvas ${designed ? 'bg-emerald-600' : 'bg-amber-500'}`}>
              {designed ? <IconCheck className="w-2 h-2" /> : <IconAlertTri className="w-2 h-2" />}
            </span>
          </span>
        );
      })}
    </span>
  );
}
