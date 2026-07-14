/* CJK honorific / role-title normalization for attribution-id reconciliation
   (fix: honorific-fused attributions false-demote & trip the drift gate).

   In Chinese/Japanese manuscripts an honorific or role-title fuses to a name
   with NO separator: 奥杜万师傅 (Master Oduvan), 卡斯珀寡妇 (Widow Casper),
   莱瑟姆神父 (Father Lessom), 地保玛俐恩 (Constable Maerin), 货郎伊沃 (Ivo the
   peddler). Phase-0 rostering and Phase-1 attribution do not always agree on
   whether to include the title, so the same person can appear as `奥杜万师傅`
   in one place and `奥杜万` in another. The Phase-1 id reconciler
   (`reconcileSentenceCharacterIds`) compares by STRICT id equality, so a
   title-variant that doesn't byte-match the roster id is demoted to narrator —
   and enough such false demotions trip the 5% attribution-drift gate that
   refuses the whole run.

   This module strips a CONSERVATIVE, documented set of leading role-titles and
   trailing honorifics so a title-variant can be matched back to its roster
   entry. Two safety rails:

   1. PER-LANGUAGE gating. The affix lists are applied by book language only —
      the zh lists for a `zh` book, the ja list for a `ja` book — never the
      union. Without this, single-character ja honorifics (君/氏/様/殿) would
      over-strip Chinese given names (丽君 → 丽; 君 is a common Chinese name
      character), and vice versa.

   2. UNAMBIGUOUS-match remapping (enforced by the caller). Normalization only
      ever REMAPS when the stripped form resolves to exactly one roster entry.
      This blocks >1-match collisions but does NOT protect against a
      coincidental single match to the WRONG person, so the affix lists are
      kept deliberately narrow: only multi-character occupation titles as
      leading affixes (烧炭人 / 地保 / 货郎), never the single-character
      familiar prefixes 老/小/阿 which are integral name syllables (小雀 =
      Sparrow, 阿强) and would silently mis-remap.

   Deliberately NOT a general romanization/translation step — it only bridges
   title-variants of the SAME CJK name. Latin ids in a CJK book are left
   untouched (`hasCjkChar` gate). */

import { hasCjkChar } from '../util/cjk.js';

/** The CJK book languages this normalization targets. `lang` is the primary
    subtag as produced by `normaliseBookLanguage` (e.g. 'zh', 'ja'). */
export type CjkLang = 'zh' | 'ja';

/** True for the CJK book languages this normalization targets. */
export function isCjkLanguage(lang: string): lang is CjkLang {
  return lang === 'zh' || lang === 'ja';
}

/* Chinese trailing honorifics / titles that fuse to the END of a name.
   Longest-first so 老爷子 strips before 老爷, 掌柜的 before 掌柜. Conservative:
   only forms that are unambiguously an appended title. */
const ZH_TRAILING_TITLES: readonly string[] = [
  '老爷子',
  '掌柜的',
  '师傅',
  '大师',
  '先生',
  '女士',
  '夫人',
  '太太',
  '小姐',
  '公子',
  '寡妇',
  '神父',
  '牧师',
  '大人',
  '老爷',
  '掌柜',
  '大娘',
  '大爷',
  '大夫',
  '医生',
  '队长',
  '将军',
  '陛下',
  '殿下',
  '公公',
  '婆婆',
];

/* Chinese leading role-titles that fuse to the START of a name. ONLY
   multi-character occupation/office titles — the single-character familiar
   prefixes 老/小/阿 are deliberately excluded (they are integral name
   syllables and would silently mis-remap; the unique-match guard does not
   protect a coincidental wrong single match). Longest-first. */
const ZH_LEADING_TITLES: readonly string[] = ['烧炭人', '地保', '货郎'];

/* Japanese trailing honorific suffixes. Applied only for a `ja` book (see
   per-language gating) — several are single-character (様/氏/君/殿) and would
   over-strip Chinese names if the union were applied to a zh book.
   Longest-first. */
