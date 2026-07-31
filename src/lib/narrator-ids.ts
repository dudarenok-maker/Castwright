/* #1895 — the two character-id shapes that mean "this is the narrator": the
   synthetic id assigned when a book has no separate narrator character
   ('narrator'), and the id used once the narrator is promoted to a
   first-class cast row ('char-narrator'). Was independently inline-copied
   in three frontend modules (principal-cast.ts, tts-voice-mapping.ts,
   rebaseline-modal.tsx); centralised here so a future change to what counts
   as "the narrator" only needs to happen in one place per side of the
   frontend/server boundary. Twin on the server side:
   `server/src/analyzer/narrator-identity.ts` (`NARRATOR_CHARACTER_IDS`) —
   keep both in sync if a new synthetic-id shape is ever added. */
export const NARRATOR_CHARACTER_IDS: readonly string[] = ['narrator', 'char-narrator'];
