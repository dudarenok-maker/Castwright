import type { LanguageConventions } from '../types.js';

export const en: LanguageConventions = {
  language: 'en',
  dialogueOpen: null, // English opens with quotes, not paragraph dashes
  quotePairs: [
    ['“', '”'],
    ['"', '"'],
    ['‘', '’'],
  ],
  speechVerbStems: [
    'said', 'say', 'ask', 'repli', 'whisper', 'shout', 'mutter', 'murmur', 'call', 'answer',
    'snap', 'sigh', 'groan', 'growl', 'hiss', 'yell', 'cried', 'cry', 'added', 'add', 'agree',
    'insist', 'demand', 'wonder', 'continu', 'interrupt', 'observ', 'remark', 'promis', 'warn',
  ],
  beatVerbStems: ['nod', 'smil', 'shrug', 'frown', 'laugh', 'grin'],
  nameStemmer: (t) => t.replace(/'s$/u, '').replace(/'$/u, ''),
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^a-z])i([^a-z]|$)/iu,
    male: /(^|[^a-z])he([^a-z]|$)/iu,
    female: /(^|[^a-z])she([^a-z]|$)/iu,
  },
};
