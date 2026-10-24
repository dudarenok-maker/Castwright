/* useLocalAnalyzerGuard — gate every callsite that's about to trigger a
   local-analyzer (Ollama) run on a confirmation prompt when a TTS
   generation is already streaming. Local analysis needs the same GPU as
   XTTS, so the two can't coexist; the prompt offers a clean
   "pause-and-analyse" choice instead of letting the analyzer evict TTS
   mid-chapter.

   The remote (Gemini / Gemma) engines never compete locally, so this
   guard short-circuits to a straight call-through when the user has
   picked one of those models.

   Usage:
     const { guard, modal } = useLocalAnalyzerGuard({ pausedBookTitle });
     // ...
     return (
       <>
         <SomeView onSubmit={() => guard(() => doTheImport())} />
         {modal}
       </>
     );

   Pairs with docs/features/archive/31-sticky-generation.md.

   Reverse direction (D2 in plan 32): the symmetric guard — gate
   TTS-start callsites when a local analysis is alive — lives in
   `src/hooks/use-reverse-local-analyzer-guard.tsx`. It reads
   `s.analysis.activeStream` and the `engine` field on that snapshot
   (captured at setActiveStream time, NOT
   `s.ui.selectedModel`) so a user model-switch mid-stream cannot
   misclassify the running analysis. Applied at the Resume button in
   `src/views/generation.tsx` and at the three regenerate-modal
   onConfirm callbacks in `src/components/layout.tsx`. The implicit
   reconcile-driven generation start is intentionally NOT gated; see
   docs/features/archive/32-sticky-analysis.md for the rationale. */

