/* fs-38 Wave 1, Task 14 — "My voices" section shell (design spec §1/§Q6).
   Book-independent library of deliberately-kept voices (designed / cloned /
   imported). This task ships the SHELL only: an empty state with a
   "Create voice" CTA (wizard wiring lands in a later Wave-1 task) and a
   minimal per-entry placeholder row for the non-empty case — Task 15 swaps
   the placeholder row for the real `VoiceLibraryCard`. */

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { fetchVoiceLibrary, selectMyVoices } from '../../store/voice-library-slice';

interface Props {
  /** Reflects the `voices.library.enabled` config gate, computed by the
   *  parent `voices.tsx` (single source of truth, shared with the nav's
   *  "My voices" segment visibility). Renders nothing when false — a
   *  defense-in-depth mirror of the parent already never mounting this
   *  section's nav entry when the gate is off. */
  enabled: boolean;
}

export function MyVoicesSection({ enabled }: Props) {
  const dispatch = useAppDispatch();
  const entries = useAppSelector(selectMyVoices);

  useEffect(() => {
    if (!enabled) return;
    dispatch(fetchVoiceLibrary());
  }, [enabled, dispatch]);

  if (!enabled) return null;

  if (entries.length === 0) {
    return (
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
        <p className="text-sm font-bold text-ink">No voices in your library yet</p>
        <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
          Design a voice from a persona, clone your own, or import a sample — voices you
          deliberately keep here stay book-independent and ready to cast anywhere.
        </p>
        <button
          type="button"
          data-testid="my-voices-create-cta"
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft transition-colors min-h-[44px] fine-pointer:min-h-0"
        >
          Create voice
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-bold text-ink">Designed voices</h2>
        <ul className="mt-3 divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-white">
          {entries.map((entry) => (
            <li
              key={entry.voiceUuid}
              data-testid={`my-voices-entry-${entry.voiceUuid}`}
              className="px-4 py-3 text-sm text-ink"
            >
              {entry.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
