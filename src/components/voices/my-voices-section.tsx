/* fs-38 Wave 1, Task 14/15 — "My voices" section (design spec §1/§Q6).
   Book-independent library of deliberately-kept voices (designed / cloned /
   imported). Task 14 shipped the SHELL (empty state + a placeholder row);
   this task (15) swaps the placeholder for the real `VoiceLibraryCard` grid
   and wires both Create-voice entry points (empty state + header CTA) to
   `CreateLibraryVoiceModal`, and each card's Edit action to
   `RedesignLibraryVoiceModal`. Assign is left as a Task-16 stub — the
   assign-to-character picker isn't built yet. */

import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  fetchVoiceLibrary,
  selectMyVoices,
  type VoiceLibraryEntry,
} from '../../store/voice-library-slice';
import { VoiceLibraryCard } from './voice-library-card';
import { CreateLibraryVoiceModal } from '../../modals/create-library-voice';
import { RedesignLibraryVoiceModal } from '../../modals/redesign-library-voice';
import { CloneVoiceWizard } from '../../modals/clone-voice-wizard';

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
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<VoiceLibraryEntry | null>(null);

  useEffect(() => {
    if (!enabled) return;
    dispatch(fetchVoiceLibrary());
  }, [enabled, dispatch]);

  if (!enabled) return null;

  return (
    <>
      {entries.length === 0 ? (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
          <p className="text-sm font-bold text-ink">No voices in your library yet</p>
          <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
            Design a voice from a persona, clone your own, or import a sample — voices you
            deliberately keep here stay book-independent and ready to cast anywhere.
          </p>
          <button
            type="button"
            data-testid="my-voices-create-cta"
            onClick={() => setCreateOpen(true)}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft transition-colors min-h-[44px] fine-pointer:min-h-0"
          >
            Create voice
          </button>
          <button
            type="button"
            data-testid="my-voices-clone-cta"
            onClick={() => setCloneOpen(true)}
            className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/15 bg-white text-sm font-semibold text-ink/80 hover:text-ink hover:border-ink/30 transition-colors min-h-[44px] fine-pointer:min-h-0"
          >
            Clone a voice
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-ink">My voices</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="my-voices-create-cta"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft transition-colors min-h-[44px] fine-pointer:min-h-0"
              >
                Create voice
              </button>
              <button
                type="button"
                data-testid="my-voices-clone-cta"
                onClick={() => setCloneOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/15 bg-white text-sm font-semibold text-ink/80 hover:text-ink hover:border-ink/30 transition-colors min-h-[44px] fine-pointer:min-h-0"
              >
                Clone a voice
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {entries.map((entry) => (
              <VoiceLibraryCard
                key={entry.voiceUuid}
                entry={entry}
                onEdit={(e) => setEditingEntry(e)}
                onAssign={() => {
                  /* Task 16: open the assign-to-character picker. */
                }}
              />
            ))}
          </div>
        </div>
      )}

      {createOpen && <CreateLibraryVoiceModal onClose={() => setCreateOpen(false)} />}
      {cloneOpen && <CloneVoiceWizard onClose={() => setCloneOpen(false)} />}
      {editingEntry && (
        <RedesignLibraryVoiceModal entry={editingEntry} onClose={() => setEditingEntry(null)} />
      )}
    </>
  );
}