import { useEffect, useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { selectAnyActiveStream } from '../store/chapters-slice';
import { haltActiveGeneration } from '../store/queue-thunks';
import { notificationsActions } from '../store/notifications-slice';
import { engineForModelId } from '../lib/models';
import { analyzerSharesTtsDevice, endpointForModelId, ttsDeviceKeyFor } from '../lib/analyzer-endpoints';
import type { TtsModelKey } from '../lib/types';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { IconWarning } from '../lib/icons';

interface GuardOptions {
  /** Optional override for the book title shown in the modal body. Falls
      back to the activeStream's bookId so the user can identify which run
      is about to pause even if the title lookup misses. */
  generatingBookTitle?: string | null;
  /** #3084 — the model about to be called, when it is not the run's selected model
      (e.g. Settings → Test on one model). Defaults to `ui.selectedModel`. */
  modelId?: string;
  /** #3084 W4 — 'design' guards a voice-design / persona start instead of an analysis start:
      the model about to be called is the persona engine (`analyzer.personaGeneration.engine`),
      and local Ollama never prompts (the server moves it to system RAM while a render runs). */
  purpose?: 'analyse' | 'design';
}

interface GuardResult {
  /** Wrap any callback that would trigger a local-analyzer run. If a
      generation stream is alive and the user has a local model selected,
      `guard(proceed)` opens the confirm dialog; otherwise it calls
      `proceed()` synchronously. */
  guard: (proceed: () => void) => void;
  /** Render this anywhere in the view's JSX. The dialog is mounted only
      while it's open. */
  modal: ReactNode;
}

/* Stable fallback: a fresh `[]` per selector call defeats react-redux's reference check. */
const NO_BOOKS: never[] = [];

export function useLocalAnalyzerGuard({ generatingBookTitle, modelId, purpose = 'analyse' }: GuardOptions = {}): GuardResult {
  const dispatch = useAppDispatch();
  /* Defensive reads — the design-start callsites (cast view, profile drawer) mount this hook, and
     their tests routinely build stores without the chapters/library slices. Production wires all. */
  const selectedModel = useAppSelector((s) => s.ui?.selectedModel ?? '');
  const anyActiveStream = useAppSelector((s) => (s.chapters ? selectAnyActiveStream(s) : false));
  /* A representative generating book for the modal copy (advisory). Stable
     string read so this hook doesn't re-render on every progress tick. */
  const activeBookId = useAppSelector((s) => Object.keys(s.chapters?.activeStreams ?? {})[0] ?? null);
  const libraryBooks = useAppSelector((s) => s.library?.books ?? NO_BOOKS);
  const analyzerEndpoints = useAppSelector((s) => s.account?.analyzerEndpoints);
  const configValues = useAppSelector((s) => s.config?.values);
  const reportedTtsDevices = useAppSelector((s) => s.config?.ttsReportedDevices ?? null);
  const personaEngine = useAppSelector((s) => s.config?.values?.['analyzer.personaGeneration.engine']?.effective);
  /* N8 — every live generation, not just the first: two books can generate on two cards, and
     the endpoint has to be compared with each. A joined string keeps the selector's result
     stable across progress ticks (the same reason the book-title selector reads a string). */
  const generatingModelKeysKey = useAppSelector((s) =>
    Object.values(s.chapters?.activeStreams ?? {})
      .map((stream) => stream.modelKey)
      .join('|'),
  );

  /* Stash the proceed callback in state — the modal needs to call it on
     confirm, after dispatching the halt. Null while closed. */
  const [pending, setPending] = useState<(() => void) | null>(null);

  /* Ollama shares the card with the Voice engine; Gemini is a remote API and safe alongside
     TTS; an OpenAI-compatible endpoint shares when it sits on 'any' or the TTS card (#3084). */
  const designing = purpose === 'design';
  const targetModel = designing
    ? typeof personaEngine === 'string' ? personaEngine : 'gemini'
    : (modelId ?? selectedModel);
  const engine = engineForModelId(targetModel);
  const endpointGpu = endpointForModelId({ analyzerEndpoints: analyzerEndpoints ?? [] }, targetModel)?.gpu;
  const generatingModelKeys = generatingModelKeysKey.length > 0 ? generatingModelKeysKey.split('|') : [];
  /* Shares if it shares with ANY live generation (N8). With none live the card is unknown, so
     the rule falls back to its fail-closed answer; `anyActiveStream` below still gates. */
  const shares =
    !(designing && targetModel === 'local') &&
    (generatingModelKeys.length === 0
      ? analyzerSharesTtsDevice({ engine, endpointGpu, ttsDeviceKey: undefined })
      : generatingModelKeys.some((key) =>
          analyzerSharesTtsDevice({
            engine,
            endpointGpu,
            ttsDeviceKey: ttsDeviceKeyFor(key as TtsModelKey, configValues, reportedTtsDevices),
          }),
        ));

  const guard: GuardResult['guard'] = (proceed) => {
    if (!shares || !anyActiveStream) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };

  const close = () => setPending(null);

  /* Escape on the open prompt is Wait. Capture phase + stopPropagation so a host that also listens
     for Escape on window (the A/B compare shell) does not close underneath the prompt. */
  const open = pending != null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPending(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const titleFromLibrary = activeBookId
    ? (libraryBooks.find((b) => b.bookId === activeBookId)?.title ?? null)
    : null;
  const resolvedTitle =
    generatingBookTitle ?? titleFromLibrary ?? activeBookId ?? 'the other book';

  const modal = (
    <ConfirmDialog
      open={pending != null}
      eyebrow="Generation in progress"
      title={designing ? 'Pause audio generation to design voices?' : 'Pause audio generation to analyse?'}
      icon={<IconWarning className="w-4 h-4" />}
      body={
        <>
          <p>
            {designing ? 'Voice-persona generation runs on an endpoint that shares the Voice engine’s GPU' : 'Local analysis needs the same GPU as the Voice engine'}, so audio generation for{' '}
            <b>{resolvedTitle}</b> will pause while {designing ? 'voices are designed' : 'this manuscript is analysed'}.
          </p>
          <p className="mt-3 text-ink/60">
            You can resume generation from the Generate screen afterwards — it picks up where it
            left off.
          </p>
        </>
      }
      confirmLabel={designing ? 'Pause and design' : 'Pause and analyse'}
      cancelLabel="Wait"
      variant="default"
      onConfirm={() => {
        /* haltActiveGeneration is the "stop the stream NOW + pause the queue"
           signal: the generation-stream middleware closes its open SSE handle
           (and POSTs /pause) immediately so the analyzer owns the GPU within
           the chapter, and queue.paused stops the dispatcher from re-draining.
           The user resumes generation from the queue modal afterwards. */
        const run = pending;
        close();
        if (!designing) {
          void dispatch(haltActiveGeneration());
          run?.();
          return;
        }
        /* A design shares the render's card, so it starts only after the halt has settled
           (N2) — and not at all if the halt failed, or it would race the render it asked to stop. */
        void (async () => {
          try {
            await dispatch(haltActiveGeneration({ awaitRelease: true }));
          } catch (e) {
            console.warn('[guard] halt before design failed', e);
            dispatch(
              notificationsActions.pushToast({
                kind: 'error',
                message: "Couldn't pause audio generation, so voice design didn't start. Please try again.",
              }),
            );
            return;
          }
          run?.();
        })();
      }}
      onClose={close}
    />
  );

  return { guard, modal };
}
