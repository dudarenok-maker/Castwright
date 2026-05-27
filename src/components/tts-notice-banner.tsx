import { IconClose } from '../lib/icons';

interface TtsNoticeBannerProps {
  /** "Analyzer unloaded to free VRAM for TTS." — emerald info line. */
  evictionNotice: string | null;
  /** Rose alert line when a Load/Stop returns {status:'error'} or throws. */
  loadErrorNotice: string | null;
  /** Clears both notices (shared dismiss from useTtsLifecycle). */
  onDismiss: () => void;
}

/* Shared surface for the TTS Load/Stop lifecycle notices, lifted out of
   generation.tsx so the GLOBAL top-bar pill (layout.tsx) renders the same
   banner. The Generate view used to be the only place these notices appeared,
   so a Load failure triggered from the top-bar pill on the Analysing / Confirm
   / other ready views reverted the pill to idle with NO explanation (the
   error was set on the shared hook state but had no surface). Both surfaces
   read the one useTtsLifecycle instance via LayoutContext, so rendering this
   once under the top bar covers every stage that shows the pill — including
   the Generate view, where the inline copy was removed to avoid a double
   render. Renders nothing when both notices are clear. */
export function TtsNoticeBanner({
  evictionNotice,
  loadErrorNotice,
  onDismiss,
}: TtsNoticeBannerProps) {
  if (!evictionNotice && !loadErrorNotice) return null;
  return (
    <div className="max-w-[1500px] mx-auto px-3 sm:px-6 mt-2 flex flex-col gap-1">
      {evictionNotice && (
        <p className="inline-flex items-center gap-2 text-[11px] text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          {evictionNotice}
        </p>
      )}
      {loadErrorNotice && (
        <p
          className="inline-flex items-start gap-2 text-[11px] text-rose-700 max-w-prose"
          role="alert"
        >
          <span className="w-1.5 h-1.5 mt-1 rounded-full bg-rose-500 shrink-0" />
          <span>{loadErrorNotice}</span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            className="ml-1 text-rose-600/70 hover:text-rose-800"
          >
            <IconClose className="w-3 h-3" />
          </button>
        </p>
      )}
    </div>
  );
}
