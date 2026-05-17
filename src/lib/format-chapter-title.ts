/* Strip a redundant "Chapter N — " (or ": ", " ") prefix from a chapter
   title. Used by every UI site that renders its own "CH NN" or "Chapter
   N" prefix next to the title — without this, titles produced by the
   parser's subtitle merge ("Chapter 3 — The Beginning") would show up
   as "CH 03 · Chapter 3 — The Beginning".

   Conservative: only strips when the prefix is followed by a separator
   (em-dash, colon, or hyphen with spaces). A bare "Chapter 3" with no
   following text stays as-is so the user still sees something. */
const PREFIX_RE =
  /^chapter\s+(?:[ivxlcdm\d]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\s*[—:–-]\s+/i;

export function stripChapterPrefix(title: string): string {
  if (!title) return title;
  const stripped = title.replace(PREFIX_RE, '').trim();
  return stripped.length > 0 ? stripped : title;
}
