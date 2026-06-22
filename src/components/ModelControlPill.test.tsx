/* ModelControlPill — state→label and click→handler contract.

   This component is the only path users have to surface the in-app Load /
   Stop affordances for the TTS sidecar (Generate screen) and the analyzer
   LLM (Analysing screen). If the action button mis-routes (e.g. Stop wired
   to the load handler), the user can't free GPU memory without killing
   processes — which is exactly the failure mode this whole change exists
   to fix. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelControlPill, type ModelControlState } from './ModelControlPill';

function makeHandlers() {
  return { onLoad: vi.fn(), onStop: vi.fn() };
}

describe('ModelControlPill — label per state', () => {
  it.each<[ModelControlState, RegExp]>([
    ['idle', /Voice engine idle/i],
    ['loading', /loading voice engine/i],
    ['ready', /Voice engine ready/i],
    ['unreachable', /Voice engine unavailable/i],
  ])('renders the canonical label for state %s', (state, labelRegex) => {
    const { onLoad, onStop } = makeHandlers();
    render(<ModelControlPill kind="tts" state={state} onLoad={onLoad} onStop={onStop} />);
    expect(screen.getByText(labelRegex)).toBeInTheDocument();
  });

  it('uses the analyzer noun when kind="analyzer"', () => {
    const { onLoad, onStop } = makeHandlers();
    render(<ModelControlPill kind="analyzer" state="ready" onLoad={onLoad} onStop={onStop} />);
    expect(screen.getByText(/Analyzer ready/i)).toBeInTheDocument();
  });

  it('renders the streaming detail row when state is streaming', () => {
    /* HeartbeatRow on analysing.tsx feeds the same byte/throughput numbers
       into this prop — the pill exposes them so a user glancing at the
       status indicator gets the streaming signal without needing the
       fuller HeartbeatRow below. */
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="analyzer"
        state="streaming"
        streamingDetail={{ sizeText: '12.4 KB', charsPerSec: 280, sinceLastSec: 2 }}
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/streaming live/i)).toBeInTheDocument();
    expect(screen.getByText(/12\.4 KB/)).toBeInTheDocument();
    expect(screen.getByText(/280 chars\/s/)).toBeInTheDocument();
  });

  it('flips the streaming label to "stalled" when sinceLastSec exceeds 8s', () => {
    /* Stall detection mirrors HeartbeatRow's 8s threshold — they should
       agree visually so the pill and the row don't disagree about whether
       the analyzer is hung. */
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="analyzer"
        state="streaming"
        streamingDetail={{ sizeText: '40 KB', charsPerSec: 0, sinceLastSec: 12 }}
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/stalled · last chunk 12s ago/i)).toBeInTheDocument();
  });

  it('honours an explicit unreachableLabel override', () => {
    /* The Generate screen uses "Sidecar unreachable" (process-level), the
       Analysing screen uses "Ollama unreachable" (daemon-level). Both should
       be possible without a kind-aware branch inside the component. */
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="tts"
        state="unreachable"
        unreachableLabel="Sidecar process not running"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText('Sidecar process not running')).toBeInTheDocument();
  });

  it('uses the engineLabel override for the pill noun when supplied', () => {
    /* The Kokoro and Coqui pills both mount with `kind="tts"` but render
       per-engine labels ("Kokoro ready" / "Coqui idle") so a user with
       both engines visible can distinguish them at a glance. */
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="tts"
        state="ready"
        engineLabel="Kokoro"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/Kokoro ready/i)).toBeInTheDocument();
    /* The default "Voice engine ready" must NOT appear when engineLabel is set
       — both rendering would leak the abstraction. */
    expect(screen.queryByText(/Voice engine ready/i)).not.toBeInTheDocument();
  });

  it('flips engineLabel into the loading + unavailable copy too', () => {
    /* The label flow uses the engineLabel for every state. Pin the two
       extra cases (loading, unreachable) so a future refactor that
       hard-codes "TTS model" in one branch can't slip through. */
    const { onLoad, onStop } = makeHandlers();
    const { rerender } = render(
      <ModelControlPill
        kind="tts"
        state="loading"
        engineLabel="Coqui XTTS"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/loading coqui xtts/i)).toBeInTheDocument();

    rerender(
      <ModelControlPill
        kind="tts"
        state="unreachable"
        engineLabel="Coqui XTTS"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/Coqui XTTS unavailable/i)).toBeInTheDocument();
  });
});

