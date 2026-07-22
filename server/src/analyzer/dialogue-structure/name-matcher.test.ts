import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { en } from './lang/en.js';
import { de } from './lang/de.js';
import { es } from './lang/es.js';
import { fr } from './lang/fr.js';
import { ru as ruConventions } from './lang/ru.js';
import { buildNameIndex, findRosterName, findSubjectName } from './name-matcher.js';

const ru = conventionsFor('ru')!;
const roster = [
  { id: 'anton', name: 'Антон', aliases: ['я'] },
  { id: 'boris-ignatyevich', name: 'Борис Игнатьевич', aliases: ['шеф'] },
  { id: 'olga', name: 'Ольга' },
];

describe('name-matcher (ru)', () => {
  const idx = buildNameIndex(roster, ru);
  it('matches inflected case forms', () => {
    expect(findRosterName('— сказал Антону вслед', idx)).toBe('anton');
    expect(findRosterName('ответила Ольге', idx)).toBe('olga');
  });
  it('matches multi-token names and aliases by any token', () => {
    expect(findRosterName('проворчал Борис Игнатьевич', idx)).toBe('boris-ignatyevich');
    expect(findRosterName('заметил шеф', idx)).toBe('boris-ignatyevich');
  });
  it('does NOT match substrings inside unrelated words', () => {
    // "Антенна" must not hit the "Ант..." stem — token-boundary + full-stem equality only
    expect(findRosterName('антенна на крыше дрожала', idx)).toBeNull();
  });
  it('ignores stems shorter than minStemLength (the "я" alias never text-matches)', () => {
    expect(findRosterName('я не знаю', idx)).toBeNull();
  });

  it('drops a stem shared by two distinct roster ids (ambiguous match)', () => {
    const ambiguousRoster = [
      { id: 'ivan-a', name: 'Иван' },
      { id: 'ivan-b', name: 'Иван' },
    ];
    const ambIdx = buildNameIndex(ambiguousRoster, ru);
    expect(findRosterName('позвал Ивана вслед', ambIdx)).toBeNull();
  });

  it('uses tokenized full-stem equality, not whole-text substring matching', () => {
    const marsRoster = [{ id: 'mars', name: 'Марс' }];
    const marsIdx = buildNameIndex(marsRoster, ru);
    // "марсианина" contains the roster stem "марс" as a literal substring,
    // but its own stem ("марсианин") is not equal to "марс" -- a naive
    // text.includes(stem) regression would wrongly match here.
    expect(findRosterName('он смотрел на марсианина', marsIdx)).toBeNull();
    // Confirm the negative isn't "nothing ever matches": a genuine inflected
    // form of the same name still resolves correctly.
    expect(findRosterName('он позвал Марса', marsIdx)).toBe('mars');
  });
});

describe('name-matcher (ja, CJK substring containment — fs-59 W3, Task 3.5)', () => {
  const ja = conventionsFor('ja')!;
  it('matches a roster name with no inter-word spacing around it (the tokenizer-gap case)', () => {
    const idx = buildNameIndex([{ id: 'tanaka', name: '田中' }], ja);
    expect(findRosterName('と田中は言った', idx)).toBe('tanaka');
  });
  it('prefers the longest matching stem (田中太郎 over 田中)', () => {
    const idx = buildNameIndex(
      [
        { id: 'tanaka', name: '田中' },
        { id: 'tanaka-taro', name: '田中太郎' },
      ],
      ja,
    );
    expect(findRosterName('と田中太郎は言った', idx)).toBe('tanaka-taro');
  });
  it('ignores 1-char roster stems (guard against false-positive substring hits)', () => {
    const idx = buildNameIndex([{ id: 'ta', name: '田' }], ja);
    expect(findRosterName('と田中は言った', idx)).toBeNull();
  });
  it('returns null when no roster stem is contained in the clause', () => {
    const idx = buildNameIndex([{ id: 'tanaka', name: '田中' }], ja);
    expect(findRosterName('と鈴木は言った', idx)).toBeNull();
  });
});

