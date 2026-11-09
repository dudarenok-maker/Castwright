/* "Don't reuse" (the match drawer's decline) — #3992.
 *
 * `castActions.declineMatch` only clears `matchedFrom` in redux. That is not
 * durable: the row keeps the earlier book's voiceUuid, a re-analysis re-links it,
 * and a redesign overwrites the earlier book's voice. The decline is therefore ONE
 * request: the decline-voice-link route records `declinedVoiceFrom`, clears
 * `matchedFrom` and moves the row onto a voice of its own in one locked step, and
 * only when it succeeds does this thunk dispatch the reducer (and mirror the
 * row's new `voiceUuid`). A failed request leaves redux exactly as it
 * was (the link still shows, so the 500 ms autosave cannot persist a decline the
 * server never recorded) and surfaces a toast, rather than the silent warning that
 * left the earlier book exposed. The source book is read BEFORE the reducer runs,
 * since the reducer erases it. A link with no book id (a manual Assign records
 * none) has nothing to name, so only the reducer runs; the same when no book is
 * open. Works from the Cast view (`ready`) and from Confirm, where the drawer also
 * opens and where a re-analysis lands.
 *
 * The request outlives the click (a contended book-op or cast lock stretches it to
 * 10 s), and the slices hold ONE book at a time while `cast/declineMatch` is a
 * persisted action saved to whichever book the stage names. So the book open at
 * click time is captured, and the reducer runs only if the slices still hold it
 * (open-book.ts). Otherwise the server write already stands, and the next open of
 * that book reads it. */

import { castActions } from './cast-slice';
import { notificationsActions } from './notifications-slice';
import { api } from '../lib/api';
import { selectIsOpenBook } from './open-book';
import type { AppDispatch, RootState } from './index';

export function declineMatchFlow(characterId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const state = getState();
    const stage = state.ui.stage;
    const bookId = stage.kind === 'ready' || stage.kind === 'confirm' ? stage.bookId : null;
    const fromBookId = state.cast.characters.find((c) => c.id === characterId)?.matchedFrom?.bookId;
    const openBook = { manuscriptId: state.manuscript.manuscriptId as string };

    let marker:
      | { declinedVoiceFrom: string[]; declinedVoiceUuids: string[]; voiceUuid?: string | null; separated?: boolean; movedCharacterIds?: string[] }
      | undefined;
    if (bookId && fromBookId) {
      try {
        marker = await api.declineVoiceLink({ bookId, characterId, fromBookId });
      } catch (err) {
        console.warn('[decline-match] recording the decline failed', (err as Error).message);
        dispatch(
          notificationsActions.pushToast({
            kind: 'error',
            message: `Couldn't save "Don't reuse" — the voice link is unchanged. ${(err as Error).message}`.trim(),
            dedupeKey: `decline-voice-link:${characterId}`,
          }),
        );
        return;
      }
    }
    if (!selectIsOpenBook(getState(), openBook)) return;
    dispatch(castActions.declineMatch(characterId));
    if (marker) {
      const { voiceUuid, separated, movedCharacterIds, declinedVoiceFrom, declinedVoiceUuids } = marker;
      dispatch(castActions.setDeclinedVoice({ characterId, declinedVoiceFrom, declinedVoiceUuids }));
      /* The route may have moved the row onto a voice of its own, with the other
         rows of this book on the same key (pass 10); the fork reducer mirrors
         the server's rename of the qwen slot and drops its variant slots (#4067),
         or the next whole-roster save writes the old ones back. Only when the
         route says it moved the row: a decline that left it on the voice it
         already owned reports that same uuid, and mirroring a fork it never made
         would delete the row's emotion variants. */
      if (separated && voiceUuid) {
        for (const id of [characterId, ...(movedCharacterIds ?? [])]) {
          dispatch(castActions.forkCharacterVoiceUuid({ characterId: id, voiceUuid }));
        }
      }
    }
  };
}