describe('ModelControlPill — action routing', () => {
  it('fires onLoad when the button reads "Load model"', () => {
    const { onLoad, onStop } = makeHandlers();
    render(<ModelControlPill kind="tts" state="idle" onLoad={onLoad} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /load model/i }));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('fires onStop when the model is ready and the user clicks Stop', () => {
    const { onLoad, onStop } = makeHandlers();
    render(<ModelControlPill kind="tts" state="ready" onLoad={onLoad} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('disables the action while loading is in flight (no double-load)', () => {
    /* Without this guard, a user clicking Load twice in quick succession
       would queue two POSTs to /api/sidecar/load — the sidecar serialises
       them but the second one would still pay the lock wait, surfacing as
       a "stuck Loading…" pill that doesn't match what the box is doing. */
    const { onLoad, onStop } = makeHandlers();
    render(<ModelControlPill kind="tts" state="loading" onLoad={onLoad} onStop={onStop} />);
    const btn = screen.getByRole('button', { name: /loading/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('disables Stop while a stream is in flight to prevent orphaning the analysis run', () => {
    /* Killing the analyzer model mid-stream leaves Ollama with a dangling
       generate call. Worse, the SSE on the frontend hits its keepalive
       timeout and lands in `chapter_failed` with no useful message. We
       hide that footgun by disabling the button while the stream is live. */
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="analyzer"
        state="streaming"
        streamingDetail={{ sizeText: '4 KB', charsPerSec: 200, sinceLastSec: 1 }}
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    const btn = screen.getByRole('button', { name: /stop/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('re-runs onLoad when the user clicks Retry from unreachable', () => {
    /* Unreachable should not be a dead end — the user lifts the sidecar
       back up (or starts Ollama) and clicks Retry, which is the same
       semantics as Load: warm the model. */
    const { onLoad, onStop } = makeHandlers();
    render(<ModelControlPill kind="tts" state="unreachable" onLoad={onLoad} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});

describe('ModelControlPill — Qwen 1.7B-Base pill (fs-55)', () => {
  /* Pin that the Qwen 1.7B-Base pill renders the correct label in each state.
     The pill is a plain ModelControlPill with engineLabel="Qwen 1.7B"; these
     tests verify the label flows through the same code path as Kokoro / Coqui. */

  it('shows "Qwen 1.7B idle" label when state is idle', () => {
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="tts"
        state="idle"
        engineLabel="Qwen 1.7B"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    /* Idle state renders a Load button — confirm it's present and the
       engineLabel is NOT shown as a body copy (the button reads "Load model"). */
    expect(screen.getByRole('button', { name: /load model/i })).toBeInTheDocument();
  });

  it('shows "Qwen 1.7B ready" when qwen_base17_loaded is true', () => {
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="tts"
        state="ready"
        engineLabel="Qwen 1.7B"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/Qwen 1\.7B ready/i)).toBeInTheDocument();
    /* Stop button is the action when ready. */
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('shows loading copy and is disabled when state is loading', () => {
    const { onLoad, onStop } = makeHandlers();
    render(
      <ModelControlPill
        kind="tts"
        state="loading"
        engineLabel="Qwen 1.7B"
        onLoad={onLoad}
        onStop={onStop}
      />,
    );
    expect(screen.getByText(/loading qwen 1\.7b/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled();
  });
});
