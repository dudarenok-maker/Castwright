import { useEffect, useState, type CSSProperties } from 'react';

const PHASE_LABELS: Record<'designing' | 'rendering', string> = {
  designing: 'Designing the voice…',
  rendering: 'Rendering the 12s audition…',
};

/** Number of waveform bars. Static count; staggered animation delays come from
    the nth-child rules in styles.css (.design-wave i). */
const BARS = 12;

/** Past this many ms the design is "slow" — the optimistic eased fill + "about
    15s" ETA would start lying, so we flip to an honest indeterminate shimmer and
    a "GPU may be busy" message. Designs normally land in ~15s; a slow one is
    almost always a contended GPU. */
const SLOW_AFTER_MS = 20_000;

interface Props {
  phase: 'designing' | 'rendering';
  /** When the design is done, pass true so the fill snaps to 100%. */
  complete?: boolean;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function DesignProgress({ phase, complete = false }: Props) {
  /* Tick once a second so the elapsed clock advances — proof of life even when
     the eased fill is near-full. Mount time ≈ design start (the component
     mounts when the design begins). */
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (complete) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [complete]);

  const slow = !complete && elapsedMs >= SLOW_AFTER_MS;

  /* Soft ETA: CSS eases the fill to ~92% over ~15s and holds (styles.css
     .design-fill i). On completion we override to a full, transition-backed
     width so it snaps shut honestly. Past the slow threshold we ADD the
     indeterminate modifier so the bar reads "still working, no ETA" rather than
     "stuck at 92%". */
  const fillStyle: CSSProperties | undefined = complete
    ? { width: '100%', animation: 'none', transition: 'width 300ms ease-out' }
    : undefined;
  const fillClass = `design-fill mt-2${slow ? ' design-fill--indeterminate' : ''}`;

  return (
    <div className="mt-3 rounded-2xl bg-canvas border border-ink/10 p-4">
      <div className="design-wave" data-testid="design-waveform" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className={fillClass} data-testid="design-fill">
        <i style={fillStyle} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-purple-deep/70">{PHASE_LABELS[phase]}</span>
        <span className="text-[11px] text-ink/40 tabular-nums" data-testid="design-elapsed">
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-ink/40" data-testid="design-eta">
        {slow ? 'Taking longer than usual — the GPU may be busy with another job.' : 'about 15s'}
      </div>
    </div>
  );
}
