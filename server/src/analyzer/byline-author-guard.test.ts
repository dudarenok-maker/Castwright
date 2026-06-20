import { describe, it, expect } from 'vitest';
import { dropBylineAuthorFromChapter, isFramedAuthorNote } from './byline-author-guard.js';
import type { CharacterOutput } from '../handoff/schemas.js';

function ch(id: string, name: string, role = 'role'): CharacterOutput {
  return { id, name, role, color: 'slot-4' };
}

const ROSTER: CharacterOutput[] = [
  ch('narrator', 'Narrator', 'Third-person observer'),
  ch('sergey-lukyanenko', 'Сергей Лукьяненко', 'Protagonist / Investigator'),
  ch('anton', 'Антон', 'Оперативник'),
  ch('anton-gorodetsky', 'Антон Городецкий', 'Иной'),
];

describe('isFramedAuthorNote', () => {
  it('matches author-note chapter titles (bilingual), not story chapters', () => {
    expect(isFramedAuthorNote("Author's Note")).toBe(true);
    expect(isFramedAuthorNote('Notes from the Author')).toBe(true);
    expect(isFramedAuthorNote('От автора')).toBe(true);
    expect(isFramedAuthorNote('Послесловие автора')).toBe(true);
    expect(isFramedAuthorNote('Chapter 1')).toBe(false);
    expect(isFramedAuthorNote('ПРОЛОГ')).toBe(false);
    expect(isFramedAuthorNote(undefined)).toBe(false);
  });
});

describe('dropBylineAuthorFromChapter', () => {
  it('drops the byline author by name-match (case/inflection-tolerant) from a story chapter', () => {
    const r = dropBylineAuthorFromChapter(ROSTER, { author: 'Сергей Лукьяненко', chapterTitle: 'Chapter 1' });
    expect(r.dropped).toEqual(['Сергей Лукьяненко']);
    expect(r.characters.map((c) => c.id)).toEqual(['narrator', 'anton', 'anton-gorodetsky']);
  });

  it('matches an uppercased byline form too', () => {
    const roster = [ch('a', 'Сергей ЛУКЬЯНЕНКО', 'Protagonist'), ch('anton', 'Антон')];
    const r = dropBylineAuthorFromChapter(roster, { author: 'Сергей Лукьяненко', chapterTitle: 'Глава 2' });
    expect(r.characters.map((c) => c.id)).toEqual(['anton']);
  });

  it('KEEPS the author in a framed author-note chapter (legit case)', () => {
    const r = dropBylineAuthorFromChapter(ROSTER, { author: 'Сергей Лукьяненко', chapterTitle: 'От автора' });
    expect(r.dropped).toEqual([]);
    expect(r.characters).toBe(ROSTER); // referential identity preserved on no-op
  });

  it('never drops narrator and is a no-op when the author is absent or unset', () => {
    expect(dropBylineAuthorFromChapter(ROSTER, { author: '', chapterTitle: 'Chapter 1' }).characters).toBe(ROSTER);
    const noAuthorOnRoster = [ch('narrator', 'Narrator'), ch('anton', 'Антон')];
    const r = dropBylineAuthorFromChapter(noAuthorOnRoster, { author: 'Сергей Лукьяненко', chapterTitle: 'Chapter 1' });
    expect(r.characters).toBe(noAuthorOnRoster);
    expect(r.dropped).toEqual([]);
  });
});
