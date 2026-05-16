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

   Pairs with docs/features/31-sticky-generation.md.

   Note (post-B-series sticky analysis, plan 32): the REVERSE direction —
   guard a TTS-start callsite when a local analysis is alive on a
   different book — is not yet wired here. With sticky analysis, that
   conflict is now possible: user opens book Y's Generate after starting
   analysis on book X with a local Ollama model, both run, both compete
   for GPU. Today's mitigation is operational (the user notices slow
   performance and pauses one). A future extension can read
   `s.analysis.activeStream != null` alongside the existing
   `s.chapters.activeStream` check to offer a symmetric prompt.
   Tracked in docs/features/32-sticky-analysis.md "Known follow-ups". */

import { useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { chaptersActions } from '../store/chapters-slice';
import { MODEL_OPTIONS } from '../lib/models';
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
  const selectedModel = useAppSelector(s => s.ui.selectedModel);
  const activeStream = useAppSelector(s => s.chapters.activeStream);
  const libraryBooks = useAppSelector(s => s.library.books);

  /* Stash the proceed callback in state — the modal needs to call it on
     confirm, after dispatching setPaused. Null while closed. */
  const [pending, setPending] = useState<(() => void) | null>(null);

  /* Engine lookup — `local` engines are the only ones that compete for
     GPU. Anything else (gemini, gemma-via-Gemini) is a remote API and
     safe to fire alongside an in-flight TTS run. */
  const engine = MODEL_OPTIONS.find(m => m.id === selectedModel)?.engine ?? 'gemini';

  const guard: GuardResult['guard'] = (proceed) => {
    if (engine !== 'local' || !activeStream) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };

  const close = () => setPending(null);

  const titleFromLibrary = activeStream
    ? libraryBooks.find(b => b.bookId === activeStream.bookId)?.title ?? null
    : null;
  const resolvedTitle = generatingBookTitle ?? titleFromLibrary ?? activeStream?.bookId ?? 'the other book';

  const modal = (
    <ConfirmDialog
      open={pending != null}
      eyebrow="Generation in progress"
      title="Pause audio generation to analyse?"
      icon={<IconWarning className="w-4 h-4"/>}
      body={
        <>
          <p>
            Local analysis needs the same GPU as the TTS sidecar, so
            audio generation for <b>{resolvedTitle}</b> will pause while
            this manuscript is analysed.
          </p>
          <p className="mt-3 text-ink/60">
            You can resume generation from the Generate screen afterwards
            — it picks up where it left off.
          </p>
        </>
      }
      confirmLabel="Pause and analyse"
      cancelLabel="Wait"
      variant="default"
      onConfirm={() => {
        /* setPaused(true) is the universal "stop the stream" signal:
           generation-stream-middleware closes its handle on the next
           reconcile, the snapshot clears, and the new analyzer run owns
           the GPU. The user will see the pill disappear; the run resumes
           only on an explicit Resume click in Generate. */
        dispatch(chaptersActions.setPaused(true));
        const run = pending;
        close();
        run?.();
      }}
      onClose={close}
    />
  );

  return { guard, modal };
}
