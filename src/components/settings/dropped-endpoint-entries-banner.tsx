/* #3084 P31 — analyzer endpoint entries dropped when settings were read. A malformed entry is
   removed so the rest of the settings still load, and a copy is archived first. Every entry the
   settings GET lists is unacknowledged; "Got it" acknowledges one whose copy exists. */
import { useAppDispatch, useAppSelector } from '../../store';
import { acknowledgeDroppedEndpointEntries } from '../../store/account-slice';
import type { components } from '../../lib/api-types';

type DroppedEntry = components['schemas']['DroppedEndpointEntrySummary'];

export const DROPPED_ENTRIES_ARCHIVE_FILE = 'user-settings.invalid-endpoints.json';

function entryName(e: DroppedEntry): string {
  if (e.kind === 'key') {
    return `The API key for ${e.endpointId ? `endpoint "${e.endpointId}"` : 'an endpoint'}${e.origin ? ` (${e.origin})` : ''}`;
  }
  if (e.name) return `Endpoint "${e.name}"`;
  return e.endpointId ? `Endpoint "${e.endpointId}"` : 'An endpoint entry';
}

export function DroppedEndpointEntriesBanner() {
  const dispatch = useAppDispatch();
  const entries = useAppSelector((s) => s.account.droppedEndpointEntries) ?? [];
  if (entries.length === 0) return null;
  return (
    <div role="alert" data-testid="dropped-endpoint-banner" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
      <p className="font-medium">Some analyzer endpoint settings were malformed and were removed</p>
      <p>Castwright removed them when it read your settings, so the rest of your settings still load. Add them again in Model Manager → Analyzer endpoints.</p>
      <ul className="space-y-2">
        {entries.map((e, i) => {
          const archiveId = typeof e.archiveId === 'string' ? e.archiveId : null;
          return (
            <li key={archiveId ?? `pending-${i}`} data-testid="dropped-endpoint-entry" className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                <span className="font-medium">{entryName(e)}</span>: {e.issues.join('; ')}.{' '}
                {archiveId !== null ? (
                  <>A copy was saved to <code>{DROPPED_ENTRIES_ARCHIVE_FILE}</code>, next to <code>user-settings.json</code> in your workspace folder.</>
                ) : (
                  <>Its archive copy is still pending: it is written to <code>{DROPPED_ENTRIES_ARCHIVE_FILE}</code> on the next settings read, and it can be dismissed after that.</>
                )}
              </span>
              {archiveId !== null && (
                <button
                  type="button"
                  data-testid={`dropped-endpoint-ack-${archiveId}`}
                  onClick={() => void dispatch(acknowledgeDroppedEndpointEntries([archiveId]))}
                  className="px-3 py-1 rounded-full border border-amber-400 min-h-[44px] fine-pointer:min-h-0"
                >
                  Got it
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
