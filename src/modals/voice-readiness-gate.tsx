/* fe-46 — pre-flight voice-readiness gate. Opened by `startGenerationFlow`
   instead of the tier prompt when a speaking Qwen character has no designed
   voice: "Design full cast" kicks the bulk job (same payload shape as the
   cast view's "Design full cast" button, so it drives the same
   DesignPill/progress UI); English books get a "Proceed anyway" fallback;
   non-English books have no proceed affordance at all — every speaking
   character needs a designed voice before that book can generate. */

import { IconClose } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castDesignActions } from '../store/cast-design-slice';
import {
  selectUndesignedQwenCharacters,
  selectIsBookNonEnglish,
} from '../store/voice-readiness-selectors';
import { sampleModelKeyForEngine } from '../lib/tts-voice-mapping';

export function VoiceReadinessGateModal() {
  const dispatch = useAppDispatch();
  const gate = useAppSelector((s) => s.ui.voiceReadinessGate);
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const designActive = useAppSelector((s) => s.castDesign.active);
  const undesigned = useAppSelector((s) =>
    gate ? selectUndesignedQwenCharacters(s, gate.bookId) : [],
  );
  const isNonEnglish = useAppSelector((s) => (gate ? selectIsBookNonEnglish(s, gate.bookId) : false));

  if (!gate) return null;
  const { bookId } = gate;
  const designRunningHere = designActive?.state === 'running' && designActive.bookId === bookId;

  const onClose = () => dispatch(uiActions.closeVoiceReadinessGate());

  const onDesignFullCast = () => {
    if (!designRunningHere) {
      dispatch(
        castDesignActions.designAllRequested({
          bookId,
          characterIds: undesigned.map((c) => c.id),
          modelKey: sampleModelKeyForEngine('qwen', ttsModelKey),
          scope: 'bases',
          variantTasks: [],
        }),
      );
    }
    dispatch(uiActions.changeView('cast'));
    onClose();
  };

  const onProceedAnyway = () => {
    onClose();
    dispatch(uiActions.openStartGenPrompt({ fallbackConfirmed: true }));
  };

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          data-testid="voice-readiness-gate"
          className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Voice readiness
              </p>
              <h3 className="text-base font-bold text-ink truncate">
                Some characters still need a voice
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed">
            {isNonEnglish ? (
              <p>
                This book can't fall back to a generic voice — every speaking character needs a
                designed voice.
              </p>
            ) : (
              <p>
                These speaking characters haven't been designed yet. Design them now, or proceed
                and they'll render with a generic Kokoro fallback voice.
              </p>
            )}
            {undesigned.length > 0 && (
              <ul data-testid="voice-readiness-gate-list" className="mt-3 space-y-1.5">
                {undesigned.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3">
                    <span className="font-medium text-ink">{c.name}</span>
                    <span className="text-xs text-ink/50 tabular-nums">
                      {c.lines} {c.lines === 1 ? 'line' : 'lines'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            {!isNonEnglish ? (
              <button
                onClick={onProceedAnyway}
                className="text-sm font-medium text-ink/60 hover:text-ink"
              >
                Proceed anyway — generic Kokoro fallback voices
              </button>
            ) : (
              <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">
                Cancel
              </button>
            )}
            <PrimaryButton variant="dark" onClick={onDesignFullCast}>
              {designRunningHere ? 'View design progress' : 'Design full cast'}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}
