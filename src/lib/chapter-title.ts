/* Shared chapter-title constants. Split out from edit-chapter-title.tsx
   (PR-gate review finding 3) so a lazy-loaded route that only needs
   MAX_TITLE_LEN — e.g. manuscript.tsx's PromoteFirstSentenceButton — doesn't
   pull the entire EditChapterTitleModal chunk into its bundle. */

export const MAX_TITLE_LEN = 200;
