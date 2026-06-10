/* Share-link modal — plan 67. Opened from the Listen view's
   "Streaming link" download tile. Renders a freshly-minted share URL
   in a copy-to-clipboard read-only input, with status flips (idle →
   copied → idle) on click.

   The mint happens on the parent before this modal opens (the
   Streaming-link tile's onDownload calls `api.createBookShareLink(bookId)`
   and only opens the modal after the POST resolves). That keeps the
   modal a pure presenter — no async lifecycle, no spinner state to
   pin down in tests. Failures surface as a toast on the parent (same
   pattern as the export modal's mint path).

   Copy semantics:
   - The modal pre-focuses the URL input on mount so the user can
     Cmd/Ctrl+C without reaching for the button.
   - The Copy button calls `navigator.clipboard.writeText(url)`. The
     test environment (jsdom) doesn't provide a real Clipboard API by
     default; the production build always has it; we don't fall back
     to `document.execCommand('copy')` (deprecated since 2024). When
     the call rejects, the button label flips to "Copy failed" for
     1.5 s and the parent surfaces a toast.
   - Click-outside / Escape closes the modal — same behaviour as the
     confirm-dialog primitive. */

import { useEffect, useRef, useState } from 'react';
import { IconClose, IconCopy, IconCheck, IconLink } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { MADE_WITH, DOMAIN } from '../lib/brand';

export interface ShareLinkModalProps {
  open: boolean;
  /** URL to display + copy. Null while the parent's mint is still
      in-flight; the modal renders a quiet placeholder so callers can
      open optimistically rather than racing the async-then-open. */
  url: string | null;
  onClose: () => void;
  /** Optional hook for the parent to surface a clipboard-failure
      toast through its notification slice. Receives the underlying
      error message (or an empty string when the rejection carried
      no detail). */
  onCopyFailed?: (reason: string) => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function ShareLinkModal({ open, url, onClose, onCopyFailed }: ShareLinkModalProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* Reset copy state every time the modal opens for a new URL so a
     re-open after a previous "Copied" doesn't flash the green tick
     before the user actually clicks. */
  useEffect(() => {
    if (open) {
      setCopyState('idle');
      /* Focus on next tick so the input has mounted. select() puts
         the whole URL into the user's selection — Cmd/Ctrl+C copies
         without the round-trip through the Copy button. */
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, url]);

  /* Escape closes — same affordance as ConfirmDialog. */
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async () => {
    if (!url) return;
    try {
      /* `navigator.clipboard` is only present on secure contexts. The
         dev server runs on http://localhost which IS a secure context
         for permissions purposes; production hits via https or
         localhost will both have it. Tests mock this. */
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      /* Flip back after 1.5 s so a second click works visually. */
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (e) {
      setCopyState('failed');
      onCopyFailed?.(e instanceof Error ? e.message : '');
      setTimeout(() => setCopyState('idle'), 1500);
    }
  };

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          data-testid="share-link-modal"
          className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full grid place-items-center shrink-0 bg-peach/15 text-magenta">
              <IconLink className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Streaming link
              </p>
              <h3 className="text-base font-bold text-ink truncate">Share this audiobook</h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed space-y-4">
            <p>
              Anyone with this link can stream or download the M4B copy of this audiobook. The link
              keeps working until you delete the book.
            </p>
            <div className="flex items-stretch gap-2">
              <input
                ref={inputRef}
                data-testid="share-link-url"
                readOnly
                value={url ?? ''}
                placeholder={url == null ? 'Generating link…' : ''}
                className="flex-1 min-w-0 rounded-full border border-ink/10 px-4 py-2 text-xs font-mono text-ink/80 bg-ink/3 focus:outline-hidden focus:ring-2 focus:ring-magenta/40"
                aria-label="Share URL"
              />
              <button
                data-testid="share-link-copy"
                onClick={handleCopy}
                disabled={url == null}
                className={
                  copyState === 'copied'
                    ? 'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-colors bg-emerald-50 text-emerald-700'
                    : copyState === 'failed'
                      ? 'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-colors bg-red-50 text-red-700'
                      : url == null
                        ? 'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-colors bg-ink/3 text-ink/40 cursor-not-allowed'
                        : 'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-colors bg-ink text-canvas hover:bg-ink/90'
                }
              >
                {copyState === 'copied' ? (
                  <>
                    <IconCheck className="w-3.5 h-3.5" /> Copied
                  </>
                ) : copyState === 'failed' ? (
                  <>Copy failed</>
                ) : (
                  <>
                    <IconCopy className="w-3.5 h-3.5" /> Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-xs text-ink/55">
              The link resolves to the latest M4B export for this book. If no M4B has finished yet,
              the recipient will see a "Build an M4B first" message — kick off the M4B export from
              this page to make the link live.
            </p>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <span className="text-[11px] text-ink/40">{`${MADE_WITH} · ${DOMAIN}`}</span>
            <div className="flex items-center gap-3">
              <PrimaryButton variant="dark" onClick={onClose}>
                Done
              </PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
