import type { CSSProperties } from 'react';

const PHASE_LABELS: Record<'designing' | 'rendering', string> = {
  designing: 'Designing the voice…',
  rendering: 'Rendering the 12s audition…',
};

/** Number of waveform bars. Static count; staggered animation delays come from
    the nth-child rules in styles.css (.design-wave i). */
const BARS = 12;

interface Props {
  phase: 'designing' | 'rendering';
  /** When the design is done, pass true so the fill snaps to 100%. */
  complete?: boolean;
}

export function DesignProgress({ phase, complete = false }: Props) {
  /* Soft ETA: CSS animation eases the fill to ~92% over ~15s and holds (see
     styles.css .design-fill i). On completion we override to a full,
     transition-backed width so it snaps shut honestly. */
  const fillStyle: CSSProperties | undefined = complete
    ? { width: '100%', animation: 'none', transition: 'width 300ms ease-out' }
    : undefined;

  return (
    <div className="mt-3 rounded-2xl bg-canvas border border-ink/10 p-4">
      <div className="design-wave" data-testid="design-waveform" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className="design-fill mt-2" data-testid="design-fill">
        <i style={fillStyle} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-purple-deep/70">{PHASE_LABELS[phase]}</span>
        <span className="text-[11px] text-ink/40">about 15s</span>
      </div>
    </div>
  );
}
