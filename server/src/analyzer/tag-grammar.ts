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
  /** Word order of the tag relative to the name. Also selects the regex flag
      set: 'name-verb' is ASCII (no `u`), 'verb-name' uses `u` for \p{Lu}/\p{L}. */
  order: 'name-verb' | 'verb-name';
  /** Regex source (no flags) capturing one capitalized name token. */
  nameCapture: string;
  /** Flip target: 'preceding' (en, the prior sentence) or 'adjacent' (es/ru,
      guarded neighbours — see recover-tagged-lines.ts). */
  flipStrategy: 'preceding' | 'adjacent';
  /** Pronouns/articles that look like a name in verb-name order but aren't. */
  stopwords?: readonly string[];
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
] as const;
const RU_STOPWORDS = [
  'он', 'она', 'оно', 'они', 'это', 'тот', 'та', 'кто', 'что', 'там', 'тут', 'так', 'вот',
] as const;

// English name token — IDENTICAL to the historical makeTagRegex character class.
const EN_NAME = "[A-Z][A-Za-z''-]+";
// Unicode name token (es/ru): a capital letter + letters/apostrophes/hyphens.
const UNI_NAME = "\\p{Lu}[\\p{L}''-]+";

const TAG_GRAMMARS: Record<string, TagGrammar> = {
  en: { verbs: DIALOGUE_VERBS, order: 'name-verb', nameCapture: EN_NAME, flipStrategy: 'preceding' },
  es: { verbs: ES_VERBS, order: 'verb-name', nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, order: 'verb-name', nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: RU_STOPWORDS },
};

/** Grammar row for a book language, or null when unmapped (caller stays gated). */
export function grammarFor(language: string): TagGrammar | null {
  return TAG_GRAMMARS[normaliseBookLanguage(language)] ?? null;
}

// A dialogue "beat" the verb anchors to in verb-name order: start-of-string or a
// quote-close / em-dash / en-dash / hyphen / comma / colon. NO bare-whitespace
// alternative (else a narrative polysemous verb false-matches — spec C).
const VERB_BEAT = '(?:^|[—–\\-«»""",:]\\s*)';

/** Full tag regex: one capture group = the speaker name. No `g` flag. */
export function tagRegexFor(g: TagGrammar): RegExp {
  const verbs = g.verbs.join('|');
  if (g.order === 'name-verb') {
    // Byte-identical to the historical makeTagRegex (no `u`, no `g`).
    return new RegExp(`\\b(${g.nameCapture})\\s+(?:${verbs})\\b`);
  }
  // verb-name: beat + verb + up to two lowercase role tokens + the name.
  return new RegExp(`${VERB_BEAT}(?:${verbs})\\s+(?:\\p{Ll}[\\p{L}''-]*\\s+){0,2}(${g.nameCapture})`, 'u');
}

/** "This text carries a dialogue verb on a beat" — name NOT required. Used to
    disqualify a flip neighbour that is itself a tag (resolvable OR pronoun). */
export function verbBeatRegexFor(g: TagGrammar): RegExp {
  const verbs = g.verbs.join('|');
  if (g.order === 'name-verb') return new RegExp(`\\b(?:${verbs})\\b`);
  // \b does not fire on Cyrillic (non-ASCII-word chars); use \p{L} lookahead instead.
  return new RegExp(`${VERB_BEAT}(?:${verbs})(?!\\p{L})`, 'u');
}

const QUOTE_GLYPHS = /[«»"""]|^\s*[—–]/u;
/** True if the sentence looks like (part of) a quote: a guillemet/curly/straight
    quote glyph, or a leading em/en-dash (ES/RU dialogue opener). */
export function isQuoteBearing(text: string): boolean {
  return QUOTE_GLYPHS.test(text);
}
