import { useEffect, useRef, useState } from 'react';
import type { SeriesMemoryDetail } from '../../lib/types';
import { IconClose } from '../../lib/icons';
import { SeriesShareCard } from './series-share-card';

export function slugifyFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'series';
}

function downloadJson(detail: SeriesMemoryDetail, seriesName: string) {
  const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugifyFilename(seriesName)}-series-memory.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ShareCardModal({
  detail,
  seriesName,
  owner,
  onClose,
}: {
  detail: SeriesMemoryDetail;
  seriesName: string;
  owner?: string;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  async function downloadPng() {
    const node = cardRef.current;
    if (!node) return;
    setBusy(true);
    setError(false);
    try {
      const { toPng } = await import('html-to-image');
      await document.fonts?.ready;
      const url = await toPng(node, { pixelRatio: 2, cacheBust: true });
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugifyFilename(seriesName)}-series-cast.png`;
      a.click();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="share-card-heading"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4"
      onClick={onClose}
    >
      <div
        className="relative bg-[#1b1714] text-cream rounded-2xl p-6 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button — mirrors series-memory-reveal.tsx pattern */}
        <div className="flex justify-end mb-2">
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/10 text-cream/60"
            aria-label="Close"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <p id="share-card-heading" className="sr-only">
          Share series memory card for {seriesName}
        </p>

        <div ref={cardRef} className="w-full max-w-sm mx-auto">
          <SeriesShareCard detail={detail} seriesName={seriesName} owner={owner} />
        </div>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => downloadJson(detail, seriesName)}
            className="rounded-full px-5 py-2.5 font-semibold text-ink bg-gradient-to-r from-magenta to-peach"
          >
            Download data (.json)
          </button>
          <button
            onClick={downloadPng}
            disabled={busy}
            className="rounded-full px-5 py-2.5 font-semibold text-cream border border-cream/30 hover:bg-white/10 disabled:opacity-60"
          >
            {busy ? 'Rendering…' : 'Download image (.png)'}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-center text-xs text-peach">
            Couldn't render the image — try again.
          </p>
        )}
      </div>
    </div>
  );
}
