/* Amber banner shown when a sidecar-restart setting has changed.
   Mirrors the "Restart the server to apply this change." pill style used
   in model-settings-form.tsx / account.tsx, scaled up to a full-width banner
   with a call-to-action button. Purely presentational — no slice access. */

export interface RestartSidecarBannerProps {
  visible: boolean;
  onRestart: () => void;
  restarting?: boolean;
}

export function RestartSidecarBanner({
  visible,
  onRestart,
  restarting = false,
}: RestartSidecarBannerProps) {
  if (!visible) return null;

  return (
    <div className="flex items-center gap-4 flex-wrap rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3">
      <p className="flex-1 text-sm text-amber-800">
        Voice-engine setting changed — restart the sidecar to apply.
      </p>
      <button
        type="button"
        onClick={onRestart}
        disabled={restarting}
        className="shrink-0 px-4 py-2 rounded-xl border border-amber-300 bg-amber-100 text-sm font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
      >
        {restarting ? 'Restarting…' : 'Restart sidecar'}
      </button>
    </div>
  );
}
