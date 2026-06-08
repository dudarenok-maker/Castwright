/* Shared narrator-credit constants and helpers used by the book-state GET
   handler (Task 2) and the export builders (Task 3).

   NOTE: DEFAULT_NARRATOR_CREDIT is intentionally duplicated on the frontend
   in `src/store/book-meta-slice.ts` — there is no shared module between the
   server and the React app, so each side owns its own copy. Keep them in sync
   when the brand default changes. */

export const DEFAULT_NARRATOR_CREDIT = 'Castwright';

/** TPE1 artist for MP3/M4B export: a real human narrator credit, else the
    author. The brand default "Castwright" is treated as "no human narrator"
    so the artist tag stays the author (TPE1 = who performed/narrated, not
    the brand that rendered it). The visible Listen credit + the comment stamp
    DO say Castwright — this sentinel only governs the TPE1 artist tag. */
export function artistForExport(state: { narratorCredit?: string | null; author: string }): string {
  const c = state.narratorCredit?.trim();
  return c && c !== DEFAULT_NARRATOR_CREDIT ? c : state.author;
}
