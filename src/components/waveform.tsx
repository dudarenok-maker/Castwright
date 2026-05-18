import { useMemo } from 'react';

interface WaveformProps {
  progress: number;
  active: boolean;
}

export function Waveform({ progress, active }: WaveformProps) {
  const bars = useMemo(() => {
    let s = 42;
    const out: number[] = [];
    for (let i = 0; i < 48; i++) {
      s = (s * 9301 + 49297) % 233280;
      out.push(0.25 + (s / 233280) * 0.75);
    }
    return out;
  }, []);
  return (
    <div className="flex items-end gap-[2px] h-7">
      {bars.map((h, i) => {
        const filled = i / bars.length <= progress;
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm transition-colors ${active && filled ? 'bg-magenta' : active ? 'bg-ink/15' : 'bg-ink/20'}`}
            style={{ height: `${h * 100}%` }}
          />
        );
      })}
    </div>
  );
}
