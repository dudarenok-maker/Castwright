/* Quote-continuation inheritance for silver-fixture seed labels.

   A silver seed is captured straight from the book's current, unverified
   attribution (see `buildSilverSkeleton` in capture.ts), which carries a
   systematic error: a multi-sentence speech has only its FIRST sentence
   attributed to the speaker; every continuation sentence defaults to
   `narrator`. That makes silver "truth" circular for the reattribute path —
   the seed contains the very errors the script-review pass is designed to
   fix, so a correct reattribution scores as harm (issue #1769).

   This pass repairs the seed with a text-grounded rule: track double-quote
   depth across the sentence sequence; a `narrator` sentence that BEGINS while
   a quote is still open is a continuation and inherits the speaker of the
   sentence that opened that quote. The depth-at-start test is what keeps a
   narration interjection — `“Stop,” he said, “now.”` split across sentences —
   correctly `narrator`, because "he said" begins after the first quote has
   closed (depth 0).

   Quote state is tracked as a BOOLEAN (in-quote / not), not a nesting counter.
   That deliberately matches EN typography for a single speaker's dialogue that
   spans multiple paragraphs: an opening “ begins EACH paragraph but a closing ”
   appears only at the very end — an unbalanced, odd number of marks. A counter
   would never return to zero and would bleed the speaker into all following
   narration; the boolean treats an “ while already in-quote as an idempotent
   paragraph reopen and a ” while not in-quote as a stray-close no-op, so the
   quote closes exactly once at the true end.

   Scope: the EN corpus uses only “ … ” (U+201C/U+201D); single quotes (’) are
   apostrophes here and are ignored. Non-EN quote systems (German „…“,
   French «…») are NOT handled — they degrade to a no-op (no repair, no
   regression) and are deferred to the ru/de fixture work (#1759). */

const OPEN = '“';
const CLOSE = '”';

export interface LabelledLine {
  text: string;
  speakerId: string;
}

export function inheritQuoteContinuations<T extends LabelledLine>(lines: T[]): T[] {
  let inQuote = false;
  let owner: string | null = null; // speaker of the line that opened the currently-open quote

  return lines.map((line) => {
    const insideAtStart = inQuote;
    const ownerAtStart = owner;

    // Update quote state from THIS line's marks, for the next line's start state.
    for (const ch of line.text) {
      if (ch === OPEN) {
        if (!inQuote) {
          inQuote = true; // false -> true records the opener; “ while open is a reopen (no-op)
          owner = line.speakerId;
        }
      } else if (ch === CLOSE) {
        if (inQuote) {
          inQuote = false; // ” while not in-quote is a stray close (no-op)
          owner = null;
        }
      }
    }

    // Only a narrator-defaulted continuation is repaired; a line already
    // attributed to a speaker is left as authored (never override an explicit
    // attribution).
    if (insideAtStart && line.speakerId === 'narrator' && ownerAtStart && ownerAtStart !== 'narrator') {
      return { ...line, speakerId: ownerAtStart };
    }
    return { ...line };
  });
}
