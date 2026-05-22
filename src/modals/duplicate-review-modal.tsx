/* Duplicate-review modal (plan 101).

   Opens from three surfaces:
   - Voices view family-card ⚠ pill (auto-detected candidate)
   - Voices selection pill `Review duplicate ↗` button (2 cross-book
     same-base-voice cards selected by hand)
   - Profile drawer "Possible duplicate of …" chip

   Three actions:
   - "Same character — link them" → POST /cast/link-prior (existing route)
   - "Different on purpose (e.g. teenage vs adult)" → POST
     /cast/:characterId/not-linked-to (new route, plan 101)
   - Cancel

   The link path picks a survivor (longer-named side wins by default, user
   can flip via two radios) and appends the loser's name + aliases onto
   the survivor's aliases in the survivor's book. The variant path writes
   a symmetric `notLinkedTo` entry to both books' cast.json so future
   duplicate-detection passes leave the pair alone.

   Both actions surface server errors as a red banner inside the modal
   (modal stays open so the user can retry / cancel). */

import { useEffect, useState } from 'react';
import { IconClose } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { api } from '../lib/api';
import { useAppDispatch } from '../store';
import { castActions } from '../store/cast-slice';
import { notificationsActions } from '../store/notifications-slice';
import { pickMergeSurvivor } from '../lib/voice-character-link';
import type { Character, Voice } from '../lib/types';

export interface DuplicateReviewPair {
  /* Each side carries the voice row + (optionally) the resolved Character.
     When the Character isn't loaded yet, the link path is disabled because
     the server route requires character ids; the variant path is still
     available IF we have ids (we surface a clearer disabled state if we
     don't). */
  a: { voice: Voice; character: Character | null };
  b: { voice: Voice; character: Character | null };
}

interface DuplicateReviewModalProps {
  open: boolean;
  pair: DuplicateReviewPair | null;
  onClose: () => void;
  /* Optional callback after a successful action so the caller can
     refresh local state (e.g. clear selection on the voices pill). */
  onResolved?: () => void;
}

