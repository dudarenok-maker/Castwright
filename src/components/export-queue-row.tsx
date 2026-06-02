/* Single row of the export queue, extracted from views/listen.tsx so the
   Export modal can reuse the exact same visual treatment as the rail.

   Renders an `ExportQueueItem`. Live `BookExportJob`s coming back from
   the server are mapped into this shape via `bookExportJobToQueueItem`
   in src/lib/export-queue-adapter.ts so the row stays decoupled from
   the wire format. */

import {
  IconCheckCircle,
  IconSpinner,
  IconWarning,
  IconClock,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconTrash,
} from '../lib/icons';
import type { ExportQueueItem } from '../lib/types';

interface Props {
  item: ExportQueueItem;
  onDownload?: (item: ExportQueueItem) => void;
  onCopyLink?: (item: ExportQueueItem) => void;
  onRetry?: (item: ExportQueueItem) => void;
  onRemove?: (item: ExportQueueItem) => void;
}

export function ExportQueueRow({ item, onDownload, onCopyLink, onRetry, onRemove }: Props) {
  const formatBadge = (
    {
      m4b: { color: '#A43C6C', label: 'M4B' },
      m4a: { color: '#F79A83', label: 'M4A' },
      mp3: { color: '#6B6663', label: 'MP3' },
      zip: { color: '#7C5C8C', label: 'ZIP' },
      link: { color: '#3C194F', label: 'URL' },
    } as Record<string, { color: string; label: string }>
  )[item.format] || { color: '#6B6663', label: item.format.toUpperCase() };

  const statusUI = {
    done: (
      <span className="inline-flex items-center gap-1.5 text-emerald-700">
        <IconCheckCircle className="w-3.5 h-3.5" /> Done
      </span>
    ),
    in_progress: (
      <span className="inline-flex items-center gap-1.5 text-magenta">
        <IconSpinner className="w-3.5 h-3.5" /> Running…
      </span>
    ),
    failed: (
      <span className="inline-flex items-center gap-1.5 text-rose-600">
        <IconWarning className="w-3.5 h-3.5" /> Failed
      </span>
    ),
  }[item.status];

  /* Buttons are enabled only when the parent wired a handler. The Listen
     rail passes no handlers — its rows are passive history; the modal
     wires onDownload for the active job. */
  const interactiveClass = 'p-1.5 rounded-full text-ink/60 hover:text-ink hover:bg-ink/4';
  const disabledClass = 'p-1.5 rounded-full text-ink/30 cursor-not-allowed';

  return (
    <div className="grid grid-cols-[44px_1fr_120px_120px_140px_120px] items-center gap-4 px-5 py-3.5 text-sm hover:bg-ink/2 transition-colors">
      <span
        className="w-10 h-10 rounded-xl grid place-items-center text-white font-bold text-[10px] tracking-wider"
        style={{ background: formatBadge.color }}
      >
        {formatBadge.label}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-ink truncate">{item.filename}</span>
        {item.errorReason ? (
          <span className="block text-[11px] text-rose-600 truncate mt-0.5">
            {item.errorReason}
          </span>
        ) : (
          <span className="block text-[11px] text-ink/55 truncate mt-0.5">{item.destination}</span>
        )}
        {item.status === 'in_progress' && (
          <div className="mt-1.5 h-1 rounded-full bg-ink/6 overflow-hidden max-w-[280px] relative">
            <div
              className="h-full rounded-full bg-gradient-progress pulse-bar"
              style={{ width: `${(item.progress || 0) * 100}%` }}
            >
              <div className="absolute inset-0 stripe-travel" />
            </div>
          </div>
        )}
      </span>
      <span className="text-xs tabular-nums text-ink/60">{item.size}</span>
      <span className="text-xs text-ink/55 inline-flex items-center gap-1.5">
        <IconClock className="w-3 h-3" />
        {item.timestamp}
      </span>
      <span className="text-xs">{statusUI}</span>
      <span className="flex items-center justify-end gap-1">
        {item.status === 'done' &&
          (item.url ? (
            onCopyLink ? (
              <button
                onClick={() => onCopyLink(item)}
                title="Copy link"
                className={interactiveClass}
              >
                <IconCopy className="w-4 h-4" />
              </button>
            ) : (
              <button disabled title="Copy link — coming soon" className={disabledClass}>
                <IconCopy className="w-4 h-4" />
              </button>
            )
          ) : onDownload ? (
            <button onClick={() => onDownload(item)} title="Download" className={interactiveClass}>
              <IconDownload className="w-4 h-4" />
            </button>
          ) : (
            <button disabled title="Download — coming soon" className={disabledClass}>
              <IconDownload className="w-4 h-4" />
            </button>
          ))}
        {item.status === 'failed' &&
          (onRetry ? (
            <button onClick={() => onRetry(item)} title="Retry" className={interactiveClass}>
              <IconRefresh className="w-4 h-4" />
            </button>
          ) : (
            <button disabled title="Retry — coming soon" className={disabledClass}>
              <IconRefresh className="w-4 h-4" />
            </button>
          ))}
        {onRemove ? (
          <button onClick={() => onRemove(item)} title="Remove" className={interactiveClass}>
            <IconTrash className="w-4 h-4" />
          </button>
        ) : (
          <button disabled title="Remove — coming soon" className={disabledClass}>
            <IconTrash className="w-4 h-4" />
          </button>
        )}
      </span>
    </div>
  );
}
