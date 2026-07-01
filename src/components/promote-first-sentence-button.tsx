/* Promote-first-sentence-to-title (2026-07-01 spec) — a quick fix for
   unstructured manuscripts where the analyzer never detected a real
   chapter title and the actual title text sits as the chapter's first
   sentence instead. Promoting it renames the chapter (api.renameChapter,
   the same endpoint EditChapterTitleModal uses) and removes the sentence
   from narration (manuscriptActions.promoteSentenceToTitle), tombstoning
   it the same way mergeSentences does.

   Styled after DetectEmotionsButton's idle/confirm popover pattern.
   See docs/superpowers/specs/2026-07-01-promote-first-sentence-to-title-design.md. */

import { useState } from 'react';
import { useAppDispatch } from '../store';
import { chaptersActions } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { notificationsActions } from '../store/notifications-slice';
import { api } from '../lib/api';
import { MAX_TITLE_LEN } from '../modals/edit-chapter-title';
import type { Sentence } from '../lib/types';

type Phase = 'idle' | 'confirm' | 'busy';

interface Props {
  bookId: string | null;
  chapterId: number;
  firstSentence: Sentence | null;
}

/** Trim + drop one trailing period — verbatim otherwise (spec Decision 5).
    No casing changes. */
function cleanTitle(text: string): string {
  return text.trim().replace(/\.$/, '');
}

export function PromoteFirstSentenceButton({ bookId, chapterId, firstSentence }: Props) {
  const dispatch = useAppDispatch();
  const [phase, setPhase] = useState<Phase>('idle');

  const cleaned = firstSentence ? cleanTitle(firstSentence.text) : '';
  const disabled = !bookId || !firstSentence || cleaned.length === 0 || cleaned.length > MAX_TITLE_LEN;

  async function handleConfirm() {
    if (!bookId || !firstSentence) return;
    setPhase('busy');
    try {
      await api.renameChapter(bookId, chapterId, cleaned);
      dispatch(chaptersActions.renameChapter({ chapterId, title: cleaned }));
      dispatch(manuscriptActions.promoteSentenceToTitle({ chapterId, sentenceId: firstSentence.id }));
      setPhase('idle');
    } catch (err) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: (err as Error).message || 'Could not rename the chapter.',
          dedupeKey: `chapter-rename-${chapterId}`,
        }),
      );
      setPhase('idle');
    }
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        data-testid="promote-first-sentence-button"
        disabled={disabled || phase === 'busy'}
        onClick={() => setPhase((p) => (p === 'confirm' ? 'idle' : 'confirm'))}
        title={
          firstSentence
            ? "Use this chapter's first line as its title, and remove it from narration"
            : 'This chapter has no sentences to promote'
        }
        className="shrink-0 inline-flex items-center gap-2 px-4 min-h-11 rounded-full border border-ink/15 text-sm font-semibold text-ink hover:bg-ink/5 disabled:opacity-40"
      >
        Use first line as title
      </button>
      {(phase === 'confirm' || phase === 'busy') && firstSentence && (
        <span
          role="dialog"
          aria-label="Use first line as title"
          className="absolute z-50 left-0 top-full mt-2 w-72 rounded-xl border border-ink/10 bg-white picker-surface shadow-lg p-3 text-left"
        >
          <p className="text-xs text-ink/70 leading-snug">
            Set title to "<span className="font-semibold text-ink">{cleaned}</span>" and remove it
            from narration?
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPhase('idle')}
              disabled={phase === 'busy'}
              className="px-3 py-1.5 text-xs text-ink/60 hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="promote-first-sentence-confirm"
              disabled={phase === 'busy'}
              onClick={() => void handleConfirm()}
              className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90 disabled:opacity-50"
            >
              {phase === 'busy' ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </span>
      )}
    </span>
  );
}
