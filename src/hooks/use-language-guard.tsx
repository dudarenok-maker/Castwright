/* useLanguageGuard — the global host for the language-guard modal (#2246
   Task 9c). Mirrors the `useReverseLocalAnalyzerGuard` contract: a hook
   returning `{ guard, modal }`, called once in layout.tsx, with `{modal}`
   rendered near the end of the layout tree.

   The four 409 sites in src/lib/api.ts mark an unset book language with a 409
   body. Instead of surfacing the generic error toast for that case, the API
   layer routes the failure through this hook (via the shared
   language-guard-bus): `guard(selector, shape, onRetry, onDismiss)` resolves
   the book — analysis names it by `manuscriptId`, the other three by `bookId`
   — opens EditBookMetaModal in guard mode, the user chooses a language, the
   language patch is persisted, and `onRetry` re-runs the original call the
   unset language had failed. When the selector matches no library book the
   guard reports false so the API layer keeps its existing error path.
   Dismissing without saving calls `onDismiss` so value-returning callers can
   reject their awaiting promise instead of hanging on it.

   Shape 1 of three — the pre-flight 409. The sse and batch shapes are the
   next child (#2407). */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { libraryActions } from '../store/library-slice';
import { notificationsActions } from '../store/notifications-slice';
import { api } from '../lib/api';
import {
  EditBookMetaModal,
  type EditBookMetaPatch,
  type LanguageGuardShape,
} from '../modals/edit-book-meta';
import { setLanguageGuardHandler, type LanguageGuardSelector } from '../lib/language-guard-bus';
import type { LibraryBook } from '../lib/types';

interface PendingGuard {
  selector: LanguageGuardSelector;
  shape: LanguageGuardShape;
  retries: Array<() => void>;
  dismisses: Array<() => void>;
  sseSource?: 'analysis' | 'cast-design' | 'single-design' | 'generation';
}

export interface LanguageGuardResult {
  /** Open the guard modal for a book whose call just failed with a
      language-unset 409. `selector` names the book by `bookId` (splice,
      QA-repair, qwen voice-design) or `manuscriptId` (analysis), resolved
      against the loaded library. `onRetry` is re-run after the language is
      saved; `onDismiss`, when given, fires if the user closes the modal
      without saving. Returns true only when the selector matched a known book
      and the modal opened — false lets the caller keep its existing error
      path. */
  guard: (
    selector: LanguageGuardSelector,
    shape: LanguageGuardShape,
    onRetry: () => void,
    onDismiss?: () => void,
    sseSource?: 'analysis' | 'cast-design' | 'single-design' | 'generation',
  ) => boolean;
  /** Render once, near the end of the layout tree. The modal mounts only
      while a guard request is pending. */
  modal: ReactNode;
}

function resolveIn(
  books: LibraryBook[],
  selector: LanguageGuardSelector,
): LibraryBook | null {
  return 'bookId' in selector
    ? (books.find((b) => b.bookId === selector.bookId) ?? null)
    : (books.find((b) => b.manuscriptId === selector.manuscriptId) ?? null);
}

function selectorsEqual(a: LanguageGuardSelector, b: LanguageGuardSelector): boolean {
  if ('bookId' in a && 'bookId' in b) return a.bookId === b.bookId;
  if ('manuscriptId' in a && 'manuscriptId' in b) return a.manuscriptId === b.manuscriptId;
  return false;
}

export function useLanguageGuard(): LanguageGuardResult {
  const dispatch = useAppDispatch();
  /* Defensive read — tests routinely build configureStore() without every
     slice. Production always wires the library slice via src/store/index.ts. */
  const libraryBooks = useAppSelector((s) => s.library?.books ?? []);

  const [pending, setPending] = useState<PendingGuard | null>(null);

  const resolve = useCallback(
    (selector: LanguageGuardSelector) => resolveIn(libraryBooks, selector),
    [libraryBooks],
  );

  /* Registered as the live bus handler so the API layer can route a
     409 language-unset straight here without a React import. When the
     selector matches no library book the request is refused (false) so the
     caller's ordinary error path fires. When a guard is already pending for
     the same book (e.g., a multi-chapter splice batch), accumulate the retry
     instead of replacing it — all retries fire once the language is set. */
  const guard: LanguageGuardResult['guard'] = useCallback(
    (selector, shape, onRetry, onDismiss, sseSource) => {
      if (!resolve(selector)) return false;
      setPending((prev) => {
        if (prev && selectorsEqual(prev.selector, selector)) {
          // Same book already pending, accumulate the retry and dismiss.
          return {
            ...prev,
            retries: [...prev.retries, onRetry],
            dismisses: onDismiss ? [...prev.dismisses, onDismiss] : prev.dismisses,
          };
        }
        // Different book or no pending guard, create new.
        return {
          selector,
          shape,
          retries: [onRetry],
          dismisses: onDismiss ? [onDismiss] : [],
          sseSource,
        };
      });
      return true;
    },
    [resolve],
  );

  useEffect(() => {
    setLanguageGuardHandler((req) => guard(req.selector, req.shape, req.onRetry, req.onDismiss, req.sseSource));
    return () => setLanguageGuardHandler(null);
  }, [guard]);

  const close = useCallback(() => setPending(null), []);

  const book = pending ? resolve(pending.selector) : null;

  const modal = book && pending ? (
    <EditBookMetaModal
      open
      book={book}
      guard={pending.shape}
      sseSource={pending.sseSource}
      onClose={() => {
        const dismisses = pending.dismisses;
        close();
        dismisses.forEach((d) => d());
      }}
      onSave={async (patch: EditBookMetaPatch) => {
        /* Guard-mode save IS the retry gate: persist the chosen language,
           refresh the library so other surfaces see the set language, and
           return the write promise — the modal calls onRetry once it settles.
           `book` (not the selector) supplies the bookId, so the manuscriptId
           pathway still persists to the book the selector resolved. */
        await api.putBookState(book.bookId, { slice: 'state', patch });
        const fresh = await api.getLibrary().catch(() => null);
        if (fresh) dispatch(libraryActions.hydrate(fresh));
      }}
      onSaveError={(_error) => {
        /* Task 9 — guard-mode save failed. Surface the error as a toast
           instead of closing the modal, so the user can retry. */
        dispatch(notificationsActions.pushToast({
          kind: 'error',
          message: "Couldn't save the book's language — try again.",
        }));
      }}
      onRetry={() => {
        const retries = pending.retries;
        close();
        retries.forEach((r) => r());
      }}
    />
  ) : null;

  return { guard, modal };
}
