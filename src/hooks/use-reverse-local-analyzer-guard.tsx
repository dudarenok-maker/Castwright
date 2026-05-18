/* useReverseLocalAnalyzerGuard — gate explicit TTS-start callsites
   when a local-analyzer (Ollama) run is alive. Symmetric to
   `useLocalAnalyzerGuard`, but in the opposite direction:

     forward guard   — analysis start gated when TTS generation is alive.
     reverse guard   — TTS generation start gated when local analysis
                       is alive (regardless of which book either is on).

   Why this direction matters post-sticky-analysis (B-series in plan 32):
   the analyzer loop now survives navigation. A user can start a local
   Qwen analysis on book X, navigate to book Y, hit Resume / Regenerate,
   and have both the analysis loop and the TTS sidecar competing for
   the same GPU. Without the prompt the user only finds out via slow
   throughput; with this hook they get an explicit "Pause analysis to
   generate?" dialog that mirrors the forward direction.

   Insertion contract — apply at EXPLICIT generation-start callsites
   only:
     - Generate-view Pause / Resume toggle, but only when the user is
       transitioning paused -> unpaused (a click that PAUSES doesn't
       conflict with anything).
     - Regenerate-modal confirm handlers in src/components/layout.tsx
       (regenerate chapter, regenerate character, batch regenerate
       characters).

   Do NOT apply at the generation-stream-middleware's implicit
   reconcile-driven openHandle. The user already consented when they
   originally started generation; nagging them with a prompt every
   time the slice rehydrates after a navigation would be surprising
   rather than helpful. The sticky-generation contract (plan 31)
   explicitly says navigation does not bother the user.

   Engine source: we read `s.analysis.activeStream.engine`, set at
   setActiveStream time in `src/views/analysing.tsx`, NOT
   `s.ui.selectedModel`. The selected model can change after analysis
   started; the snapshot's engine field captures what's actually
   running. */

import { useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { analysisActions } from '../store/analysis-slice';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { IconWarning } from '../lib/icons';

interface GuardOptions {
  /** Optional title for the book whose analysis is in flight. Falls
      back to the snapshot's `bookTitle`, then a library lookup, then
      the bookId so the user always has something to identify which
      run will pause. */
  analysingBookTitle?: string | null;
}

interface GuardResult {
  /** Wrap any callback that would start / resume / regenerate TTS
      audio. If a local analysis is alive, `guard(proceed)` opens the
      confirm dialog; otherwise it calls `proceed()` synchronously. */
  guard: (proceed: () => void) => void;
  /** Render this anywhere in the view's JSX. The dialog is mounted
      only while it is open. */
  modal: ReactNode;
}

export function useReverseLocalAnalyzerGuard({
  analysingBookTitle,
}: GuardOptions = {}): GuardResult {
  const dispatch = useAppDispatch();
  /* Defensive reads — tests routinely build configureStore() without
     every slice. Without `?.` here those stores would throw the
     moment a view that mounts this hook renders. Production always
     has both slices wired via `src/store/index.ts`. */
  const activeStream = useAppSelector((s) => s.analysis?.activeStream ?? null);
  const libraryBooks = useAppSelector((s) => s.library?.books ?? []);

  const [pending, setPending] = useState<(() => void) | null>(null);

  const isLocal = activeStream?.engine === 'local';

  const guard: GuardResult['guard'] = (proceed) => {
    if (!activeStream || !isLocal) {
      proceed();
      return;
    }
    setPending(() => proceed);
  };

  const close = () => setPending(null);

  const titleFromLibrary = activeStream?.bookId
    ? (libraryBooks.find((b) => b.bookId === activeStream.bookId)?.title ?? null)
    : null;
  const resolvedTitle =
    analysingBookTitle ??
    activeStream?.bookTitle ??
    titleFromLibrary ??
    activeStream?.bookId ??
    'the other book';

  const modal = (
    <ConfirmDialog
      open={pending != null}
      eyebrow="Analysis in progress"
      title="Pause analysis to generate?"
      icon={<IconWarning className="w-4 h-4" />}
      body={
        <>
          <p>
            Local analysis needs the same GPU as the TTS sidecar, so analysis for{' '}
            <b>{resolvedTitle}</b> will pause while audio is generated.
          </p>
          <p className="mt-3 text-ink/60">
            You can resume analysis from the analysing screen afterwards — it picks up where it left
            off.
          </p>
        </>
      }
      confirmLabel="Pause and generate"
      cancelLabel="Wait"
      variant="default"
      onConfirm={() => {
        /* analysisActions.setPaused triggers two effects:
             1. The slice's snapshot flips to 'paused'.
             2. The analysis-stream-middleware's pause-bridge fires
                POST /pause to the server AND closes its own SSE
                handle (D1).
           The user then keeps their AnalysisPill in the paused
           variant; they can navigate back to the analysing view and
           click Resume when they want to. */
        const manuscriptId = activeStream?.manuscriptId;
        if (manuscriptId) {
          dispatch(analysisActions.setPaused({ manuscriptId }));
        }
        const run = pending;
        close();
        run?.();
      }}
      onClose={close}
    />
  );

  return { guard, modal };
}
