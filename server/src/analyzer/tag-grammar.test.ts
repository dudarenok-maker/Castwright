import { describe, it, expect } from 'vitest';
import { grammarFor, tagRegexesFor, tagScanRegexesFor, verbBeatRegexFor, isQuoteBearing } from './tag-grammar.js';
import { DIALOGUE_VERBS } from './dialogue-verbs.js';

describe('grammarFor', () => {
  it('maps en/es/ru and normalises region subtags', () => {
    expect(grammarFor('en')?.orders[0]).toBe('name-verb');
    expect(grammarFor('es-ES')?.orders[0]).toBe('verb-name');
    expect(grammarFor('ru-RU')?.flipStrategy).toBe('adjacent');
  });
  it('returns null for unmapped languages (still gated) and empty input', () => {
    expect(grammarFor('de')).toBeNull();
    expect(grammarFor('fr')).toBeNull();
    expect(grammarFor('')).toBe(grammarFor('en')); // '' normalises to en
  });
});

describe('tagRegexesFor — English is byte-identical to the historical regex', () => {
  it('reproduces makeTagRegex source with no u/g flag', () => {
    const re = tagRegexesFor(grammarFor('en')!)[0];
    expect(re.source).toBe(`\\b([A-Z][A-Za-z’'-]+)\\s+(?:${DIALOGUE_VERBS.join('|')})\\b`);
    expect(re.flags).toBe('');
  });
  it('captures the name before the verb', () => {
    expect(tagRegexesFor(grammarFor('en')!)[0].exec('Behnam noted.')?.[1]).toBe('Behnam');
  });
  it('captures an English name containing a typographic apostrophe (byte-identity guard)', () => {
    // Historical regex class is [A-Za-z''-]; a curly-apostrophe name must capture in full.
    const name = 'D’Artagnan';
    expect(tagRegexesFor(grammarFor('en')!)[0].exec(`${name} said hello`)?.[1]).toBe(name);
  });
});

describe('tagRegexesFor — Spanish (verb-name)', () => {
  const re = () => tagRegexesFor(grammarFor('es')!)[0];
  it('uses the u flag', () => expect(re().flags).toBe('u'));
  it('captures the name after the verb on a quote beat', () => {
    expect(re().exec('«Está bien», dijo Berrin.')?.[1]).toBe('Berrin');
  });
  it('skips a lowercase role noun between verb and name', () => {
    expect(re().exec('—dijo el viejo Berrin.')?.[1]).toBe('Berrin');
  });
  it('does NOT match a real dialogue verb mid-narration (no bare-whitespace anchor)', () => {
    // `dijo` IS in ES_VERBS; here it is reported speech with no quote beat before it,
    // so the anchored pattern must not fire (this is the spec-C regression).
    expect(re().exec('Coalfall dijo que sí.')).toBeNull();
  });
  it('does NOT capture a pronoun', () => {
    expect(re().exec('—dijo él.')).toBeNull();
  });
});

describe('tagRegexesFor — Russian (verb-name)', () => {
  const re = () => tagRegexesFor(grammarFor('ru')!)[0];
  it('captures the name after a gendered verb', () => {
    expect(re().exec('«…», — сказала Рен.')?.[1]).toBe('Рен');
  });
  it('skips a lowercase role noun (— сказал мастер Одуван)', () => {
    expect(re().exec('— сказал мастер Одуван, не поднимая глаз.')?.[1]).toBe('Одуван');
  });
  it('matches an interrupted-quote inline tag', () => {
    expect(re().exec('«Если я залью огонь, — сказал Одуван, — то потеряю сварку».')?.[1]).toBe('Одуван');
  });
  it('does NOT capture a pronoun or a lowercase common noun', () => {
    expect(re().exec('— сказал он.')).toBeNull();
    expect(re().exec('— сказал дракон.')).toBeNull();
  });
});

describe('verbBeatRegexFor', () => {
  it('detects a pronoun-tagged beat (no name) for the flip disqualifier', () => {
    expect(verbBeatRegexFor(grammarFor('ru')!).test('— добавил он.')).toBe(true);
  });
  it('is false for a bare quote fragment', () => {
    expect(verbBeatRegexFor(grammarFor('ru')!).test('«Если я залью огонь,')).toBe(false);
  });
});

describe('isQuoteBearing', () => {
  it('is true for guillemets and a leading em-dash, false for plain narration', () => {
    expect(isQuoteBearing('«Если я залью огонь,')).toBe(true);
    expect(isQuoteBearing('—Está bien')).toBe(true);
    expect(isQuoteBearing('то потеряю сварку».')).toBe(true);
    expect(isQuoteBearing('La viuda asesoró sin piedad.')).toBe(false);
  });
});

describe('tagScanRegexesFor — body-scan flags (R-4)', () => {
  it('returns global+multiline regexes that still capture the name in group 1', () => {
    const res = tagScanRegexesFor(grammarFor('en')!);
    expect(res.length).toBe(1);
    for (const re of res) {
      expect(re.global).toBe(true);
      expect(re.multiline).toBe(true);
    }
    const m = res[0].exec('Wren said hello.');
    expect(m?.[1]).toBe('Wren');
  });
});
