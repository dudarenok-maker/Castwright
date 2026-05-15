/* Shared chapter include/exclude UI.

   Used by:
   - Confirm-metadata view (before first analysis) so the user can
     opt-out of front/back-matter that they don't want narrated.
   - Re-parse result dialog (after parser re-runs and chapter ids
     may have shifted) so the user can re-confirm or adjust
     exclusions before kicking off a fresh analysis.

   Pre-suggested exclusions come from `isLikelyFrontMatter` (title
   regex + word-count gate). The user can override per row, re-apply
   the suggestion via "Reset suggestions", or wipe all exclusions
   with "Include all". */

import { chapterSlug } from '../lib/chapter-heuristics';

export interface ChapterExclusionListChapter {
  id: number;
  title: string;
  wordCount?: number;
}

interface Props {
  chapters: ChapterExclusionListChapter[];
  excludedSlugs: Set<string>;
  onToggle: (slug: string, include: boolean) => void;
  onSelectAll: () => void;
  onResetSuggestions: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  disabled: boolean;
  /** Title rendered in the disclosure header. Defaults to "Chapters to
      include" (the confirm-stage phrasing). The re-parse dialog uses
      something more specific. */
  heading?: string;
  /** Optional banner copy override. Defaults to the auto-suggest hint. */
  bannerOverride?: string | null;
}

export function ChapterExclusionList({
  chapters, excludedSlugs, onToggle, onSelectAll, onResetSuggestions,
  expanded, onToggleExpanded, disabled,
  heading = 'Chapters to include',
  bannerOverride,
}: Props): React.ReactElement | null {
  if (!chapters.length) return null;
  const total = chapters.length;
  const excluded = excludedSlugs.size;
  const banner = bannerOverride !== undefined
    ? bannerOverride
    : (excluded > 0
        ? `We've pre-excluded ${excluded} likely front/back-matter chapter${excluded === 1 ? '' : 's'}.`
        : null);
  return (
    <div className="rounded-2xl border border-ink/10 bg-canvas/60">
      <button
        type="button"
        onClick={onToggleExpanded}
        disabled={disabled}
        className="w-full flex items-center justify-between px-4 py-3 text-left disabled:opacity-50"
      >
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-ink/55 font-semibold">
            {heading}
          </p>
          <p className="mt-0.5 text-[12px] text-ink/70">
            {excluded === 0
              ? `All ${total} chapters will be analyzed.`
              : `${total - excluded} of ${total} chapters will be analyzed — ${excluded} excluded.`}
          </p>
        </div>
        <span className="text-ink/40 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-ink/10 px-4 py-3 space-y-3">
          {banner && (
            <p className="text-[11px] text-ink/60 leading-snug">
              {banner} Untick to override. Excluded chapters skip both analysis (saves model
              tokens) and audio generation.
            </p>
          )}
          <div className="flex items-center gap-3 text-[11px]">
            <button type="button" onClick={onSelectAll} disabled={disabled || excluded === 0}
                    className="px-2 py-1 rounded-lg border border-ink/15 text-ink/70 hover:text-ink hover:border-ink/30 disabled:opacity-40">
              Include all
            </button>
            <button type="button" onClick={onResetSuggestions} disabled={disabled}
                    className="px-2 py-1 rounded-lg border border-ink/15 text-ink/70 hover:text-ink hover:border-ink/30 disabled:opacity-40">
              Reset suggestions
            </button>
          </div>
          <div data-testid="chapter-exclusion-scroll"
               className="max-h-[300px] overflow-y-auto scrollbar-thin space-y-1">
            {chapters.map(ch => {
              const slug = chapterSlug(ch.id, ch.title);
              const included = !excludedSlugs.has(slug);
              return (
                <label key={ch.id}
                       className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-ink/[0.03] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={included}
                    disabled={disabled}
                    onChange={e => onToggle(slug, e.target.checked)}
                    className="rounded border-ink/20"
                  />
                  <span className={`flex-1 text-[13px] ${included ? 'text-ink' : 'text-ink/40 line-through decoration-1'}`}>
                    {ch.title}
                  </span>
                  {typeof ch.wordCount === 'number' && (
                    <span className="text-[11px] text-ink/45 tabular-nums">
                      {ch.wordCount.toLocaleString()} {ch.wordCount === 1 ? 'word' : 'words'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
