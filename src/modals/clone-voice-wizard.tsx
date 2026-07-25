/* fs-38 Wave 3b1 — two-phase "Clone a voice" wizard. Phase 1 embeds the
   Wave-3a CloneCapturePanel (capture + consent); phase 2 names the voice and
   Saves, which derives + persists the cloned entry server-side (cloneVoice
   thunk). On success it shows the audition preview + the advisory ECAPA
   fidelity warning (from the returned entry's sampleMeta) before the user
   closes. Design tokens + ≥44px touch targets throughout. */

import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { cloneVoice } from '../store/voice-library-slice';
import { CloneCapturePanel, type ConsentDraft } from '../components/voices/clone-capture-panel';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { api, type VoiceLibraryEntry } from '../lib/api';
import { IconClose, IconSpinner, IconPlay, IconPause } from '../lib/icons';

interface Props {
  onClose: () => void;
}

export function CloneVoiceWizard({ onClose }: Props) {
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const clonePending = useAppSelector((s) => s.voiceLibrary.clonePending);
  const [ready, setReady] = useState<{ candidateId: string; consent: ConsentDraft } | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<VoiceLibraryEntry | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fidelityWarning =
    (saved?.sampleMeta?.qualityChecks?.cloneFidelityWarning as string | undefined) ?? undefined;
  const playing = playback.isPlaying && !!previewUrl && playback.currentUrl === previewUrl;

  async function handleSave() {
    if (!ready || clonePending) return;
    setError(null);
    try {
      const entry = await dispatch(
        cloneVoice({ candidateId: ready.candidateId, name: name.trim() || undefined, consent: ready.consent }),
      ).unwrap();
      setSaved(entry);
      try {
        const { url } = await api.sampleLibraryVoice(entry.voiceUuid);
        setPreviewUrl(url);
      } catch {
        /* preview is best-effort — the entry is already saved */
      }
    } catch (e) {
      setError((e as Error).message || 'Voice clone failed.');
    }
  }

  function togglePlay() {
    if (!previewUrl) return;
    if (playing) playback.stop();
    else void playback.play(previewUrl);
  }

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" data-testid="clone-voice-wizard-backdrop" />
      <div
        className="fixed inset-0 z-50 grid sm:place-items-center sm:p-6 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-label="Clone a voice"
        data-testid="clone-voice-wizard"
      >
        <div className="bg-white sm:rounded-3xl shadow-float w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[90vh] pointer-events-auto fade-in flex flex-col">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3 sticky top-0 bg-white/95 backdrop-blur-md">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">My voices</p>
              <h3 className="text-base font-bold text-ink">Clone a voice</h3>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] min-w-[44px] fine-pointer:min-h-0 fine-pointer:min-w-0"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
            {!ready && <CloneCapturePanel onReady={(r) => setReady(r)} />}

            {ready && !saved && (
              <>
                <div>
                  <label
                    htmlFor="clone-voice-wizard-name"
                    className="block text-[11px] font-semibold uppercase tracking-widest text-ink/55 mb-1"
                  >
                    Name
                  </label>
                  <input
                    id="clone-voice-wizard-name"
                    data-testid="clone-voice-wizard-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={ready.consent.personName}
                    className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
                  />
                </div>
                {clonePending && (
                  <p className="inline-flex items-center gap-2 text-sm text-magenta">
                    <IconSpinner className="w-4 h-4" /> Cloning voice…
                  </p>
                )}
              </>
            )}

            {saved && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-ink">Cloned "{saved.name}".</p>
                {previewUrl && (
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={playing ? 'Stop preview' : 'Play preview'}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta text-sm font-semibold transition-colors min-h-[44px] fine-pointer:min-h-0"
                  >
                    {playing ? <IconPause className="w-4 h-4" /> : <IconPlay className="w-4 h-4" />}
                    <span>{playing ? 'Stop' : 'Play preview'}</span>
                  </button>
                )}
                {fidelityWarning && (
                  <p data-testid="clone-voice-wizard-fidelity-warning" className="text-[11px] text-amber-600 font-medium">
                    ⚠ {fidelityWarning}
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-[11px] text-magenta font-medium">⚠ {error}</p>}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            {!saved ? (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink min-h-[44px] fine-pointer:min-h-0"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSave()}
                  disabled={!ready || clonePending}
                  data-testid="clone-voice-wizard-save"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] fine-pointer:min-h-0"
                >
                  Save
                </button>
              </>
            ) : (
              <button
                onClick={onClose}
                data-testid="clone-voice-wizard-done"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft min-h-[44px] fine-pointer:min-h-0"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
