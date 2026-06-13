/* ModelControlPill — single source of truth for the in-app
   model-status-+-action affordance. Replaces the old read-only
   SidecarStatusPill (Generate screen) and ConnPill (Analysing screen)
   with a shared pill+button: same emerald/rose dot-and-label, plus a
   Load / Stop control next to it.

   States:
   - `idle`        — model is reachable but no weights loaded → action: Load.
   - `loading`     — /load is in flight → action: spinner, disabled.
   - `ready`       — weights resident, no active stream → action: Stop.
   - `streaming`   — analyzer is mid-chunk (NDJSON heartbeat firing) → action:
                      Stop, but disabled because killing the model mid-stream
                      would orphan the analysis run.
   - `unreachable` — the upstream daemon (sidecar / ollama) isn't answering →
                      action: Retry, which re-fires the Load handler.

   The component is intentionally stateless about how Load / Stop talk to
   the backend — the parent view owns those mutations (so it can sequence
   the auto-evict-of-the-other-model flow with a toast/banner). */

import type { CSSProperties, ReactNode } from 'react';

export type ModelKind = 'tts' | 'analyzer';
export type ModelControlState = 'idle' | 'loading' | 'ready' | 'streaming' | 'unreachable';

export interface StreamingDetail {
  /* Pre-formatted size string (e.g. "12.4 KB" or "84 KB"). Matches the
     existing HeartbeatRow format in analysing.tsx so the same numbers
     stay readable across the two displays. */
  sizeText: string;
  charsPerSec: number;
  sinceLastSec: number;
}

interface Props {
  kind: ModelKind;
  state: ModelControlState;
  /* Only consulted when state === 'streaming'. Provided by analysing.tsx
     from the SSE heartbeat; generation.tsx leaves it unset (the Generate
     screen has its own per-chapter progress display). */
  streamingDetail?: StreamingDetail;
  onLoad: () => void;
  onStop: () => void;
  /* Optional override label (e.g. "Sidecar unreachable" vs "Analyzer
     unreachable") so the unreachable state can be specific without
     duplicating the rest of the state machine in the parent. */
  unreachableLabel?: string;
  /* Per-engine label override (e.g. "Kokoro", "Coqui XTTS") for the
     pill text. When set, the state line reads "Kokoro idle / ready /
     unavailable" instead of the generic "TTS model …". Aria + button
     labels stay tied to `kind` so screen-reader semantics don't drift
     when multiple per-engine pills mount side by side. */
  engineLabel?: string;
}

interface Tone {
  pill: string;
  dot: string;
  pulse: boolean;
  button: string;
}

const TONES: Record<ModelControlState, Tone> = {
  idle: {
    pill: 'bg-white/70 text-ink/55 border border-ink/10',
    dot: 'bg-ink/30',
    pulse: false,
    button: 'bg-peach text-ink hover:bg-peach/90',
  },
  loading: {
    pill: 'bg-amber-50 text-amber-700 border border-amber-200',
    dot: 'bg-amber-500',
    pulse: true,
    button: 'bg-amber-100 text-amber-700 cursor-not-allowed',
  },
  ready: {
    pill: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    dot: 'bg-emerald-500',
    pulse: false,
    button: 'bg-white text-ink/70 border border-ink/15 hover:bg-ink/5',
  },
  streaming: {
    pill: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    dot: 'bg-emerald-500',
    pulse: true,
    button: 'bg-white text-ink/40 border border-ink/15 cursor-not-allowed',
  },
  unreachable: {
    pill: 'bg-rose-50 text-rose-700 border border-rose-200',
    dot: 'bg-rose-500',
    pulse: false,
    button: 'bg-white text-ink/70 border border-ink/15 hover:bg-ink/5',
  },
};

function labelFor(
  kind: ModelKind,
  state: ModelControlState,
  detail?: StreamingDetail,
  unreachableLabel?: string,
  engineLabel?: string,
): ReactNode {
  const noun = engineLabel ?? kindNoun(kind);
  if (state === 'idle') return `${noun} idle`;
  if (state === 'loading') return `Loading ${noun.toLowerCase()}…`;
  if (state === 'ready') return `${noun} ready`;
  if (state === 'unreachable') return unreachableLabel ?? `${noun} unavailable`;
  /* state === 'streaming' */
  if (!detail) return 'Streaming live';
  const sinceText =
    detail.sinceLastSec > 8 ? `stalled · last chunk ${detail.sinceLastSec}s ago` : 'streaming live';
  const parts = [sinceText, detail.sizeText];
  if (detail.charsPerSec > 0) parts.push(`${detail.charsPerSec.toLocaleString()} chars/s`);
  return parts.join(' · ');
}

function kindNoun(kind: ModelKind): string {
  return kind === 'tts' ? 'Voice engine' : 'Analyzer';
}

function actionFor(state: ModelControlState): {
  label: string;
  handler: 'load' | 'stop';
  disabled: boolean;
} {
  switch (state) {
    case 'idle':
      return { label: 'Load model', handler: 'load', disabled: false };
    case 'loading':
      return { label: 'Loading…', handler: 'load', disabled: true };
    case 'ready':
      return { label: 'Stop', handler: 'stop', disabled: false };
    case 'streaming':
      return { label: 'Stop', handler: 'stop', disabled: true };
    case 'unreachable':
      return { label: 'Retry', handler: 'load', disabled: false };
  }
}

export function ModelControlPill({
  kind,
  state,
  streamingDetail,
  onLoad,
  onStop,
  unreachableLabel,
  engineLabel,
}: Props) {
  const tone = TONES[state];
  const action = actionFor(state);
  const ariaLabel = engineLabel
    ? `${engineLabel} ${state}`
    : `${kindNoun(kind)} ${state}`;
  const dotStyle: CSSProperties | undefined = tone.pulse ? undefined : undefined;
  return (
    <span className="inline-flex items-center gap-2 flex-wrap" role="group" aria-label={ariaLabel}>
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tabular-nums ${tone.pill}`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${tone.dot} ${tone.pulse ? 'animate-pulse' : ''}`}
          style={dotStyle}
          aria-hidden="true"
        />
        <span>{labelFor(kind, state, streamingDetail, unreachableLabel, engineLabel)}</span>
      </span>
      <button
        type="button"
        onClick={action.handler === 'load' ? onLoad : onStop}
        disabled={action.disabled}
        aria-disabled={action.disabled}
        aria-label={`${action.label} (${kindNoun(kind).toLowerCase()})`}
        className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${tone.button}`}
      >
        {action.label}
      </button>
    </span>
  );
}