const subjIdx = buildNameIndex(
  [
    { id: 'anton', name: 'Anton' },
    { id: 'boris', name: 'Boris' },
    { id: 'valkyrie', name: 'Valkyrie' },
    { id: 'skulduggery', name: 'Skulduggery' },
  ],
  en,
);
const subj = (t: string) => findSubjectName(t, subjIdx)?.id ?? null;

describe('findSubjectName', () => {
  it('before-verb subject', () => {
    expect(subj('Anton said')).toBe('anton');
    expect(subj('Sanguine said, shaking his head')).toBe(null); // Sanguine not in roster → no name
    expect(subj('Anton said, folding his arms')).toBe('anton');
  });
  it('inverted subject (said X)', () => {
    expect(subj('said Anton')).toBe('anton');
    expect(subj('said Anton to Boris')).toBe('anton'); // addressee Boris ignored
  });
  it('rejects addressee after a preposition → null (pronoun fallthrough)', () => {
    expect(subj('he said to Valkyrie')).toBe(null);
    expect(subj('she shouted at Valkyrie')).toBe(null);
  });
  it('rejects bystander after a conjunction → null', () => {
    expect(subj('a voice said and Valkyrie turned')).toBe(null);
  });
  it('picks the earlier subject when both subject and addressee are named', () => {
    expect(subj('Skulduggery said to Valkyrie')).toBe('skulduggery');
  });
  it('nearest-before-verb resolves a perception frame', () => {
    // "say" is the only verb; nearest name before it is Skulduggery, not Valkyrie
    expect(subj('Valkyrie heard Skulduggery say')).toBe('skulduggery');
  });
  it('does NOT treat `from` as an addressee marker', () => {
    expect(subj('came a shout from Skulduggery')).toBe('skulduggery');
  });
  it('substring is not a verb match', () => {
    // "essay" must not register as the verb "say"; no verb, single name → that name
    expect(subj('Anton essay')).toBe('anton');
  });
});

describe('findSubjectName — other languages', () => {
  const ruIdx = buildNameIndex(
    [{ id: 'anton', name: 'Антон' }, { id: 'valeri', name: 'Валери' }, { id: 'olga', name: 'Ольга' }],
    ruConventions,
  );
  const ruSubj = (t: string) => findSubjectName(t, ruIdx)?.id ?? null;
  it('ru inverted subject accepts (сказал Антон)', () => {
    expect(ruSubj('сказал Антон')).toBe('anton');
    expect(ruSubj('сказала Ольга')).toBe('olga');
  });
  it('ru caseless dative addressee rejected via pronoun-between (сказал он Валери)', () => {
    // no preposition — `он` between verb and Валери marks Валери as the dative addressee
    expect(ruSubj('сказал он Валери')).toBe(null);
  });
  it('ru «к» preposition marks an addressee (mechanism; recognized verb + к + name)', () => {
    // synthetic phrasing to isolate the preposition clause: `к` before the name → reject
    expect(ruSubj('сказал что-то к Антону')).toBe(null);
  });

  const deIdx = buildNameIndex([{ id: 'oduvan', name: 'Oduvan' }, { id: 'maerin', name: 'Maerin' }], de);
  it('de inverted subject with title accepts; `zu` addressee rejected', () => {
    expect(findSubjectName('sagte Meister Oduvan', deIdx)?.id).toBe('oduvan');
    expect(findSubjectName('sagte er zu Maerin', deIdx)).toBeNull();
  });

  const esIdx = buildNameIndex([{ id: 'boris', name: 'Boris' }, { id: 'ana', name: 'Ana' }], es);
  it('es `a` addressee rejected; nearer inverted subject wins', () => {
    expect(findSubjectName('dijo a Ana', esIdx)).toBeNull();
    expect(findSubjectName('dijo Boris a Ana', esIdx)?.id).toBe('boris'); // Boris nearer, Ana is addressee
  });

  const frIdx = buildNameIndex([{ id: 'marie', name: 'Marie' }, { id: 'paul', name: 'Paul' }], fr);
  it('fr `à` addressee rejected; inverted subject accepted', () => {
    expect(findSubjectName('dit à Marie', frIdx)).toBeNull();          // à → addressee
    expect(findSubjectName('dit Paul', frIdx)?.id).toBe('paul');       // inverted subject
  });
});
