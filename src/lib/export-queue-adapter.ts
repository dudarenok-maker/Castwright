/* Map a `BookExportJob` from the server into the visual `ExportQueueItem`
   shape the Listen view's queue rail (and the Export modal) render.

   The wire shape carries machine fields (bytes, ISO timestamps, paths);
   the queue item is the human-readable rendering of those — formatted
   size, relative time, destination copy. Keeping the adapter here means
   the row component never has to know what the API looks like. */

import type { BookExportJob, ExportQueueItem } from './types';

const FORMAT_TO_VIEW: Record<BookExportJob['format'], ExportQueueItem['format']> = {
  'mp3-zip':    'zip',
  'm4b':        'm4b',
  /* mp3-folder artifacts are a directory tree on disk; the queue row's
     format badge surfaces 'mp3' (the per-file container) since the user
     thinks in terms of "this is a folder of MP3s". */
  'mp3-folder': 'mp3',
};

export function bookExportJobToQueueItem(job: BookExportJob): ExportQueueItem {
  return {
    id:          job.id,
    filename:    job.filename,
    format:      FORMAT_TO_VIEW[job.format] ?? 'zip',
    size:        formatSize(job.sizeBytes ?? null),
    /* queued → in_progress (the rail shows them the same); cancelled →
       failed visually, with errorReason='Cancelled by user.' carried
       through. The modal dismisses cancelled jobs synchronously so the
       mapping mostly matters for any other surface that polls them. */
    status:      job.status === 'queued'    ? 'in_progress'
              :  job.status === 'cancelled' ? 'failed'
              :  job.status,
    timestamp:   relativeTime(job.completedAt ?? job.createdAt),
    destination: destinationLabel(job),
    progress:    job.progress ?? undefined,
    url:         job.downloadUrl ?? undefined,
    errorReason: job.errorReason ?? undefined,
  };
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function destinationLabel(job: BookExportJob): string {
  if (job.destination === 'sync-folder') {
    return job.syncPath ? `Sync folder · ${job.syncPath}` : 'Sync folder';
  }
  return 'Local download';
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const delta = Date.now() - then;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return `${Math.floor(delta / 86_400_000)} day${Math.floor(delta / 86_400_000) === 1 ? '' : 's'} ago`;
}
