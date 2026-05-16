/* CoverPicker modal — shown from the library card's "..." menu and the
   Listen view's hover button. Calls api.findCoverCandidates on open,
   renders up to 6 OpenLibrary thumbnails in a 2x3 grid, and POSTs the
   user's choice via api.setCover. A "Remove cover" button below the grid
   reverts to the procedural gradient. The on-disk image lives at
   <bookDir>/.audiobook/cover.jpg server-side; this modal owns the
   user-facing picking step. */

import { useCallback, useEffect, useState } from 'react';
import { IconClose, IconImage, IconRefresh } from '../lib/icons';
import { api } from '../lib/api';
import type { CoverCandidate } from '../lib/types';

interface Props {
  open: boolean;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  /** Currently-selected cover URL (server-relative). When present, the
      modal renders a "Remove cover" button. */
  currentCoverUrl?: string;
  onClose: () => void;
  /** Fires after a successful pick or remove. The new value is the
      server-relative URL (empty string when removed). The parent should
      refresh the library so the card and Listen header repaint. */
  onPicked: (coverImageUrl: string) => void;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; candidates: CoverCandidate[] }
  | { kind: 'error'; message: string };

export function CoverPicker({ open, bookId, bookTitle, bookAuthor, currentCoverUrl, onClose, onPicked }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  /* Tracks the candidate the user just clicked, so we can disable the
     whole grid + spotlight the picked tile during the round-trip. */
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const { candidates } = await api.findCoverCandidates(bookId);
      setState({ kind: 'ready', candidates });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message || 'Failed to load covers.' });
    }
  }, [bookId]);

  useEffect(() => {
    if (open) {
      setSubmitting(null);
      setRemoving(false);
      void load();
    } else {
      setState({ kind: 'idle' });
    }
  }, [open, load]);

  if (!open) return null;

  async function pick(candidate: CoverCandidate) {
    setSubmitting(candidate.openLibraryId);
    try {
      const { coverImageUrl } = await api.setCover(bookId, candidate.openLibraryId);
      onPicked(coverImageUrl);
      onClose();
    } catch (e) {
      setSubmitting(null);
      setState({ kind: 'error', message: (e as Error).message || 'Failed to save cover.' });
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api.removeCover(bookId);
      onPicked('');
      onClose();
    } catch (e) {
      setRemoving(false);
      setState({ kind: 'error', message: (e as Error).message || 'Failed to remove cover.' });
    }
  }

  const busy = submitting !== null || removing;

  return (
    <>
      <div onClick={busy ? undefined : onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in"/>
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div data-testid="cover-picker"
             className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta shrink-0">
              <IconImage className="w-4 h-4"/>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Find cover image</p>
              <h3 className="text-base font-bold text-ink truncate">{bookTitle}</h3>
            </div>
            <button onClick={onClose} disabled={busy}
                    className="p-2 rounded-full hover:bg-ink/5 text-ink/60 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Close">
              <IconClose className="w-4 h-4"/>
            </button>
          </div>

          <div className="px-6 py-5">
            {state.kind === 'loading' && (
              <CoverGridSkeleton/>
            )}
            {state.kind === 'error' && (
              <div className="py-6 text-center">
                <p className="text-sm text-red-700 mb-4">{state.message}</p>
                <button onClick={() => void load()}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink hover:bg-ink/[0.04]">
                  <IconRefresh className="w-4 h-4"/> Try again
                </button>
              </div>
            )}
            {state.kind === 'ready' && state.candidates.length === 0 && (
              <p className="py-10 text-center text-sm text-ink/60">
                No covers found for <span className="font-semibold text-ink">{bookTitle}</span>
                {bookAuthor ? <> by <span className="font-semibold text-ink">{bookAuthor}</span></> : null}
                {' '}on OpenLibrary.
              </p>
            )}
            {state.kind === 'ready' && state.candidates.length > 0 && (
              <div data-testid="cover-grid" className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {state.candidates.map(c => (
                  <button
                    key={c.openLibraryId}
                    data-testid={`cover-candidate-${c.openLibraryId}`}
                    onClick={() => void pick(c)}
                    disabled={busy}
                    className={`group relative rounded-2xl overflow-hidden border bg-canvas aspect-[2/3] focus:outline-none transition-shadow ${submitting === c.openLibraryId ? 'border-magenta ring-2 ring-magenta/30' : 'border-ink/10 hover:shadow-card hover:border-ink/20'} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <img
                      src={c.coverUrl}
                      alt={c.edition ? `${bookTitle} — ${c.edition}` : bookTitle}
                      className="absolute inset-0 w-full h-full object-cover"
                      loading="lazy"
                    />
                    {c.edition && (
                      <span className="absolute bottom-0 inset-x-0 px-2 py-1 bg-ink/70 text-white text-[10px] leading-tight truncate">
                        {c.edition}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-ink/50">
              Covers from <a className="underline" href="https://openlibrary.org" target="_blank" rel="noreferrer">OpenLibrary</a>.
              Click a cover to use it.
            </p>
            <div className="flex items-center gap-3">
              {currentCoverUrl && (
                <button onClick={() => void remove()}
                        disabled={busy}
                        className="text-sm font-medium text-red-700 hover:text-red-800 disabled:opacity-40 disabled:cursor-not-allowed">
                  Remove cover
                </button>
              )}
              <button onClick={onClose} disabled={busy}
                      className="text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed">
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function CoverGridSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-2xl bg-ink/[0.06] aspect-[2/3] pulse-bar"/>
      ))}
    </div>
  );
}
