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

import { useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { selectAnyActiveStream } from '../store/chapters-slice';
import { haltActiveGeneration } from '../store/queue-thunks';
import { engineForModelId } from '../lib/models';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { IconWarning } from '../lib/icons';

interface GuardOptions {
  /** Optional override for the book title shown in the modal body. Falls
      back to the activeStream's bookId so the user can identify which run
      is about to pause even if the title lookup misses. */
  generatingBookTitle?: string | null;
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

export function useLocalAnalyzerGuard({ generatingBookTitle }: GuardOptions = {}): GuardResult {
  const dispatch = useAppDispatch();
  const selectedModel = useAppSelector((s) => s.ui.selectedModel);
  const anyActiveStream = useAppSelector(selectAnyActiveStream);
  /* A representative generating book for the modal copy (advisory). Stable
     string read so this hook doesn't re-render on every progress tick. */
  const activeBookId = useAppSelector((s) => Object.keys(s.chapters.activeStreams)[0] ?? null);
  const libraryBooks = useAppSelector((s) => s.library.books);

  /* Stash the proceed callback in state — the modal needs to call it on
     confirm, after dispatching the halt. Null while closed. */
  const [pending, setPending] = useState<(() => void) | null>(null);

  /* Engine lookup — `local` engines are the only ones that compete for
     GPU. Anything else (gemini, gemma-via-Gemini) is a remote API and
     safe to fire alongside an in-flight TTS run. */
  const engine = engineForModelId(selectedModel);

  const guard: GuardResult['guard'] = (proceed) => {
    if (engine !== 'local' || !anyActiveStream) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };

  const close = () => setPending(null);

  const titleFromLibrary = activeBookId
    ? (libraryBooks.find((b) => b.bookId === activeBookId)?.title ?? null)
    : null;
  const resolvedTitle =
    generatingBookTitle ?? titleFromLibrary ?? activeBookId ?? 'the other book';

  const modal = (
    <ConfirmDialog
      open={pending != null}
      eyebrow="Generation in progress"
      title="Pause audio generation to analyse?"
      icon={<IconWarning className="w-4 h-4" />}
      body={
        <>
          <p>
            Local analysis needs the same GPU as the Voice engine, so audio generation for{' '}
            <b>{resolvedTitle}</b> will pause while this manuscript is analysed.
          </p>
          <p className="mt-3 text-ink/60">
            You can resume generation from the Generate screen afterwards — it picks up where it
            left off.
          </p>
        </>
      }
      confirmLabel="Pause and analyse"
      cancelLabel="Wait"
      variant="default"
      onConfirm={() => {
        /* haltActiveGeneration is the "stop the stream NOW + pause the queue"
           signal: the generation-stream middleware closes its open SSE handle
           (and POSTs /pause) immediately so the analyzer owns the GPU within
           the chapter, and queue.paused stops the dispatcher from re-draining.
           The user resumes generation from the queue modal afterwards. */
        void dispatch(haltActiveGeneration());
        const run = pending;
        close();
        run?.();
      }}
      onClose={close}
    />
  );

  return { guard, modal };
}
