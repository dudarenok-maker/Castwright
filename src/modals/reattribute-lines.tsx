/* Reattribute Lines modal.

   Opened from the Profile Drawer's "Also known as" chip removal. Server
   has already split the alias into its own standalone cast member; this
   modal lets the user move sentences over from the source character —
   scoped to the chapters where the alias originally appeared in the
   Phase-0a roster so we surface only candidates, not the whole book.

   The per-sentence reassignment dispatches the existing
   `manuscriptActions.setSentenceCharacter` action so this modal carries
   no new redux behaviour — it's a focused chapter-scoped wrapper around
   the same picker the manuscript view already uses. */

import { useMemo } from 'react';
import { IconClose } from '../lib/icons';
import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import type { UnlinkAliasImpactedChapter } from '../lib/api';

interface Props {
  /** The character the alias was un-linked FROM (e.g. "Saltgrave Figure").
      Sentences in the impacted chapters currently attributed to this id
      are the candidates the user reviews. */
  sourceCharacterId: string;
  sourceCharacterName: string;
  /** The freshly-minted standalone character ID for the un-linked alias
      (e.g. "garrow"). The quick-set chip on each sentence reassigns the
      line to this id. */
  newCharacterId: string;
  /** Display name of the un-linked alias, used in the modal header and
      on the quick-set chip. */
  aliasName: string;
  /** Server-derived list of chapters where the alias originally appeared,
      each with the IDs of sentences currently attributed to the source
      character. Empty list is allowed — the modal renders a "nothing to
      reattribute" empty state and a Done button. */
  impactedChapters: UnlinkAliasImpactedChapter[];
  onClose: () => void;
}

const CHAR_PREVIEW = 140;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function ReattributeLinesModal({
  sourceCharacterId,
  sourceCharacterName,
  newCharacterId,
  aliasName,
  impactedChapters,
  onClose,
}: Props) {
  const dispatch = useAppDispatch();
  const chapters = useAppSelector((s) => s.chapters.chapters);
  const sentences = useAppSelector((s) => s.manuscript.sentences);

  const chapterTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of chapters) m.set(c.id, c.title);
    return m;
  }, [chapters]);

  /* For each impacted chapter, hydrate the candidate sentence IDs with
     their current text and characterId from the manuscript slice. We
     intentionally read characterId from the live store so the chip-state
     reflects the user's reassignments in real time without re-fetching
     from the server. */
  const cards = useMemo(() => {
    const byChapter = new Map<number, Map<number, (typeof sentences)[number]>>();
    for (const s of sentences) {
      let inner = byChapter.get(s.chapterId);
      if (!inner) {
        inner = new Map();
        byChapter.set(s.chapterId, inner);
      }
      inner.set(s.id, s);
    }
    return impactedChapters.map((ch) => {
      const inner = byChapter.get(ch.chapterId);
      const rows = ch.candidateSentenceIds
        .map((sid) => inner?.get(sid))
        .filter((s): s is (typeof sentences)[number] => Boolean(s));
      return {
        chapterId: ch.chapterId,
        title: chapterTitleById.get(ch.chapterId) ?? `Chapter ${ch.chapterId}`,
        rows,
      };
    });
  }, [impactedChapters, sentences, chapterTitleById]);

  function reassign(chapterId: number, sentenceId: number, characterId: string) {
    dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, characterId }));
    /* Log the reassignment so a rendered chapter is flagged stale (Bug 2's
       "needs regeneration" indicator derives from the latest boundary_move vs
       the chapter's render time). Every reassignment path must emit this. */
    dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 }));
  }

  const totalCandidates = cards.reduce((n, c) => n + c.rows.length, 0);
  const isEmpty = impactedChapters.length === 0 || totalCandidates === 0;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/30 z-50 fade-in" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reattribute lines for ${aliasName}`}
        className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[min(720px,calc(100vw-32px))] max-h-[min(80vh,calc(100vh-64px))] bg-white rounded-3xl shadow-drawer flex flex-col"
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-md rounded-t-3xl border-b border-ink/10 px-6 py-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
              Reattribute lines
            </p>
            <h3 className="text-lg font-bold text-ink leading-tight truncate">
              {aliasName} — split from {sourceCharacterName}
            </h3>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-w-11 min-h-11"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div
          className="px-6 py-4 overflow-y-auto scrollbar-thin flex-1"
          style={{ ['--scrollbar-thin-radius' as string]: '0px' } as React.CSSProperties}
        >
          {isEmpty ? (
            <div className="rounded-2xl border border-dashed border-ink/15 p-5 text-sm text-ink/65 leading-relaxed">
              <p className="font-semibold text-ink mb-1">Nothing to reattribute here.</p>
              <p>
                {aliasName} is now its own cast member. We couldn't find any chapters where the
                Phase-0a analysis listed {aliasName} as a separate character — likely because the
                fold happened before the cache was written. If you spot a line that should belong
                to {aliasName}, reassign it from the manuscript view using the per-sentence picker.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-ink/65 leading-relaxed mb-4">
                {aliasName} was detected in {impactedChapters.length} chapter
                {impactedChapters.length === 1 ? '' : 's'}. Review the lines currently attributed
                to <span className="font-semibold text-ink">{sourceCharacterName}</span> and
                reassign the ones that belong to {aliasName}.
              </p>
              <div className="space-y-4">
                {cards.map((card) => (
                  <section
                    key={card.chapterId}
                    className="rounded-2xl border border-ink/10 bg-canvas/40 overflow-hidden"
                  >
                    <header className="px-4 py-2.5 border-b border-ink/10 bg-white">
                      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                        Chapter {card.chapterId}
                      </p>
                      <h4 className="text-sm font-bold text-ink truncate">{card.title}</h4>
                    </header>
                    <ul className="divide-y divide-ink/10">
                      {card.rows.map((row) => {
                        const isOnSource = row.characterId === sourceCharacterId;
                        const isOnAlias = row.characterId === newCharacterId;
                        return (
                          <li
                            key={row.id}
                            className="px-4 py-3 flex flex-col sm:flex-row sm:items-start sm:gap-3"
                          >
                            <p className="flex-1 text-sm text-ink/80 leading-relaxed mb-2 sm:mb-0">
                              {truncate(row.text, CHAR_PREVIEW)}
                            </p>
                            <div className="flex flex-wrap gap-1.5 shrink-0">
                              <button
                                aria-label={`Keep on ${sourceCharacterName}`}
                                aria-pressed={isOnSource}
                                onClick={() =>
                                  reassign(card.chapterId, row.id, sourceCharacterId)
                                }
                                className={`min-h-11 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                                  isOnSource
                                    ? 'bg-ink text-white'
                                    : 'bg-ink/6 text-ink/70 hover:bg-ink/10'
                                }`}
                              >
                                {sourceCharacterName}
                              </button>
                              <button
                                aria-label={`Reassign to ${aliasName}`}
                                aria-pressed={isOnAlias}
                                onClick={() => reassign(card.chapterId, row.id, newCharacterId)}
                                className={`min-h-11 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                                  isOnAlias
                                    ? 'bg-magenta text-white'
                                    : 'bg-magenta/12 text-magenta hover:bg-magenta/20'
                                }`}
                              >
                                {aliasName}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-white/95 backdrop-blur-md border-t border-ink/10 px-6 py-3 flex items-center justify-end gap-2 rounded-b-3xl">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full text-sm font-semibold bg-magenta text-white hover:bg-magenta/90 min-h-11"
          >
            Done
          </button>
        </div>
      </div>
    </>
  );
}
