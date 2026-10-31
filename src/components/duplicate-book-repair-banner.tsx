/* #3713 — duplicate-bookId repair notice. Renders at the top of every view
   (mounted in layout.tsx after SettingsCorruptBanner) when the server's startup
   sweep gave a twin book a new id. Self-gated on GET /api/info
   duplicateBookIdRepairs; dark in mock mode (no repairs). Dismissal is per
   browser, keyed by newBookId in localStorage; every storage access is guarded
   so a throwing store still renders the banner and dismissal holds in state. */

import { useState } from 'react';
import { useAppInfo } from '../lib/use-app-info';

const STORAGE_KEY = 'castwright.dismissedDuplicateBookRepairs';

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — session state still holds the dismissal */
  }
}

export function DuplicateBookRepairBanner() {
  const { info } = useAppInfo();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const repairs = (info?.duplicateBookIdRepairs ?? []).filter((r) => !dismissed.includes(r.newBookId));
  if (repairs.length === 0) return null;

  const dismissAll = () => {
    const next = [...new Set([...dismissed, ...repairs.map((r) => r.newBookId)])];
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div
      role="status"
      data-testid="duplicate-book-repair-banner"
      className="mx-4 mt-3 rounded-xl border border-magenta/20 bg-peach/40 px-4 py-3 text-ink"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 text-sm">
          {repairs.map((r) => (
            <p key={r.newBookId}>
              Two books were sharing one ID, so Castwright gave one of them its own.{' '}
              <strong>{r.keptFolder}</strong>, the one with more of your work, kept its ID, along with its queue and
              backups. <strong>{r.reassignedFolder}</strong> has a new ID and starts with an empty queue and no backups.
            </p>
          ))}
        </div>
        <button
          type="button"
          onClick={dismissAll}
          className="min-h-[44px] fine-pointer:min-h-0 shrink-0 rounded-lg px-3 py-1 text-xs font-medium text-ink/70 hover:bg-white/60"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
