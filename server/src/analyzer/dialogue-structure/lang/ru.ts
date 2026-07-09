import type { LanguageConventions } from '../types.js';

/* Russian dash-dialogue: „— speech, — tag. — speech." Case endings are stripped
   so roster names match their inflected forms. Verb stems are lowercase prefixes. */
const CASE_ENDINGS = /(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ам|ям|ой|ей|ом|ем|ов|ев|ы|и|у|ю|а|я|е|о|ь)$/u;

export const ru: LanguageConventions = {
  language: 'ru',
  dialogueOpen: /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu,
  quotePairs: [['«', '»'], ['„', '“'], ['“', '”'], ['"', '"']],
  speechVerbStems: [
    'сказа', 'говор', 'ответ', 'спрос', 'переспрос', 'прошепта', 'шепн', 'шепта', 'крикн', 'крича',
    'воскликн', 'произнес', 'произнос', 'поинтерес', 'пробормота', 'бормота', 'буркн', 'отрез',
    'замети', 'добави', 'продолжи', 'протян', 'оборва', 'согласи', 'возрази', 'предложи', 'попроси',
    'прошипе', 'рявкн', 'отозва', 'откликн', 'подтверди', 'объясни', 'поясни', 'промолви', 'заяви',
    'осведоми', 'уточни', 'отмахн', 'проворча', 'ворча', 'промямли', 'выдохн', 'повтори', 'напомни',
    'поправи', 'перебил', 'вмеша', 'призна', 'усмехн', 'хмыкн', 'фыркн', 'засмея', 'смеял',
  ],
  beatVerbStems: ['кивн', 'улыбн', 'вздохн', 'нахмур', 'помолча', 'пожа', 'покача'],
  nameStemmer: (t) => t.replace(CASE_ENDINGS, ''),
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^\p{L}])я([^\p{L}]|$)/iu,
    male: /(^|[^\p{L}])он([^\p{L}]|$)/iu,
    female: /(^|[^\p{L}])она([^\p{L}]|$)/iu,
  },
};
