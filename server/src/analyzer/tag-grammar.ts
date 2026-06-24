/* Per-language dialogue-tag grammar (fs-41/fs-50 §4.3 localisation, #1028).
   Single source of truth for how a language tags a quote's speaker, feeding the
   tag detection in recover-tagged-lines.ts. English reproduces the historical
   makeTagRegex exactly; es/ru add verb-before-name order + Unicode names; any
   other language has no row and stays gated (caller returns the no-op). */

import { DIALOGUE_VERBS } from './dialogue-verbs.js';
import { normaliseBookLanguage } from '../tts/language.js';

export interface TagGrammar {
  /** Localized dialogue verbs. All gendered/inflected surface forms listed
      explicitly (not stemmed): RU 'сказал' AND 'сказала'. Inclusion-biased. */
  verbs: readonly string[];
  /** Word orders the language uses, in priority. Each yields its own regex
      (NEVER a single alternation — finding A: that would move the name out of
      capture group 1). en is name-verb only; es/ru/fr/de gain a second order
      in a later task. */
  orders: readonly ('name-verb' | 'verb-name')[];
  /** Regex source (no flags) capturing one capitalized name token. */
  nameCapture: string;
  /** Flip target: 'preceding' (en, the prior sentence) or 'adjacent' (es/ru,
      guarded neighbours — see recover-tagged-lines.ts). */
  flipStrategy: 'preceding' | 'adjacent';
  /** Pronouns/articles that look like a name in verb-name order but aren't. */
  stopwords?: readonly string[];
  /** Capitalized honorifics to skip before the name in verb-name order (de). */
  titles?: readonly string[];
}

// Curated, inclusion-biased (a missing verb silently drops a real speaker; an
// over-broad one is filtered by the roster-resolution gate). Extend by adding here.
const ES_VERBS = [
  'dijo', 'preguntó', 'respondió', 'contestó', 'añadió', 'gritó', 'murmuró',
  'susurró', 'exclamó', 'replicó', 'repitió', 'insistió', 'continuó', 'pidió',
  'ordenó', 'suspiró',
] as const;
const RU_VERBS = [
  'сказал', 'сказала', 'спросил', 'спросила', 'ответил', 'ответила',
  'отозвался', 'отозвалась', 'проговорил', 'проговорила', 'пробормотал',
  'пробормотала', 'воскликнул', 'воскликнула', 'прошептал', 'прошептала',
  'продолжил', 'продолжила', 'добавил', 'добавила', 'крикнул', 'крикнула',
] as const;
const ES_STOPWORDS = [
  'él', 'ella', 'ellos', 'ellas', 'este', 'esta', 'eso', 'que', 'quien', 'aquí', 'allí',
  // name-verb openers (finding J)
  'entonces', 'luego', 'después', 'así', 'pero', 'aunque', 'mientras', 'cuando',
  'también', 'además', 'sin', 'por', 'finalmente', 'de', 'pronto',
] as const;
const RU_STOPWORDS = [
  'он', 'она', 'оно', 'они', 'это', 'тот', 'та', 'кто', 'что', 'там', 'тут', 'так', 'вот',
  // name-verb openers (finding J)
  'тогда', 'потом', 'затем', 'однако', 'хотя', 'наконец', 'вдруг', 'теперь', 'здесь',
] as const;
const FR_VERBS = [
  'dit', 'demanda', 'répondit', 'répliqua', 'ajouta', 'cria', 'murmura',
  'chuchota', 's’exclama', 'reprit', 'répéta', 'insista', 'continua', 'soupira',
  'lança', 'ordonna',
] as const;
const DE_VERBS = [
  'sagte', 'fragte', 'antwortete', 'erwiderte', 'rief', 'flüsterte', 'murmelte',
  'entgegnete', 'fuhr', 'meinte', 'erklärte', 'wiederholte', 'fügte', 'seufzte',
  'brüllte', 'stammelte',
] as const;
const FR_STOPWORDS = [
  'il', 'elle', 'ils', 'elles', 'je', 'tu', 'nous', 'vous', 'ce', 'cela', 'qui', 'que',
  'alors', 'puis', 'ensuite', 'mais', 'donc', 'quand', 'enfin', 'ici', 'là',
] as const;
const DE_STOPWORDS = [
  'er', 'sie', 'es', 'ich', 'du', 'wir', 'ihr', 'das', 'dies', 'wer', 'was',
  'dann', 'da', 'als', 'doch', 'aber', 'also', 'hier', 'dort', 'schließlich', 'plötzlich',
] as const;
/* German honorifics: capitalized, so the lowercase role-token skip in the verb-name
   regex won't skip them — list them explicitly to capture the following surname. */
const DE_TITLES = [
  'Herr', 'Frau', 'Fräulein', 'Dr', 'Doktor', 'Professor', 'Prof', 'Graf',
  'Gräfin', 'Baron', 'Baronin', 'König', 'Königin', 'Prinz', 'Prinzessin',
  'Meister', 'Hauptmann',
] as const;

