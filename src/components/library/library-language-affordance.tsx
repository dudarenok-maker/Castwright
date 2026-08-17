/* Task 9 (#2388) — a book's language in the library card / table row.

   When the book declares a language (`languageSet === true`) this is the
   language badge — the same magenta pill token the listen header uses
   (listen-header.tsx). When the language is unset it is an "unset"
   affordance: a dashed chip that opens the settings modal's language row
   (edit-book-meta.tsx in guard mode) so the user can fix the state that the
   server's `language_unset` failures are about. Branching on `languageSet` —
   NOT on `language` — because `language` carries a *resolved display value*
   ('en') for books that never declared one. */
import { IconPencil } from '../../lib/icons';
import { languageLabel } from '../../store/library-slice';
import type { LibraryBook } from '../../lib/types';

interface Props {
  book: LibraryBook;
  /** Called when the user clicks the "unset" affordance so the caller can open
      the settings modal's language row (guard mode). Ignored when the book
      has a language set — the badge is not interactive. */
  onSetLanguage?: () => void;
}

export function LibraryLanguageAffordance({ book, onSetLanguage }: Props) {
  const isSet = book.languageSet === true;
  if (isSet) {
    /* Badge — matches the listen header's fs-2 token (data-testid + classes). */
    return (
      <span
        data-testid={`library-language-badge-${book.bookId}`}
        className="inline-block text-[11px] font-semibold uppercase tracking-[0.08em] text-magenta bg-magenta/10 border border-magenta/20 rounded-full px-2.5 py-0.5"
      >
        {languageLabel(book.language ?? 'en')}
      </span>
    );
  }
  /* Unset affordance — `min-h-[44px] fine-pointer:min-h-0` keeps the touch
     target at the mobile protocol minimum without shrinking it at exactly
     tablet width (`sm:` would). */
  return (
    <button
      type="button"
      data-testid={`library-language-unset-${book.bookId}`}
      /* Stop propagation so the click doesn't also open the book / select the
         row — the parent card and table row are both clickable surfaces. */
      onClick={(e) => {
        e.stopPropagation();
        onSetLanguage?.();
      }}
      className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/50 border border-dashed border-ink/25 rounded-full px-2.5 py-0.5 hover:text-magenta hover:border-magenta/40 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-magenta/40 min-h-[44px] fine-pointer:min-h-0"
    >
      <IconPencil className="w-3 h-3" />
      Language unset
    </button>
  );
}
