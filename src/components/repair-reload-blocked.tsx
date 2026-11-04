/* #3713 — the fallback when the repaired-id reload would loop (lib/repair-epoch.ts): the page was refused
   as older than a duplicate-bookId repair more times in a few minutes than a reload can explain, so it stops
   reloading itself, holds every write, and says so. Mounted once in layout.tsx; renders nothing otherwise. */

import { useSyncExternalStore } from 'react';
import { isRepairReloadBlocked, subscribeRepairReloadBlocked } from '../lib/repair-epoch';

export function RepairReloadBlocked() {
  const blocked = useSyncExternalStore(subscribeRepairReloadBlocked, isRepairReloadBlocked);
  if (!blocked) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="repair-reload-blocked-title"
        data-testid="repair-reload-blocked"
        className="max-w-md rounded-xl border border-magenta/20 bg-white px-5 py-4 text-ink shadow-xl"
      >
        <h2 id="repair-reload-blocked-title" className="text-base font-semibold">
          Castwright can&apos;t save changes right now
        </h2>
        <p className="mt-2 text-sm">
          A book in your library was given a new ID, and this page keeps loading from before that. Your last change
          was not saved. Reload the page to carry on. If this keeps happening, restart Castwright.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-[44px] fine-pointer:min-h-0 rounded-lg bg-magenta px-4 py-1.5 text-sm font-medium text-white"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
