import type { LanguageConventions } from '../types.js';

/* Mandarin (Simplified + Traditional): quote-only dialogue, no dash-dialogue
   convention. No inflection to strip (nameStemmer is identity) and CJK has no
   inter-word spacing, so minStemLength stays permissive (1) — the CJK
   tokenizer gap itself is Task 3.5's problem, not this table's. */
export const zh: LanguageConventions = {
  language: 'zh',
  dialogueOpen: null,
  quotePairs: [
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
  ],
  speechVerbStems: ['说', '道', '问', '答', '喊', '叫', '回答', '说道', '问道', '喃喃', '低语'],
  beatVerbStems: ['点头', '笑', '皱眉', '叹'],
  nameStemmer: (t) => t,
  minStemLength: 1,
  pronouns: {
    firstPerson: /我/u,
    male: /他/u,
    female: /她/u,
  },
};