export function DuplicateReviewModal({
  open,
  pair,
  onClose,
  onResolved,
}: DuplicateReviewModalProps) {
  const dispatch = useAppDispatch();
  const [busy, setBusy] = useState<'link' | 'variant' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Which side survives a "link" action. Default = the side
     pickMergeSurvivor picks (longer-named / substring-containing).
     'a' or 'b'. */
  const [survivor, setSurvivor] = useState<'a' | 'b'>('a');

  /* Reset modal state every time it opens with a fresh pair. */
  useEffect(() => {
    if (!open || !pair) return;
    setBusy(null);
    setError(null);
    if (pair.a.character && pair.b.character) {
      const picked = pickMergeSurvivor(pair.a.character, pair.b.character);
      setSurvivor(picked.target.id === pair.a.character.id ? 'a' : 'b');
    } else {
      /* Fallback: longer-named voice wins. */
      const aLen = pair.a.voice.character.trim().length;
      const bLen = pair.b.voice.character.trim().length;
      setSurvivor(aLen >= bLen ? 'a' : 'b');
    }
  }, [open, pair]);

  if (!open || !pair) return null;

  const sideA = pair.a;
  const sideB = pair.b;
  const winner = survivor === 'a' ? sideA : sideB;
  const loser = survivor === 'a' ? sideB : sideA;
  const canLink = !!sideA.character && !!sideB.character;
  const linkDisabled = !canLink || busy !== null;
  const variantDisabled = !canLink || busy !== null;

  async function handleLink() {
    if (!canLink || !sideA.character || !sideB.character) return;
    setError(null);
    setBusy('link');
    try {
      const winnerChar = survivor === 'a' ? sideA.character : sideB.character;
      const loserChar = survivor === 'a' ? sideB.character : sideA.character;
      const winnerBookId = survivor === 'a' ? sideA.voice.bookId : sideB.voice.bookId;
      const loserBookId = survivor === 'a' ? sideB.voice.bookId : sideA.voice.bookId;
      const winnerBookTitle = survivor === 'a' ? sideA.voice.bookTitle : sideB.voice.bookTitle;
      const res = await api.linkPriorCharacter({
        bookId: loserBookId,
        sourceCharacterId: loserChar.id,
        targetBookId: winnerBookId,
        targetCharacterId: winnerChar.id,
      });
      dispatch(
        castActions.applyManualMatch({
          characterId: loserChar.id,
          matchedFrom: res.matchedFrom,
          voiceId: res.voiceId,
        }),
      );
      dispatch(
        notificationsActions.pushToast({
          dedupeKey: `duplicate-link-${loserChar.id}`,
          kind: 'info',
          message: `Linked "${loserChar.name}" to "${winnerChar.name}" (${winnerBookTitle}).`,
        }),
      );
      onResolved?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function handleVariant() {
    if (!canLink || !sideA.character || !sideB.character) return;
    setError(null);
    setBusy('variant');
    try {
      await api.notLinkedTo({
        bookId: sideA.voice.bookId,
        characterId: sideA.character.id,
        otherBookId: sideB.voice.bookId,
        otherCharacterId: sideB.character.id,
      });
      dispatch(
        castActions.applyNotLinked({
          characterId: sideA.character.id,
          otherBookId: sideB.voice.bookId,
          otherCharacterId: sideB.character.id,
        }),
      );
      /* The 'b' side's redux store lives in a sibling tab / foreign-cast
         cache. The server already wrote the symmetric entry to that
         book's cast.json; the next hydrate of the b-book will mirror it
         into redux. Nothing to dispatch here for the b-side in this tab. */
      dispatch(
        notificationsActions.pushToast({
          dedupeKey: `duplicate-variant-${sideA.character.id}`,
          kind: 'info',
          message: `Marked "${sideA.character.name}" and "${sideB.character.name}" as separate characters.`,
        }),
      );
      onResolved?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full grid place-items-center shrink-0 bg-amber-50 text-amber-700 text-base font-bold">
              !
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Review duplicate
              </p>
              <h3 className="text-base font-bold text-ink truncate">
                Same person across books?
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
            <p className="mb-4">
              Both cast members route to the same base voice. Pick the right action:
            </p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <SideCard
                side={sideA}
                selected={survivor === 'a'}
                onSelect={() => setSurvivor('a')}
                disabled={!canLink}
              />
              <SideCard
                side={sideB}
                selected={survivor === 'b'}
                onSelect={() => setSurvivor('b')}
                disabled={!canLink}
              />
            </div>
            {canLink ? (
              <p className="text-xs text-ink/60 mb-3">
                Survivor: <span className="font-semibold text-ink">{winner.voice.character}</span>{' '}
                — picking link will append &quot;{loser.voice.character}&quot; to its aliases.
              </p>
            ) : (
              <p className="text-xs text-amber-700 mb-3">
                Open both books so their casts hydrate before linking, or use Cancel.
              </p>
            )}
            {error && (
              <div className="mb-3 px-3 py-2 rounded-md bg-red-50 text-red-700 text-xs font-medium">
                {error}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex flex-wrap items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="text-sm font-medium text-ink/60 hover:text-ink"
              disabled={busy !== null}
            >
              Cancel
            </button>
            <button
              onClick={handleVariant}
              disabled={variantDisabled}
              className="px-3 py-2 rounded-full bg-ink/5 text-ink text-sm font-semibold hover:bg-ink/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'variant' ? 'Saving…' : 'Different on purpose'}
            </button>
            <PrimaryButton variant="dark" onClick={handleLink} disabled={linkDisabled}>
              {busy === 'link' ? 'Linking…' : 'Same character — link them'}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}

function SideCard({
  side,
  selected,
  onSelect,
  disabled,
}: {
  side: DuplicateReviewPair['a'];
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      className={`text-left rounded-2xl border px-4 py-3 transition-colors ${
        selected
          ? 'border-magenta bg-peach/20'
          : 'border-ink/10 bg-white hover:bg-ink/5'
      } disabled:opacity-60 disabled:cursor-not-allowed`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
            selected ? 'border-magenta bg-magenta' : 'border-ink/30'
          }`}
        />
        <span className="font-semibold text-ink truncate">{side.voice.character}</span>
      </div>
      <p className="text-[11px] text-ink/60 truncate">{side.voice.bookTitle}</p>
      {side.character?.aliases?.length ? (
        <p className="text-[11px] text-ink/45 mt-1 truncate">
          aliases: {side.character.aliases.join(', ')}
        </p>
      ) : null}
    </button>
  );
}