// English name token — IDENTICAL to the historical makeTagRegex character class.
const EN_NAME = "[A-Z][A-Za-z’'-]+";
// Unicode name token (es/ru): a capital letter + letters/apostrophes/hyphens.
const UNI_NAME = "\\p{Lu}[\\p{L}’'-]+";

const TAG_GRAMMARS: Record<string, TagGrammar> = {
  en: { verbs: DIALOGUE_VERBS, orders: ['name-verb'], nameCapture: EN_NAME, flipStrategy: 'preceding' },
  es: { verbs: ES_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: RU_STOPWORDS },
  fr: { verbs: FR_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: FR_STOPWORDS },
  de: { verbs: DE_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: DE_STOPWORDS, titles: DE_TITLES },
};

/** Grammar row for a book language, or null when unmapped (caller stays gated). */
export function grammarFor(language: string): TagGrammar | null {
  return TAG_GRAMMARS[normaliseBookLanguage(language)] ?? null;
}

// A dialogue "beat" the verb anchors to in verb-name order: start-of-string or a
// quote-close / em-dash / en-dash / hyphen / comma / colon. NO bare-whitespace
// alternative (else a narrative polysemous verb false-matches — spec C).
const VERB_BEAT = '(?:^|[—–\\-«»""",:]\\s*)';

/* Build ONE regex for a single order. Name is capture group 1. No flags. */
function buildOrderRegex(g: TagGrammar, order: 'name-verb' | 'verb-name'): RegExp {
  const verbs = g.verbs.join('|');
  if (order === 'name-verb') {
    if (g.nameCapture === EN_NAME) {
      // English: byte-identical to the historical makeTagRegex (ASCII \b, no u).
      return new RegExp(`\\b(${g.nameCapture})\\s+(?:${verbs})\\b`);
    }
    // Unicode languages: \b is ASCII-only and fails next to non-ASCII letters on
    // BOTH ends (e.g. trailing \b after Cyrillic "сказал") — use lookarounds (R2-8).
    return new RegExp(`(?<!\\p{L})(${g.nameCapture})\\s+(?:${verbs})(?!\\p{L})`, 'u');
  }
  // verb-name: beat + verb + up to two lowercase role tokens + optional
  // capitalized title (de) + the name.
  const titleSkip = g.titles?.length
    ? `(?:(?:${g.titles.join('|')})\\.?\\s+)?`
    : '';
  return new RegExp(
    `${VERB_BEAT}(?:${verbs})\\s+(?:\\p{Ll}[\\p{L}''-]*\\s+){0,2}${titleSkip}(${g.nameCapture})`,
    'u',
  );
}

/** One regex PER order (finding A: array, not alternation). Name = group 1 each.
    No `g` flag — for the per-sentence `.exec` model (recover-tagged-lines.ts). */
export function tagRegexesFor(g: TagGrammar): RegExp[] {
  return g.orders.map((order) => buildOrderRegex(g, order));
}

/** Body-scan variants: one FRESH regex PER order, each global (+ multiline so
    VERB_BEAT's ^ matches each line start). Body-scan ONLY — never use in the
    per-sentence model (its lastIndex would leak across sentences). */
export function tagScanRegexesFor(g: TagGrammar): RegExp[] {
  return g.orders.map((order) => {
    const re = buildOrderRegex(g, order);
    // Strip BOTH g and m before re-adding so a future builder that adds either
    // can't produce a duplicate-flag SyntaxError (P-3). Preserves u when present.
    return new RegExp(re.source, re.flags.replace(/[gm]/g, '') + 'gm');
  });
}

/** "This text carries a dialogue verb on a beat" — name NOT required; used to
    disqualify a flip neighbour that is itself a tag. OR of every order's beat;
    Unicode-safe (JS \b never fires on Cyrillic). */
export function verbBeatRegexFor(g: TagGrammar): RegExp {
  const verbs = g.verbs.join('|');
  const alts: string[] = [];
  for (const order of g.orders) {
    if (order === 'name-verb') {
      // ASCII for en (byte-identical), Unicode-safe lookarounds otherwise.
      alts.push(g.nameCapture === EN_NAME ? `\\b(?:${verbs})\\b` : `(?<!\\p{L})(?:${verbs})(?!\\p{L})`);
    } else {
      alts.push(`${VERB_BEAT}(?:${verbs})(?!\\p{L})`);
    }
  }
  // `u` is required by \p{…}; harmless for the en-only ASCII alternative.
  return new RegExp(alts.join('|'), 'u');
}

const QUOTE_GLYPHS = /[«»„"""]|^\s*[—–]/u;
/** True if the sentence looks like (part of) a quote: a guillemet/curly/straight
    quote glyph, or a leading em/en-dash (ES/RU dialogue opener). */
export function isQuoteBearing(text: string): boolean {
  return QUOTE_GLYPHS.test(text);
}
