import type { LanguageConventions } from '../types.js';

/* Russian dash-dialogue: „— speech, — tag. — speech." Case endings are stripped
   so roster names match their inflected forms. Verb stems are lowercase prefixes. */
const CASE_ENDINGS = /(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ам|ям|ой|ей|ом|ем|ов|ев|ы|и|у|ю|а|я|е|о|ь)$/u;

export const ru: LanguageConventions = {
  language: 'ru',
  /* #2289 / #2310 — the entity alternatives are RETAINED, not redundant.
     Since #2310 `stripHtml` decodes the full named set, so freshly-parsed body
     text reaches here with a real dash and the `[-–—]` branch does the work.
     But the text that reaches TTS is the stage-2 model's RETURNED sentence
     text, not a re-derivation of the parsed body, and that text is persisted
     in `manuscript-edits.json` and the analysis cache — neither refreshed by a
     re-parse. A model can also echo an entity whatever `stripHtml` did.
     Dropping these alternatives would regress dialogue ATTRIBUTION for
     already-analysed books — strictly worse than the mispronunciation #2310
     fixed. (`state.json` carries no chapter body at all, so that is not the
     reason — see the design spec's Appendix B finding 1.) Same reasoning
     covers the `DASH` constants in dialogue-structure/{parser,legibility}.ts
     and aligner.ts's 7-char atom. */
  dialogueOpen: /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu,
  quotePairs: [['«', '»'], ['„', '“'], ['“', '”'], ['"', '"']],
  secondaryQuotePairs: [],
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
  addresseePrepositions: ['к'],
  tagClauseConjunctions: ['и', 'но'],
};