const JA_TRAILING_TITLES: readonly string[] = [
  'さん',
  'ちゃん',
  'くん',
  'さま',
  '先生',
  '様',
  '氏',
  '君',
  '殿',
];

/* Japanese has no fused leading role-titles in this corpus. */
const JA_LEADING_TITLES: readonly string[] = [];

function trailingTitlesFor(lang: CjkLang): readonly string[] {
  return lang === 'ja' ? JA_TRAILING_TITLES : ZH_TRAILING_TITLES;
}

function leadingTitlesFor(lang: CjkLang): readonly string[] {
  return lang === 'ja' ? JA_LEADING_TITLES : ZH_LEADING_TITLES;
}

/** Strip leading role-titles and trailing honorifics from a fused CJK name,
    using ONLY the affix lists for `lang` (never the zh+ja union).

    Conservative: a title is only stripped when what remains is non-empty AND
    still contains a CJK character (so a bare title like `师傅` or `narrator`
    is returned unchanged rather than emptied). Strips at most one match per
    side — real fused forms carry a single title, and stopping after one keeps
    the transform predictable. Non-CJK input is returned unchanged.

    NOTE: normalization alone does NOT establish identity — two people can
    normalize to the same core. Callers MUST only act on a unique roster match.
    Exported for unit testing. */
export function stripCjkHonorifics(name: string, lang: CjkLang): string {
  if (!name || !hasCjkChar(name)) return name;
  let core = name.trim();

  // Trailing title (one match, longest-first).
  for (const t of trailingTitlesFor(lang)) {
    if (core.length > t.length && core.endsWith(t)) {
      const rest = core.slice(0, core.length - t.length);
      if (hasCjkChar(rest)) {
        core = rest;
        break;
      }
    }
  }

  // Leading title (one match, longest-first).
  for (const t of leadingTitlesFor(lang)) {
    if (core.length > t.length && core.startsWith(t)) {
      const rest = core.slice(t.length);
      if (hasCjkChar(rest)) {
        core = rest;
        break;
      }
    }
  }

  return core;
}

/** Normalization key used to compare a fused name against a roster entry:
    honorific-stripped for `lang`. Empty/blank for non-CJK so the caller can
    skip it. */
function honorificKey(name: string, lang: CjkLang): string {
  if (!name || !hasCjkChar(name)) return '';
  return stripCjkHonorifics(name, lang);
}

/** Build a lookup from honorific-stripped key → set of roster ids that carry
    that key (via their id, name, or any alias), normalized for `lang`. A key
    mapping to >1 id is ambiguous and must not be used to remap. */
export function buildCjkHonorificIndex(
  characters: ReadonlyArray<{ id: string; name?: string; aliases?: string[] }>,
  lang: CjkLang,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (raw: string | undefined, id: string): void => {
    const key = honorificKey(raw ?? '', lang);
    if (!key) return;
    let set = index.get(key);
    if (!set) {
      set = new Set<string>();
      index.set(key, set);
    }
    set.add(id);
  };
  for (const c of characters) {
    add(c.id, c.id);
    add(c.name, c.id);
    for (const a of c.aliases ?? []) add(a, c.id);
  }
  return index;
}

/** Resolve an orphaned (not-in-roster) CJK attribution id to a UNIQUE roster
    id via honorific-stripped matching (normalized for `lang`), or return null
    when the stripped form matches zero or more-than-one roster entries (never
    guess). Only attempts CJK ids — a latin orphan in a CJK book returns null.
    `lang` MUST match the language the index was built with. */
export function resolveCjkHonorificId(
  orphanId: string,
  index: Map<string, Set<string>>,
  lang: CjkLang,
): string | null {
  const key = honorificKey(orphanId, lang);
  if (!key) return null;
  const matches = index.get(key);
  if (!matches || matches.size !== 1) return null;
  const [only] = matches;
  return only === orphanId ? null : only;
}
