/** Format seconds as MM:SS or HH:MM:SS — matches the existing `duration`
    string convention in state.json (`'00:00'` placeholder from analysis)
    and the frontend's `src/lib/time.ts:formatDuration`. Shared between the
    generation route (per-chapter completion writes the value) and the
    library scan (legacy chapters get the value lazily backfilled from
    their segments.json sibling). */
export function formatDuration(totalSec: number): string {
  const total = Math.max(0, Math.round(totalSec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
