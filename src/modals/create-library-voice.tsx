/* fs-38 Wave 1, Task 15 — CreateLibraryVoiceModal.

   Full-screen-on-phone (<640px, the queue-modal shell idiom) "Create a
   voice" flow: a persona textarea (same idiom as the Profile drawer's Qwen
   persona editor, src/modals/profile-drawer.tsx ~:317) + a name field,
   "Design & audition" (dispatches the Task 13 `designVoice` thunk — which
   already persists the entry server-side and refetches the library list),
   an audition player for the returned previewUrl, then Save. Save just
   closes the modal — the entry already exists once design resolves, there's
   nothing further to persist. */

import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { designVoice } from '../store/voice-library-slice';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { IconClose, IconSparkle, IconSpinner, IconPlay, IconPause } from '../lib/icons';

interface Props {
  onClose: () => void;
}

export function CreateLibraryVoiceModal({ onClose }: Props) {
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const designPending = useAppSelector((s) => s.voiceLibrary.designPending);
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const playing = playback.isPlaying && !!previewUrl && playback.currentUrl === previewUrl;

  async function handleDesign() {
    if (designPending) return;
    const trimmedName = name.trim();
    const trimmedPersona = persona.trim();
    if (!trimmedName) {
      setError('Name the voice before designing.');
      return;
    }
    if (!trimmedPersona) {
      setError('Add a persona before designing a voice.');
      return;
    }
    setError(null);
    /* Task 16: dispatch the cast-design pill's start({bookId: null}) here so
       book views see designRunningElsewhere while this library design runs. */
    try {
      const result = await dispatch(
        designVoice({ name: trimmedName, persona: trimmedPersona }),
      ).unwrap();
      setPreviewUrl(result.previewUrl);
      await playback.play(result.previewUrl);
    } catch (e) {
      setError((e as Error).message || 'Voice design failed.');
    }
  }

  function togglePlay() {
    if (!previewUrl) return;
    if (playing) {
      playback.stop();
      return;
    }
    void playback.play(previewUrl);
  }

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="create-library-voice-backdrop"
      />
      <div
        className="fixed inset-0 z-50 grid sm:place-items-center sm:p-6 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-label="Create a voice"
      >
        <div
          data-testid="create-library-voice-modal"
          className="bg-white sm:rounded-3xl shadow-float w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[90vh] pointer-events-auto fade-in flex flex-col"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3 sticky top-0 bg-white/95 backdrop-blur-md">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                My voices
              </p>
              <h3 className="text-base font-bold text-ink">Create a voice</h3>
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
            <div>
              <label
                htmlFor="create-library-voice-name"
                className="block text-[11px] font-semibold uppercase tracking-widest text-ink/55 mb-1"
              >
                Name
              </label>
              <input
                id="create-library-voice-name"
                data-testid="create-library-voice-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Captain Halloran"
                className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
              />
            </div>

            <div>
              <label
                htmlFor="create-library-voice-persona"
                className="block text-[11px] font-semibold uppercase tracking-widest text-ink/55 mb-1"
              >
                Voice persona
              </label>
              <textarea
                id="create-library-voice-persona"
                data-testid="create-library-voice-persona"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={4}
                placeholder="A weathered ship captain, baritone, northern English, authoritative."
                className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
              />
            </div>

            <button
              type="button"
              onClick={() => void handleDesign()}
              disabled={designPending}
              data-testid="create-library-voice-design"
              className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold transition-colors min-h-[44px] fine-pointer:min-h-0 ${
                designPending
                  ? 'bg-magenta/10 text-magenta cursor-wait'
                  : 'bg-magenta/10 text-magenta hover:bg-magenta/20'
              }`}
            >
              {designPending ? (
                <>
                  <IconSpinner className="w-4 h-4" />
                  <span>Designing voice…</span>
                </>
              ) : (
                <>
                  <IconSparkle className="w-4 h-4" />
                  <span>Design &amp; audition</span>
                </>
              )}
            </button>

            {previewUrl && (
              <button
                type="button"
                onClick={togglePlay}
                data-testid="create-library-voice-audition"
                aria-label={playing ? 'Stop preview' : 'Play preview'}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta text-sm font-semibold transition-colors min-h-[44px] fine-pointer:min-h-0"
              >
                {playing ? <IconPause className="w-4 h-4" /> : <IconPlay className="w-4 h-4" />}
                <span>{playing ? 'Stop' : 'Play preview'}</span>
              </button>
            )}

            {error && (
              <p
                data-testid="create-library-voice-error"
                className="text-[11px] text-red-600/90 font-medium"
              >
                ⚠ {error}
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink min-h-[44px] fine-pointer:min-h-0"
            >
              Cancel
            </button>
            <button
              onClick={onClose}
              disabled={!previewUrl}
              data-testid="create-library-voice-save"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] fine-pointer:min-h-0"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
