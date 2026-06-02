/* Bulk cross-book duplicate review (fe-9).

   Wraps the per-pair `DuplicateReviewModal` in a per-series QUEUE: the voices
   view seeds this with every duplicate candidate detected within ONE series,
   and the user walks the whole list one pair at a time. Each pair offers the
   same three actions as the single-pair modal — link (api.linkPriorCharacter),
   variant (api.notLinkedTo), skip — plus a "Next" advance. After the last pair
   the modal closes.

   This component is intentionally self-contained: it hydrates each pair's
   foreign casts on demand (mirroring the voices view's `hydrateForeignCast`,
   scoped to the two books a pair touches) so the link/variant buttons enable
   without the parent having to pre-fetch. The parent supplies `onResolved` so
   it can reconcile its own detection sources (redux / foreign-cast cache) the
   same way the single-pair flow does — a resolved pair drops out of the
   parent's candidate memo, but the bulk queue keeps its OWN frozen order so
   advancing stays predictable. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DuplicateReviewModal,
  type DuplicateReviewPair,
  type DuplicateResolution,
} from './duplicate-review-modal';
import { api } from '../lib/api';
import { findCharacterForVoice } from '../lib/voice-character-link';
import type { DuplicateCandidate } from '../lib/cross-book-duplicates';
import type { Character } from '../lib/types';

interface BulkDuplicateReviewModalProps {
  open: boolean;
  /** Frozen, ordered candidate list for ONE series. The parent filters its
      `duplicateCandidates` to the series before passing them in; the queue
      order is captured on open and doesn't shift as pairs resolve. */
  candidates: DuplicateCandidate[];
  seriesName: string;
  /** The currently-open book id (null on the global #/voices tab). Used to
      resolve a pair side from redux instead of the foreign-cast cache. */
  currentBookId: string | null;
  /** Open book's cast from redux. */
  characters: Character[];
  onClose: () => void;
  /** Per-resolution callback so the parent reconciles its detection sources
      (redux / cache) exactly like the single-pair flow. */
  onResolved: (resolution: DuplicateResolution) => void;
}

export function BulkDuplicateReviewModal({
  open,
  candidates,
  seriesName,
  currentBookId,
  characters,
  onClose,
  onResolved,
}: BulkDuplicateReviewModalProps) {
  const [index, setIndex] = useState(0);
  /* Foreign casts hydrated for the pairs walked so far, keyed by bookId. */
  const [foreignCasts, setForeignCasts] = useState<Map<string, Character[]>>(() => new Map());
  const [fetching, setFetching] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  /* Books whose fetch is already in flight — a ref (not the `fetching` state)
     so the hydrate effect can dedupe WITHOUT taking `fetching` as a dep. A
     dep on a fresh-each-render Set would re-run the effect on every state
     update and its cleanup would abort the still-pending getBookState. */
  const inFlightRef = useRef<Set<string>>(new Set());

  /* Reset the walk every time the modal opens with a fresh queue. */
  useEffect(() => {
    if (open) setIndex(0);
  }, [open, candidates]);

  const total = candidates.length;
  const current = index < total ? candidates[index] : null;

  const advance = useCallback(() => {
    setIndex((i) => {
      const next = i + 1;
      if (next >= total) {
        onClose();
        return i;
      }
      return next;
    });
  }, [total, onClose]);

  /* Hydrate the current pair's foreign casts (the side(s) that aren't the
     open book). Scoped per-pair so we never fan out the whole series at once. */
  useEffect(() => {
    if (!open || !current) return;
    const bookIds = [current.a.voice.bookId, current.b.voice.bookId].filter(
      (id) => id !== currentBookId,
    );
    for (const bookId of new Set(bookIds)) {
      if (
        foreignCasts.has(bookId) ||
        failed.has(bookId) ||
        inFlightRef.current.has(bookId)
      ) {
        continue;
      }
      inFlightRef.current.add(bookId);
      setFetching((prev) => new Set(prev).add(bookId));
      api
        .getBookState(bookId)
        .then((res) => {
          const cast = res?.cast?.characters ?? [];
          if (cast.length === 0) throw new Error('book state has no cast');
          setForeignCasts((prev) => new Map(prev).set(bookId, cast));
        })
        .catch((err) => {
          console.warn('[bulk-duplicate] foreign cast hydrate failed', (err as Error).message);
          setFailed((prev) => new Set(prev).add(bookId));
        })
        .finally(() => {
          inFlightRef.current.delete(bookId);
          setFetching((prev) => {
            const next = new Set(prev);
            next.delete(bookId);
            return next;
          });
        });
    }
    /* No cleanup-abort: the fetches are idempotent (guarded by the ref +
       foreignCasts/failed) and short-lived; aborting on every dep change
       would cancel an in-flight resolve and wedge the loading state. */
  }, [open, current, currentBookId, foreignCasts, failed]);

  /* Resolve the current candidate into a live pair + loading/error state. A
     side reads from redux when it's the open book, else the hydrated cache. */
  const resolved = useMemo<{
    pair: DuplicateReviewPair | null;
    loading: boolean;
    hydrationError: string | null;
  }>(() => {
    if (!current) return { pair: null, loading: false, hydrationError: null };
    const resolveSide = (side: DuplicateCandidate['a']) => {
      const bookId = side.voice.bookId;
      const source =
        bookId === currentBookId ? characters : (foreignCasts.get(bookId) ?? null);
      const character = source ? (findCharacterForVoice(side.voice, source) ?? null) : null;
      return { voice: side.voice, character };
    };
    const a = resolveSide(current.a);
    const b = resolveSide(current.b);
    const bookIds = [current.a.voice.bookId, current.b.voice.bookId];
    const anyFailed = bookIds.some((id) => failed.has(id));
    const anyFetching = bookIds.some((id) => fetching.has(id));
    const allPresent = bookIds.every(
      (id) => id === currentBookId || foreignCasts.has(id),
    );
    const loading = !anyFailed && (anyFetching || !allPresent);
    const hydrationError = anyFailed
      ? 'Couldn’t load one book’s cast — Skip this pair or try again later.'
      : !loading && (!a.character || !b.character)
        ? 'One of these voices is no longer linked to a character. Skip this pair.'
        : null;
    return { pair: { a, b }, loading, hydrationError };
  }, [current, currentBookId, characters, foreignCasts, fetching, failed]);

  if (!open || !current) return null;

  return (
    <div data-testid="bulk-duplicate-review">
      {/* Per-series progress + Skip/Next controls sit above the reused
          single-pair modal. The single-pair modal renders its own overlay;
          this strip floats over it at the top so the user always sees where
          they are in the queue. */}
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-60 fade-in pointer-events-none">
        <div className="floating-pill-inverse rounded-full shadow-float px-4 py-2 flex items-center gap-3 pointer-events-auto">
          <span className="text-xs text-canvas/70 font-medium truncate max-w-56">
            {seriesName}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-canvas/15 text-canvas font-bold text-sm tabular-nums">
            {index + 1} / {total}
          </span>
          <button
            type="button"
            onClick={advance}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 min-h-[44px] sm:min-h-0"
          >
            {index + 1 >= total ? 'Skip & finish' : 'Skip → Next'}
          </button>
        </div>
      </div>

      <DuplicateReviewModal
        open
        pair={resolved.pair}
        loading={resolved.loading}
        hydrationError={resolved.hydrationError}
        onClose={onClose}
        onResolved={(resolution) => {
          onResolved(resolution);
          /* Advance to the next pair rather than closing — the bulk flow's
             whole point is walking the queue. The last pair closes via
             `advance`. */
          advance();
        }}
      />
    </div>
  );
}
