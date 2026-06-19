import { describe, it, expect } from 'vitest';
import { stripFrontMatterBoilerplate } from './strip-front-matter.js';

/* The actual Ночной дозор Ch1 head the analyzer saw (abridged but verbatim shapes). */
const NW_HEAD = [
  '_###ICE#BOOK#READER#PROFESSIONAL#HEADER#START###_ AUTHOR: Сергей Лукьяненко TITLE: Ночной дозор CODEPAGE: -3 _###ICE#BOOK#READER#PROFESSIONAL#HEADER#FINISH###_',
  '',
  'НОЧНОЙ ДОЗОР',
  '',
  'Сергей ЛУКЬЯНЕНКО',
  '',
  'http://www.bestlibrary.ru',
  '',
  'Любое коммерческое использование настоящего текста без ведома и прямого согласия владельца авторских прав НЕ ДОПУСКАЕТСЯ. (С) Сергей Лукьяненко',
  '',
  'Данный текст одобрен к распространению как способствующий делу Света. Ночной Дозор.',
  '',
  'ИСТОРИЯ ПЕРВАЯ',
  '',
  'ПРОЛОГ',
  '',
  'Эскалатор полз медленно, натужно. Старая станция, ничего не поделаешь. Зато ветер гулял в бетонной трубе вовсю, трепал волосы.',
].join('\n');

describe('stripFrontMatterBoilerplate', () => {
  it('strips the Night Watch title-page block but keeps headings and prose', () => {
    const out = stripFrontMatterBoilerplate(NW_HEAD, { author: 'Сергей Лукьяненко', title: 'Ночной дозор' });
    // byline + title echo gone
    expect(out).not.toMatch(/Сергей ЛУКЬЯНЕНКО/);
    expect(out).not.toMatch(/НОЧНОЙ ДОЗОР/);
    // reader header / copyright / url / distribution boilerplate gone
    expect(out).not.toMatch(/ICE#BOOK#READER/);
    expect(out).not.toMatch(/AUTHOR:/);
    expect(out).not.toMatch(/bestlibrary\.ru/);
    expect(out).not.toMatch(/коммерческое использование/);
    expect(out).not.toMatch(/одобрен к распространению/);
    // real structural headings + prose preserved
    expect(out).toMatch(/ИСТОРИЯ ПЕРВАЯ/);
    expect(out).toMatch(/ПРОЛОГ/);
    expect(out).toMatch(/Эскалатор полз медленно/);
  });

  it('leaves an author-name mention inside ordinary prose intact (conservative boundary)', () => {
    const body = 'Эскалатор полз медленно, и я вспомнил, что Сергей Лукьяненко однажды написал об этом в длинном абзаце про метро и людей.';
    const out = stripFrontMatterBoilerplate(body, { author: 'Сергей Лукьяненко', title: 'Ночной дозор' });
    expect(out).toBe(body);
  });

  it('is a no-op for an English book with no byline/boilerplate', () => {
    const body = 'The bell tolled twice over Coalfall. Marlow pulled his collar up and stepped into the rain.';
    expect(stripFrontMatterBoilerplate(body, { author: 'Castwright', title: 'The Coalfall Commission' })).toBe(body);
  });

  it('is a no-op when author/title are absent', () => {
    const body = 'НОЧНОЙ ДОЗОР\n\nСергей ЛУКЬЯНЕНКО\n\nЭскалатор полз медленно, и ветер гулял в трубе вовсю, трепал волосы и капюшон.';
    // Without author/title we cannot identify the byline; only global boilerplate would be removed (none here).
    expect(stripFrontMatterBoilerplate(body)).toBe(body);
  });
});
