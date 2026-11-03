/* "Don't reuse" (the match drawer's decline) — #3992.
 *
 * `castActions.declineMatch` only clears `matchedFrom` in redux. That is not
 * durable: the row keeps the earlier book's voiceUuid, a re-analysis re-links it,
 * and a redesign overwrites the earlier book's voice. The decline is therefore ONE
 * request: the decline-voice-link route records `declinedVoiceFrom` and clears
 * `matchedFrom` on disk in the same locked write, and only when it succeeds does
 * this thunk dispatch the reducer. A failed request leaves redux exactly as it
 * was (the link still shows, so the 500 ms autosave cannot persist a decline the
 * server never recorded) and surfaces a toast, rather than the silent warning that
 * left the earlier book exposed. The source book is read BEFORE the reducer runs,
 * since the reducer erases it. A link with no book id (a manual Assign records
 * none) has nothing to name, so only the reducer runs; the same when no book is
 * open. Works from the Cast view (`ready`) and from Confirm, where the drawer also
 * opens and where a re-analysis lands. */

import { castActions } from './cast-slice';
import { notificationsActions } from './notifications-slice';
import { api } from '../lib/api';
import type { AppDispatch, RootState } from './index';

export function declineMatchFlow(characterId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const state = getState();
    const stage = state.ui.stage;
    const bookId = stage.kind === 'ready' || stage.kind === 'confirm' ? stage.bookId : null;
    const fromBookId = state.cast.characters.find((c) => c.id === characterId)?.matchedFrom?.bookId;

    if (bookId && fromBookId) {
      try {
        await api.declineVoiceLink({ bookId, characterId, fromBookId });
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
    dispatch(castActions.declineMatch(characterId));
  };
}
