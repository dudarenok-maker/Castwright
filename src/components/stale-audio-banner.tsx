/* Stale-audio banner — fires immediately after a voice-edit Save when one
   or more done chapters now hold audio whose voice/identity profile no
   longer matches the character's freshly-saved state. Saves the 30 s
   drift-poll wait: the user sees the alert as soon as they hit Save and
   can regenerate in one click without bouncing through the regen modal.

   Driven by `ui.staleAudio` (set in layout.tsx's onSave handler). Renders
   nothing when the flag is null — single mount point in the cast view. */

import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { chaptersActions } from '../store/chapters-slice';
import { changeLogActions } from '../store/change-log-slice';
import { buildCharacterRegenEvent } from '../lib/change-log';
import { IconRefresh, IconClose } from '../lib/icons';

export function StaleAudioBanner() {
  const dispatch = useAppDispatch();
  const stale = useAppSelector(s => s.ui.staleAudio);
  const characters = useAppSelector(s => s.cast.characters);
  if (!stale) return null;
  const n = stale.chapterIds.length;
  if (n === 0) return null;

  const character = characters.find(c => c.id === stale.characterId);

  function onRegenerate() {
    if (!stale || !character) return;
    dispatch(changeLogActions.appendLogEvent(buildCharacterRegenEvent({
      character,
      chapterIds: stale.chapterIds,
      reason: 'stale_after_voice_edit',
      note: 'Voice edit invalidated existing audio.',
    })));
    dispatch(chaptersActions.regenerateCharacter({
      characterId: stale.characterId,
      chapterIds: stale.chapterIds,
    }));
    dispatch(uiActions.clearStaleAudio());
    dispatch(uiActions.changeView('generate'));
  }

  return (
    <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-center gap-3"
         data-testid="stale-audio-banner">
      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"/>
      <p className="text-sm text-amber-900 flex-1">
        Audio is stale for <span className="font-semibold">{stale.characterName}</span> across {n} {n === 1 ? 'chapter' : 'chapters'}.
        The new voice settings won't take effect until you re-render.
      </p>
      <button
        onClick={onRegenerate}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-900 text-amber-50 hover:bg-amber-950 text-xs font-semibold transition-colors"
      >
        <IconRefresh className="w-3.5 h-3.5"/> Regenerate now
      </button>
      <button
        onClick={() => dispatch(uiActions.clearStaleAudio())}
        aria-label="Dismiss stale-audio banner"
        className="p-1.5 rounded-full hover:bg-amber-100 text-amber-700"
      >
        <IconClose className="w-3.5 h-3.5"/>
      </button>
    </div>
  );
}
