/* Amber notice shown when `server/.env` has leftover-default env locks
   (`envCleanupCandidates` on GET /api/config). Mirrors
   restart-sidecar-banner.tsx's shape — presentational, no slice access —
   scaled to a count + button instead of a static message. Renders nothing
   once resolved: driven entirely by `candidateCount`, not a local
   dismissed flag, so a fresh fetchConfig() naturally clears it. */

export interface EnvCleanupNoticeProps {
  candidateCount: number;
  onCleanup: () => void;
  busy?: boolean;
}

export function EnvCleanupNotice({
  candidateCount,
  onCleanup,
  busy = false,
}: EnvCleanupNoticeProps) {
  if (candidateCount === 0) return null;

  const settingWord = candidateCount === 1 ? 'setting' : 'settings';
  const lookWord = candidateCount === 1 ? 'looks' : 'look';

  return (
    <div className="flex items-center gap-4 flex-wrap rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3">
      <p className="flex-1 text-sm text-amber-800">
        {candidateCount} {settingWord} {lookWord} like leftover defaults from an older install.
      </p>
      <button
        type="button"
        onClick={onCleanup}
        disabled={busy}
        className="shrink-0 px-4 py-2 rounded-xl border border-amber-300 bg-amber-100 text-sm font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] fine-pointer:min-h-0"
      >
        {busy ? 'Cleaning up…' : 'Clean up'}
      </button>
    </div>
  );
}
