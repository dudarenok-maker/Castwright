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
   entry. The safety net is the caller's UNAMBIGUOUS-match rule: normalization
   only ever REMAPS when the stripped form resolves to exactly one roster
   entry — never when it maps to zero (a genuinely-missed speaker stays
   demoted) or to more than one (never guess). Over-stripping therefore cannot
   silently merge two distinct people: the ambiguity guard refuses the remap.

   Deliberately NOT a general romanization/translation step — it only bridges
   title-variants of the SAME CJK name. Latin ids in a CJK book are left
   untouched (the caller gates on `hasCjkChar`). */

import { hasCjkChar } from '../util/cjk.js';

/** True for the CJK book languages this normalization targets. `lang` is the
    primary subtag as produced by `normaliseBookLanguage` (e.g. 'zh', 'ja'). */
export function isCjkLanguage(lang: string): boolean {
  return lang === 'zh' || lang === 'ja';
}

/* Trailing honorifics / titles (zh + ja) that fuse to the END of a name.
   Longest-first so 老爷子 strips before 老爷, 掌柜的 before 掌柜. Conservative:
   only forms that are unambiguously an appended title, never a name syllable
   in normal use. */
const TRAILING_TITLES: readonly string[] = [
  // Chinese — respectful / role
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
  // Japanese — honorific suffixes
  'さん',
  'ちゃん',
  'くん',
  'さま',
  '様',
  '氏',
  '君',
  '殿',
  '先生',
];

/* Leading role-titles (zh) that fuse to the START of a name — occupation /
   office titles observed fused to names in the corpus, plus the familiar
   prefixes 老/小/阿. Longest-first. */
const LEADING_TITLES: readonly string[] = [
  '烧炭人',
  '地保',
  '货郎',
  '老',
  '小',
  '阿',
];

/** Strip leading role-titles and trailing honorifics from a fused CJK name.

    Conservative: a title is only stripped when what remains is non-empty AND
    still contains a CJK character (so a bare title like `师傅` or `narrator`
    is returned unchanged rather than emptied). Strips at most one match per
    side — real fused forms carry a single title, and stopping after one keeps
    the transform predictable. Non-CJK input is returned unchanged.

    NOTE: normalization alone does NOT establish identity — two people can
    normalize to the same core. Callers MUST only act on a unique roster match.
    Exported for unit testing. */
export function stripCjkHonorifics(name: string): string {
  if (!name || !hasCjkChar(name)) return name;
  let core = name.trim();

  // Trailing title (one match, longest-first).
  for (const t of TRAILING_TITLES) {
    if (core.length > t.length && core.endsWith(t)) {
      const rest = core.slice(0, core.length - t.length);
      if (hasCjkChar(rest)) {
        core = rest;
        break;
      }
    }
  }

  // Leading title (one match, longest-first).
  for (const t of LEADING_TITLES) {
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
    honorific-stripped. Empty/blank for non-CJK so the caller can skip it. */
function honorificKey(name: string): string {
  if (!name || !hasCjkChar(name)) return '';
  return stripCjkHonorifics(name);
}

/** Build a lookup from honorific-stripped key → set of roster ids that carry
    that key (via their id, name, or any alias). A key mapping to >1 id is
    ambiguous and must not be used to remap. */
export function buildCjkHonorificIndex(
  characters: ReadonlyArray<{ id: string; name?: string; aliases?: string[] }>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (raw: string | undefined, id: string): void => {
    const key = honorificKey(raw ?? '');
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
    id via honorific-stripped matching, or return null when the stripped form
    matches zero or more-than-one roster entries (never guess). Only attempts
    CJK ids — a latin orphan in a CJK book returns null. */
export function resolveCjkHonorificId(
  orphanId: string,
  index: Map<string, Set<string>>,
): string | null {
  const key = honorificKey(orphanId);
  if (!key) return null;
  const matches = index.get(key);
  if (!matches || matches.size !== 1) return null;
  const [only] = matches;
  return only === orphanId ? null : only;
}
