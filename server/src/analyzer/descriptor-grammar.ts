/* Per-language "is this character name a throwaway descriptor?" data, sibling to
   tag-grammar.ts and consumed by foldMinorCast's isDescriptorName (#1050).

   The English rules (Unknown / "The <1-2 words>" / trailing role noun) are a
   UNIVERSAL baseline applied to every language — the model emits English
   descriptors even on non-English books (same rationale as the Unknown contract),
   and the historical isDescriptorName applied them unconditionally. Each non-English
   language adds EXTRAS via a grammar row; en + unmapped languages get the baseline
   alone (byte-identical to the historical behaviour).

   Function-word rule is RUSSIAN-ONLY: a proper Russian name never contains a
   preposition as a standalone token, but Romance/German names carry nobiliary
   particles (de Gaulle, von Bismarck), so es/fr/de leave functionWords empty
   (#938 lesson — never fold a real character). */

import { normaliseBookLanguage } from '../tts/language.js';

export interface DescriptorGrammar {
  /** Leading article tokens for the article-led rule (lowercased). Empty = off. */
  articles: ReadonlySet<string>;
  /** Generic role nouns (lowercased). */
  genericNouns: ReadonlySet<string>;
  /** bare = lone token; trailing = last token of a >=2-word name; both = either. */
  nounMatch: 'bare' | 'trailing' | 'both';
  /** Standalone prep/conj tokens marking a multi-word name as a description
      (lowercased). RU-ONLY; empty for es/fr/de. Empty = rule off. */
  functionWords: ReadonlySet<string>;
}

/* Universal English baseline (applied for EVERY language). Moved verbatim from
   fold-minor-cast.ts so the historical behaviour is byte-identical. */
const ENGLISH_GENERIC_TAIL: ReadonlySet<string> = new Set([
  'boy', 'girl', 'man', 'woman', 'guy', 'lady', 'kid', 'person', 'figure',
  'stranger', 'voice',
]);

const RU: DescriptorGrammar = {
  articles: new Set(),
  genericNouns: new Set([
    'девушка', 'парень', 'юноша', 'мужчина', 'женщина', 'незнакомец',
    'незнакомка', 'человек', 'голос', 'старик', 'старуха', 'парнишка',
    'оператор', 'водитель',
  ]),
  nounMatch: 'bare',
  functionWords: new Set([
    'с', 'со', 'в', 'во', 'на', 'по', 'под', 'из', 'у', 'за', 'к', 'ко',
    'о', 'об', 'обо', 'при', 'про', 'для', 'без', 'до', 'от', 'над',
    'и', 'или', 'а', 'но',
  ]),
};

const ES: DescriptorGrammar = {
  articles: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas']),
  genericNouns: new Set([
    'hombre', 'mujer', 'chico', 'chica', 'desconocido', 'desconocida',
    'anciano', 'anciana', 'niño', 'niña', 'señor', 'señora', 'voz', 'conductor',
  ]),
  nounMatch: 'both',
  functionWords: new Set(), // ru-only rule (finding B)
};

const FR: DescriptorGrammar = {
  articles: new Set(['le', 'la', "l'", 'les', 'un', 'une', 'des']),
  genericNouns: new Set([
    'homme', 'femme', 'garçon', 'fille', 'inconnu', 'inconnue', 'vieil',
    'vieille', 'voix', 'conducteur', 'enfant',
  ]),
  nounMatch: 'both',
  functionWords: new Set(),
};

const DE: DescriptorGrammar = {
  articles: new Set(['der', 'die', 'das', 'ein', 'eine']), // nominative only (R2-7)
  genericNouns: new Set([
    'mann', 'frau', 'junge', 'mädchen', 'fremder', 'fremde', 'stimme',
    'fahrer', 'alte', 'alter', 'kind',
  ]),
  nounMatch: 'both',
  functionWords: new Set(),
};

/* Extras only — en is the universal baseline (null), unmapped stays gated (null). */
const GRAMMARS: Record<string, DescriptorGrammar> = { ru: RU, es: ES, fr: FR, de: DE };

export function descriptorGrammarFor(language?: string): DescriptorGrammar | null {
  return GRAMMARS[normaliseBookLanguage(language)] ?? null;
}

/* Decides whether a character name reads as a descriptor rather than a proper
   name. English baseline first (universal), then language-specific extras. */
export function isDescriptorName(name: string, language?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;

  // (1) Stage-1 contract — language-independent.
  if (/^unknown\b/i.test(trimmed)) return true;
  // (2) English baseline — every language.
  if (/^the\s+\S+(\s+\S+)?$/i.test(trimmed)) return true;
  const parts = trimmed.split(/\s+/);
  const lower = parts.map((p) => p.toLowerCase());
  if (parts.length >= 2 && ENGLISH_GENERIC_TAIL.has(lower[lower.length - 1])) return true;

  // (3) Language-specific extras (en + unmapped → baseline only).
  const g = descriptorGrammarFor(language);
  if (!g) return false;

  // article-led: <article> + 1–2 words.
  if (g.articles.size) {
    if ((parts.length === 2 || parts.length === 3) && g.articles.has(lower[0])) return true;
    // FR elision: "L'Homme" tokenises as ONE part "l'homme".
    if (parts.length <= 2) {
      for (const art of g.articles) {
        if (art.endsWith("'") && lower[0].startsWith(art) && lower[0].length > art.length) {
          return true;
        }
      }
    }
  }
  // generic noun.
  if ((g.nounMatch === 'bare' || g.nounMatch === 'both') &&
      parts.length === 1 && g.genericNouns.has(lower[0])) {
    return true;
  }
  if ((g.nounMatch === 'trailing' || g.nounMatch === 'both') &&
      parts.length >= 2 && g.genericNouns.has(lower[lower.length - 1])) {
    return true;
  }
  // function-word phrase (ru-only; empty set → never fires for es/fr/de).
  if (g.functionWords.size && parts.length >= 2) {
    const hit = lower.some((p) => g.functionWords.has(p.replace(/^[—–-]+|[—–-]+$/g, '')));
    if (hit) return true;
  }
  return false;
}
