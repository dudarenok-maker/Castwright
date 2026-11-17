import type { LanguageConventions } from './types.js';
import { conventionsFor } from './lang/index.js';

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;
/* A dialogue turn opening mid-paragraph: sentence-final punctuation (or a
   colon, which introduces speech) + dash + uppercase. The uppercase lookahead
   is what excludes intra-word hyphens (где-то) and punctuation dashes followed
   by lowercase. */
const TURN_IN_PARAGRAPH = new RegExp(String.raw`(?:[.!?…:])\s+${DASH}\s+(?=\p{Lu})`, 'gu');

/** Worst-paragraph merged-turn count for one chapter — the largest number of
    dialogue turns found inside any single paragraph. Every non-blank
    paragraph is counted, including one that itself opens with a dash: under a
    MAXIMUM (not a sum or rate), a paragraph-opener exclusion buys nothing and
    actively hides merges — a fully-merged mega-paragraph reads clean purely
    because its first turn happens to start the paragraph. In a language that
    gives every turn its own paragraph, a turn opener inside a paragraph
    cannot occur in correctly-converted text, so this counts conversion
    damage (#2254) directly rather than inferring it from engine confidence.

    A MAXIMUM, deliberately: false positives are sparse (a legitimate
    narration-then-quoted-speech paragraph yields 1-2) while a genuine merge is
    dense (dozens), and a maximum separates those by an order of magnitude
    where any sum or rate cannot. See the design of record, §2.1.

    `undefined` — never 0 — when the language has no paragraph-dash convention:
    the probe cannot score it, and 0 would read as "clean". `dialogueOpen` is
    used only for that applicability check, never to skip a paragraph. */
export function measureChapterLegibility(
  body: string,
  conventions: LanguageConventions,
): number | undefined {
  const { dialogueOpen } = conventions;
  if (!dialogueOpen) return undefined;
  let worst = 0;
  for (const paragraph of body.split('\n')) {
    if (!paragraph.trim()) continue;
    const n = (paragraph.match(TURN_IN_PARAGRAPH) ?? []).length;
    if (n > worst) worst = n;
  }
  return worst;
}

/** Merged-turn count at or above which a chapter's paragraph structure is
    treated as degraded. PROVISIONAL (owner decision 3, 2026-11-15): calibrated
    on one real clean ru book plus the authored fixtures (#2267 §2.2). The
    library-wide false-positive scan of on-box register row B110
    (added at the end of the #2254 chain) is the calibration that will confirm
    it; the provisional label is dropped only when that scan finds no breach in
    any scanned book AND at least one clean, dialogue-dense ru dash book
    (owner decisions 13, 15, 17, 21). */
export const MERGED_TURNS_DEGRADED = 10;

/** Languages the degradation notice applies to: ru only (Decision 4). es and fr
    are uncalibrated and stay operator-log only (TURN_IN_PARAGRAPH needs
    whitespace after the dash, so `—Hola —dijo—.` can never match). uk/bg and
    other Cyrillic books reach it only through detection's >= 30% Cyrillic rule
    and sit under the provisional label. Mirrored in `src/lib/` for the confirm
    view. */
export const NOTICE_LANGUAGES: readonly string[] = ['ru'];

/** `true` when the worst paragraph has >= MERGED_TURNS_DEGRADED merged turns,
    `false` when measured and below it, `undefined` when not measured (absent
    is not clean, #2267): no language, a language outside NOTICE_LANGUAGES, or
    one with no conventions table. The base tag is normalised the way
    `conventionsFor` does it, so `ru-RU` measures like `ru`. */
export function isParagraphDegraded(
  body: string,
  language: string | null | undefined,
): boolean | undefined {
  if (!language) return undefined;
  const base = language.toLowerCase().split(/[-_]/u)[0];
  if (!NOTICE_LANGUAGES.includes(base)) return undefined;
  const conventions = conventionsFor(language);
  if (!conventions) return undefined;
  const worst = measureChapterLegibility(body, conventions);
  return worst === undefined ? undefined : worst >= MERGED_TURNS_DEGRADED;
}

/** A fresh RegExp for the turn-in-paragraph pattern on every call, so no
    caller shares `lastIndex` on a `g` regex. */
export function turnInParagraphRegex(): RegExp {
  return new RegExp(TURN_IN_PARAGRAPH.source, TURN_IN_PARAGRAPH.flags);
}

/** Total turn openers inside paragraphs over the chapter (a sum, unlike
    `measureChapterLegibility`'s maximum). Counted per `
`-split line, so a
    match never spans a line break and the result is always >= the ru maximum.
    Takes no conventions: hidden-turn counts for the scanner and runner. */
export function countTurnOpeners(body: string): number {
  let total = 0;
  for (const paragraph of body.split('\n')) {
    if (!paragraph.trim()) continue;
    total += (paragraph.match(TURN_IN_PARAGRAPH) ?? []).length;
  }
  return total;
}
