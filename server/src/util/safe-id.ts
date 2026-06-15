/* Canonical, deterministic, filename-safe id generation for ids derived from
   display names — characters and books (plan 219).

   The single chokepoint that replaces the pre-219 ASCII-only slugifiers
   (`toKebabId`, `bookIdFromTitle`, the three cross-book `normaliseToken`s), all
   of which normalised with `[^a-z0-9]` and so deleted every non-Latin character
   → a Cyrillic name collapsed to an empty/colliding id or match-key.

   Design (see plan 219 — Option C, transliteration deliberately NOT used):
     - `kebab` decomposes + strips combining marks (so accented Latin deburrs to
       ASCII exactly like the legacy slug — café → cafe), then keeps letters/
       numbers of ANY script via `\p{L}\p{N}`. So ASCII and accented-Latin output
       is byte-identical to the legacy slug (zero churn for existing English
       books), while Cyrillic/CJK letters are PRESERVED rather than erased.
     - empty result (punctuation-only / unrenderable) → a stable `char-<hash>`.
     - collisions disambiguate by a hash of the NAME (deterministic across runs
       and roster orderings — never a run-order counter, which would yield
       unstable ids → orphaned designed voices).

   Pure: no I/O, no model calls. */

/** djb2 — short deterministic hash, base-36. Stable across runs/platforms. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** Strip accents from LATIN letters only (café → cafe, matching the legacy
    slug) WITHOUT corrupting other scripts. A global NFD+strip would mangle
    Cyrillic, whose composed letters decompose to base+combining too (й → и +
    breve, ё → е + diaeresis). So: decompose, drop combining marks only when
    they follow an ASCII letter, then recompose everything else (NFC) — Cyrillic
    round-trips untouched. */
function deburrLatin(s: string): string {
  return s
    .normalize('NFD')
    .replace(/([a-z])[̀-ͯ]+/gi, '$1')
    .normalize('NFC');
}

/** Unicode-preserving kebab. Deburrs accented Latin to ASCII (matching the
    legacy slug) but keeps base letters of any script. "Café" → `cafe`,
    "Анна" → `анна`, "Война" → `война`, "Master Oduvan" → `master-oduvan`.
    Exported so `workspace/paths.ts` `slug` and the id helpers share ONE
    normalisation (plan 219 — single chokepoint). */
export function unicodeKebab(name: string): string {
  return deburrLatin(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** A non-empty, deterministic, filename-safe id for a display name.
    `opts.taken` (other ids already minted in this roster) drives deterministic,
    name-keyed disambiguation; `opts.prefix` (default `char`) names the
    empty-slug hash fallback. */
export function safeId(name: string, opts?: { taken?: Set<string>; prefix?: string }): string {
  const prefix = opts?.prefix ?? 'char';
  let id = unicodeKebab(name) || `${prefix}-${djb2(name)}`;
  if (opts?.taken?.has(id)) id = `${id}-${djb2(name)}`;
  return id;
}

/** Book id from a title: Unicode kebab, capped at 32 chars without leaving a
    trailing hyphen, `book` when the title has no usable characters. */
export function safeBookId(title: string): string {
  const slug = unicodeKebab(title).slice(0, 32).replace(/-+$/g, '');
  return slug || 'book';
}

/** Cross-book name-match key — Unicode-EXACT, NO transliteration. Lowercases,
    deburrs combining marks, and removes every non-(letter|number). Distinct
    Cyrillic names never collide (a lossy transliteration here would risk false
    cross-book merges). ASCII output is byte-identical to the legacy key. */
export function normaliseNameKey(s: string | undefined): string {
  if (!s) return '';
  return deburrLatin(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
