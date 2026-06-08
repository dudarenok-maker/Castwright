/* AsrStatusBadge — display-only model-watch indicator for the Whisper ASR
   content-QA engine (srv-31). Unlike the TTS engines, ASR has no Load/Stop
   affordance: it loads lazily on /transcribe and idle-evicts, so the user only
   needs to SEE whether the model is resident and on which device. Matches the
   ModelControlPill pill visual (dot + label) minus the action button. */

import type { ModelControlState } from './ModelControlPill';

const TONE: Record<'idle' | 'ready' | 'unreachable', { pill: string; dot: string }> = {
  idle: { pill: 'bg-white/70 text-ink/55 border border-ink/10', dot: 'bg-ink/30' },
  ready: { pill: 'bg-emerald-50 text-emerald-700 border border-emerald-200', dot: 'bg-emerald-500' },
  unreachable: { pill: 'bg-rose-50 text-rose-700 border border-rose-200', dot: 'bg-rose-500' },
};

export function AsrStatusBadge({
  state,
  device,
}: {
  state: ModelControlState;
  device: string | null;
}) {
  /* ASR never reports 'loading' / 'streaming'; collapse anything unexpected to
     idle so the tone lookup is total. */
  const key = state === 'ready' || state === 'unreachable' ? state : 'idle';
  const tone = TONE[key];
  const label =
    key === 'ready'
      ? device
        ? `Whisper ASR ready · ${device}`
        : 'Whisper ASR ready'
      : key === 'unreachable'
        ? 'Voice engine not running'
        : 'Whisper ASR idle';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tabular-nums ${tone.pill}`}
      role="status"
      aria-label={`Whisper ASR ${key}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
