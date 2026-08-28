/* language-guard-bus — the seam between the non-React API layer and the
   React language-guard modal (#2246 Task 9c).

   The four pre-flight 409 sites live in `src/lib/api.ts` (splice, audio
   QA-repair, analysis, qwen voice-design), which is not a React module and
   cannot call a hook. This module is the bridge: `useLanguageGuard` registers
   a handler on mount; the API layer, when it sees a 409 whose body marks an
   unset book language, calls `emitLanguageGuard` with a *selector* (bookId or
   manuscriptId) plus the retry callback. The handler resolves the selector
   against the loaded library, opens the modal in guard mode, and on save
   persists the chosen language and re-runs the original call via `onRetry`.

   Why a selector and not a bare bookId: analysis (realAnalyseManuscript) is
   manuscript-scoped — its client signature carries a `manuscriptId`, never a
   bookId — while splice, QA-repair and qwen voice-design are book-scoped. The
   handler resolves either id off the same library array, so the analysis site
   needs no caller-level bookId threading.

   `emitLanguageGuard` returns whether the request was actually resolved and
   handled. "Resolved" means the selector matched a book in the loaded library.
   When nothing matches (or no handler is mounted) the API layer must fall back
   to its usual error path, so the bus reports that outcome (false) rather than
   assuming a modal opened.

   The detector lives here too so the API layer and the tests share one
   implementation, and so the two body shapes are both covered. */

import type { LanguageGuardShape } from '../modals/edit-book-meta';

/** The action that triggered an sse-shaped language guard, determining which
    copy the modal displays. One of the four server-side sources that can emit
    a language-unset error during streaming. */
export type SseSource = 'analysis' | 'cast-design' | 'single-design' | 'generation';

/** Name the failing book. Splice / QA-repair / qwen voice-design are
    book-scoped (`bookId`); analysis is manuscript-scoped (`manuscriptId`). */
export type LanguageGuardSelector = { bookId: string } | { manuscriptId: string };

export interface LanguageGuardRequest {
  selector: LanguageGuardSelector;
  shape: LanguageGuardShape;
  /** The original action that failed because the language was unset. Called
      after the language patch is saved in guard mode. For value-returning
      sites (analysis, qwen) the retry must deliver its value to the awaiting
      caller. */
  onRetry: () => void;
  /** Called when the user dismisses the modal without saving. Value-returning
      sites reject their awaiting caller with the original error here, so a
      dismissed guard never leaves the UI hanging on a parked promise. */
  onDismiss?: () => void;
  /** For sse shape only: identifies which action triggered the guard, so
      the modal can show source-appropriate copy (e.g., "analysis" vs
      "cast-design" vs "generation"). Unused for 409/batch shapes. */
  sseSource?: SseSource;
}

/** Returns true when it accepted the request — i.e. resolved the selector to a
    known book and opened the modal — and false when it could not (no handler
    mounted, or the selector matched no library book). */
type LanguageGuardHandler = (req: LanguageGuardRequest) => boolean;

let currentHandler: LanguageGuardHandler | null = null;

/** Register the runtime's single language-guard modal handler. The hook calls
    this on mount and clears it on unmount, so exactly one handler is live at a
    time (the layout hosts one instance). */
export function setLanguageGuardHandler(handler: LanguageGuardHandler | null): void {
  currentHandler = handler;
}

/** Route a language-unset failure to the guard modal. Returns true only when a
    handler was live AND resolved the request (so the API layer knows it should
    NOT surface its usual generic error), false when no handler is mounted or
    the selector matched no library book (the caller keeps its existing error
    path). */
export function emitLanguageGuard(req: LanguageGuardRequest): boolean {
  if (!currentHandler) return false;
  return currentHandler(req);
}

/** True when an HTTP response body marks an unset book language. The four 409
    sites split the marker across two fields:
      - chapter-splice / chapter-qa-repair / analysis send
        `{ error: 'language_unset' }` (no `code` at all);
      - qwen-voice sends `{ error: <human message>, code: 'language_unset' }`.
    A detector that checks only one of the two fields silently misses a quarter
    of the surface, so both are checked. */
export function isLanguageUnsetBody(status: number, body: string): boolean {
  if (status !== 409) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    return parsed.error === 'language_unset' || parsed.code === 'language_unset';
  } catch {
    return false;
  }
}
