import { IconClose } from '../lib/icons';
import { ModelControlPill } from './ModelControlPill';
import type { EngineLifecycle } from '../lib/use-tts-lifecycle';

interface TtsNoticeBannerProps {
  /** "Analyzer unloaded to free VRAM for TTS." — emerald info line. */
  evictionNotice: string | null;
  /** Rose alert line when a Load/Stop returns {status:'error'} or throws. */
  loadErrorNotice: string | null;
  /** Clears both notices (shared dismiss from useTtsLifecycle). */
  onDismiss: () => void;
  /** Kokoro's lifecycle. When resident (`state === 'ready'`), a Stop control
      renders here — the same `ModelControlPill` the generation view shows,
      just reachable from every stage instead of only when the open book's
      cast uses Kokoro (Task 10 / #1839). Optional so the standalone-component
      tests above (no engine context) keep rendering nothing. */
  kokoro?: EngineLifecycle;
  /** Same idea for Coqui XTTS. */
  coqui?: EngineLifecycle;
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
   render.

   Task 10 (#1839) — also the home for a resident-model Stop control. Kokoro
   is the eagerly-resident fallback (PRELOAD_KOKORO); its Stop pill was
   reachable only via the Status popover (which is residency-gated), not the
   generation view — this control makes one visible without that extra click.
   Gated on residency (`state === 'ready'`), not `enginesInUse` — residency
   is what costs VRAM. Exactly the moment a voice preview fails for capacity
   (see server/src/gpu/describe-vram-blockers.ts, whose remedy copy now points
   here). Renders nothing when there's no notice AND nothing resident. */
export function TtsNoticeBanner({
  evictionNotice,
  loadErrorNotice,
  onDismiss,
  kokoro,
  coqui,
}: TtsNoticeBannerProps) {
  const resident: Array<{ label: string; lifecycle: EngineLifecycle }> = [];
  if (kokoro?.state === 'ready') resident.push({ label: 'Kokoro', lifecycle: kokoro });
  if (coqui?.state === 'ready') resident.push({ label: 'Coqui XTTS', lifecycle: coqui });

  if (!evictionNotice && !loadErrorNotice && resident.length === 0) return null;
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
      {resident.length > 0 && (
        <p className="inline-flex items-center gap-2 flex-wrap text-[11px] text-ink/55">
          <span>Voice engines loaded:</span>
          {resident.map(({ label, lifecycle }) => (
            <ModelControlPill
              key={label}
              kind="tts"
              engineLabel={label}
              state={lifecycle.state}
              onLoad={() => {
                void lifecycle.onLoad();
              }}
              onStop={() => {
                void lifecycle.onStop();
              }}
            />
          ))}
        </p>
      )}
    </div>
  );
}
