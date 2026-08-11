import type { LanguageConventions } from './types.js';

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;
/* A dialogue turn opening mid-paragraph: sentence-final punctuation (or a
   colon, which introduces speech) + dash + uppercase. The uppercase lookahead
   is what excludes intra-word hyphens (где-то) and punctuation dashes followed
   by lowercase. */
const TURN_IN_PARAGRAPH = new RegExp(String.raw`([.!?…:])\s+${DASH}\s+(?=\p{Lu})`, 'gu');

/** Worst-paragraph merged-turn count for one chapter — the largest number of
    dialogue turns found inside any single paragraph that is NOT itself a
    properly-formed dialogue paragraph. In a language that gives every turn its
    own paragraph, such a turn cannot occur in correctly-converted text, so
    this counts conversion damage (#2254) directly rather than inferring it
    from engine confidence.

    A MAXIMUM, deliberately: false positives are sparse (a legitimate
    narration-then-quoted-speech paragraph yields 1-2) while a genuine merge is
    dense (dozens), and a maximum separates those by an order of magnitude
    where any sum or rate cannot. See the design of record, §2.1.

    `undefined` — never 0 — when the language has no paragraph-dash convention:
    the probe cannot score it, and 0 would read as "clean". */
export function measureChapterLegibility(
  body: string,
  conventions: LanguageConventions,
): number | undefined {
  const { dialogueOpen } = conventions;
  if (!dialogueOpen) return undefined;
  let worst = 0;
  for (const paragraph of body.split('\n')) {
    if (!paragraph.trim() || dialogueOpen.test(paragraph)) continue;
    const n = (paragraph.match(TURN_IN_PARAGRAPH) ?? []).length;
    if (n > worst) worst = n;
  }
  return worst;
}
