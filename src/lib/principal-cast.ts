/* Principal-cast selector (plan 108, Wave 4).

   "Principal cast" = the smallest set of speaking characters that together
   account for at least `thresholdPct` (default 80%) of the non-narrator
   dialogue lines. Used to pre-select which characters the Wave-5
   rebaseline modal proposes new voices for (you rarely want to re-voice a
   one-line bystander), and reusable anywhere a "main characters" subset is
   wanted.

   The narrator is ALWAYS excluded — it carries the bulk of the lines in
   most books but stays on a Kokoro preset (plan 108) rather than a
   bespoke designed voice, so including it would swamp the threshold and
   defeat the point. */

const NARRATOR_IDS = new Set(['narrator', 'char-narrator']);

function isNarrator(id: string, name?: string): boolean {
  if (NARRATOR_IDS.has(id.toLowerCase())) return true;
  return (name ?? '').toLowerCase() === 'narrator';
}

export interface PrincipalCastCharacter {
  id: string;
  name?: string;
}

export interface SelectPrincipalCastOptions {
  /** Fraction of non-narrator lines the selection must cover, in [0, 1].
      Default 0.8 (80%). Clamped into range. */
  thresholdPct?: number;
}

/* Returns the set of character ids forming the principal cast.

   - The narrator is excluded outright (even if it has the most lines).
   - Remaining characters are sorted by line count descending (ties broken
     by id for determinism), then accumulated until the running total
     reaches `thresholdPct` of all non-narrator lines.
   - A character with zero lines never gets pulled in (it can't advance the
     coverage), so a book with <80% of lines concentrated still stops at
     the last contributor rather than padding with silent entries.
   - When there are no non-narrator lines at all, the result is empty. */
export function selectPrincipalCast(
  characters: PrincipalCastCharacter[],
  lineCountById: Record<string, number>,
  { thresholdPct = 0.8 }: SelectPrincipalCastOptions = {},
): Set<string> {
  const pct = Math.min(1, Math.max(0, thresholdPct));

  const speakers = characters
    .filter((c) => !isNarrator(c.id, c.name))
    .map((c) => ({ id: c.id, lines: Math.max(0, lineCountById[c.id] ?? 0) }))
    .sort((a, b) => (b.lines !== a.lines ? b.lines - a.lines : a.id.localeCompare(b.id)));

  const totalLines = speakers.reduce((sum, s) => sum + s.lines, 0);
  const selected = new Set<string>();
  if (totalLines === 0) return selected;

  const target = totalLines * pct;
  let running = 0;
  for (const s of speakers) {
    if (running >= target) break;
    if (s.lines === 0) break; // zero-line speakers can't advance coverage
    selected.add(s.id);
    running += s.lines;
  }
  return selected;
}
