/* useLanguageGuard — the global host for the language-guard modal (#2246
   Task 9c). Mirrors the `useReverseLocalAnalyzerGuard` contract: a hook
   returning `{ guard, modal }`, called once in layout.tsx, with `{modal}`
   rendered near the end of the layout tree.

   The four 409 sites in src/lib/api.ts mark an unset book language with a
   409 body. Instead of surfacing the generic error toast for that case, the
   API layer routes the failure through this hook (via the shared
   language-guard-bus): `guard(bookId, shape, onRetry)` opens
   EditBookMetaModal in guard mode, the user chooses a language, the language
   patch is persisted, and `onRetry` re-runs the original call that the unset
   language had failed.

   Shape 1 of three — the pre-flight 409. The sse and batch shapes are the
   next child (#2407). */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { libraryActions } from '../store/library-slice';
import { api } from '../lib/api';
import {
  EditBookMetaModal,
  type EditBookMetaPatch,
  type LanguageGuardShape,
} from '../modals/edit-book-meta';
import { setLanguageGuardHandler } from '../lib/language-guard-bus';

interface PendingGuard {
  bookId: string;
  shape: LanguageGuardShape;
  onRetry: () => void;
}

export interface LanguageGuardResult {
  /** Open the guard modal for a book whose call just failed with a
      language-unset 409. `onRetry` is re-run after the language is saved. */
  guard: (bookId: string, shape: LanguageGuardShape, onRetry: () => void) => void;
  /** Render once, near the end of the layout tree. The modal mounts only
      while a guard request is pending. */
  modal: ReactNode;
}

export function useLanguageGuard(): LanguageGuardResult {
  const dispatch = useAppDispatch();
  /* Defensive read — tests routinely build configureStore() without every
     slice. Production always wires the library slice via src/store/index.ts. */
  const libraryBooks = useAppSelector((s) => s.library?.books ?? []);

  const [pending, setPending] = useState<PendingGuard | null>(null);

  /* Registered as the live bus handler so the API layer can route a
     409 language-unset straight here without a React import. */
  const guard: LanguageGuardResult['guard'] = useCallback(
    (bookId, shape, onRetry) => setPending({ bookId, shape, onRetry }),
    [],
  );

  useEffect(() => {
    setLanguageGuardHandler((req) => guard(req.bookId, req.shape, req.onRetry));
    return () => setLanguageGuardHandler(null);
  }, [guard]);

  const close = useCallback(() => setPending(null), []);

  const book = pending
    ? (libraryBooks.find((b) => b.bookId === pending.bookId) ?? null)
    : null;

  const modal = book && pending ? (
    <EditBookMetaModal
      open
      book={book}
      guard={pending.shape}
      onClose={close}
      onSave={async (patch: EditBookMetaPatch) => {
        /* Guard-mode save IS the retry gate: persist the chosen language,
           refresh the library so other surfaces see the set language, and
           return the write promise — the modal calls onRetry once it settles. */
        await api.putBookState(pending.bookId, { slice: 'state', patch });
        const fresh = await api.getLibrary().catch(() => null);
        if (fresh) dispatch(libraryActions.hydrate(fresh));
      }}
      onRetry={() => {
        const retry = pending.onRetry;
        close();
        retry();
      }}
    />
  ) : null;

  return { guard, modal };
}
