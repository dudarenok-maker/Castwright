/* "Don't reuse" (the match drawer's decline) — #3992.
 *
 * `castActions.declineMatch` only clears `matchedFrom` in redux. That is not
 * durable: the row keeps the earlier book's voiceUuid, a re-analysis re-links it,
 * and a redesign overwrites the earlier book's voice. This thunk dispatches the
 * reducer AND records the decline on the server (`declinedVoiceFrom`, via the
 * decline-voice-link route), which is the only writer of that field (the cast PUT
 * takes it from disk). The source book is read BEFORE the reducer runs, since the
 * reducer erases it. A link with no book id (a manual Assign records none) has
 * nothing to name, so only the reducer runs. The route call is fire-and-forget:
 * the redux decline has already happened and a failed record leaves exactly the
 * pre-#3992 behaviour, so it is warned, not surfaced. */

import { castActions } from './cast-slice';
import { api } from '../lib/api';
import type { AppDispatch, RootState } from './index';

export function declineMatchFlow(characterId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const state = getState();
    const bookId = state.ui.stage.kind === 'ready' ? state.ui.stage.bookId : null;
    const fromBookId = state.cast.characters.find((c) => c.id === characterId)?.matchedFrom?.bookId;

    dispatch(castActions.declineMatch(characterId));

    if (!bookId || !fromBookId) return;
    try {
      await api.declineVoiceLink({ bookId, characterId, fromBookId });
    } catch (err) {
      console.warn('[decline-match] recording the decline failed', (err as Error).message);
    }
  };
}
