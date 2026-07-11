/* Signal 1 of the third-party front-matter guard (#1447). A DEDICATED
   essay/critical-article title predicate, kept SEPARATE from
   isLikelyFrontMatterTitle / frontMatterKeywords — those drive chapter
   `excluded` (store/manuscripts.ts, routes/import.ts), which would drop the
   essay from synthesis and moot the guard. This predicate is wired ONLY into
   third-party-front-matter-guard.ts and never into the exclusion machinery.

   Single multilingual regex for v1 (ru/en critical-essay forms). Extend with
   a per-language term list only when real corpus data needs it. */

/* NOTE: `\p{L}` + the `u` flag is REQUIRED — JavaScript `\w` is ASCII-only and
   matches NO Cyrillic, so `\w*` would fail on "вступительн-ая статья". `\p{L}*`
   absorbs the Russian inflectional endings. Verified against every Task 1 case. */
const ESSAY_TITLE_RX =
  /вступительн\p{L}*\s+стать\p{L}*|критическ\p{L}*\s+стать\p{L}*|critical\s+(introduction|essay)|introductory\s+(article|essay)/iu;

export function isNonStoryEssayTitle(title: string | undefined): boolean {
  if (!title) return false;
  return ESSAY_TITLE_RX.test(title.trim());
}
