/* Per-language ASR word-error-rate normalization data (#1084). Declarative
   data only — frozen arrays built once at module load, never per-call
   closures — so this stays a plain lookup from segment-asr-qa.ts's
   perspective. Deliberately NOT part of language-registry.ts's LanguageEntry:
   that interface holds heading/front-matter parsing data with unrelated
   consumers; ASR-QA is its own concern with its own consumer
   (segment-asr-qa.ts), so it gets its own module. See the design spec
   (docs/superpowers/specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md)
   for the full per-language composition-rule rationale.

   WER_INTEGERS[lang][n] = the token array for integer n (0..99). Numbers
   >= 100 aren't covered here — normalizeForWer in segment-asr-qa.ts leaves
   the digit as-is for those, mirroring English's spellInteger, which also
   declines 3+ digit numbers. */

type IntegerTable = ReadonlyArray<readonly string[]>;

const ES_ONES = [
  'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete',
  'dieciocho', 'diecinueve',
];
const ES_TWENTIES = [
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve',
];
const ES_DECADES: Record<number, string> = {
  3: 'treinta', 4: 'cuarenta', 5: 'cincuenta', 6: 'sesenta',
  7: 'setenta', 8: 'ochenta', 9: 'noventa',
};

/** Spanish is regular past 29 (unlike French): every decade 30-90 composes
    as [decade, 'y', ones]. Only 0-29 need literal/fused enumeration. */
function buildSpanish(): IntegerTable {
  const out: string[][] = [];
  for (let n = 0; n < 20; n += 1) out.push([ES_ONES[n]]);
  for (let n = 20; n < 30; n += 1) out.push([ES_TWENTIES[n - 20]]);
  for (let decade = 3; decade <= 9; decade += 1) {
    out.push([ES_DECADES[decade]]);
    for (let ones = 1; ones <= 9; ones += 1) out.push([ES_DECADES[decade], 'y', ES_ONES[ones]]);
  }
  return out;
}

export const WER_INTEGERS: Readonly<Record<string, IntegerTable>> = Object.freeze({
  es: Object.freeze(buildSpanish()),
});

export const WER_CONTRACTIONS: Readonly<Record<string, Record<string, string>>> = Object.freeze({});
