import { describe, it, expect } from 'vitest';
import {
  stripCjkHonorifics,
  buildCjkHonorificIndex,
  resolveCjkHonorificId,
  isCjkLanguage,
} from './cjk-honorifics.js';

describe('stripCjkHonorifics', () => {
  it('strips trailing Chinese honorifics/titles', () => {
    expect(stripCjkHonorifics('奥杜万师傅')).toBe('奥杜万'); // Master Oduvan
    expect(stripCjkHonorifics('卡斯珀寡妇')).toBe('卡斯珀'); // Widow Casper
    expect(stripCjkHonorifics('莱瑟姆神父')).toBe('莱瑟姆'); // Father Lessom
    expect(stripCjkHonorifics('王先生')).toBe('王');
    expect(stripCjkHonorifics('李夫人')).toBe('李');
    expect(stripCjkHonorifics('张大人')).toBe('张');
  });

  it('strips leading Chinese role-titles', () => {
    expect(stripCjkHonorifics('地保玛俐恩')).toBe('玛俐恩'); // Constable Maerin
    expect(stripCjkHonorifics('货郎伊沃')).toBe('伊沃'); // Ivo the peddler
    expect(stripCjkHonorifics('烧炭人哈特')).toBe('哈特'); // Hart the charcoal-burner
  });

  it('strips Japanese honorific suffixes', () => {
    expect(stripCjkHonorifics('田中さん')).toBe('田中');
    expect(stripCjkHonorifics('佐藤様')).toBe('佐藤');
    expect(stripCjkHonorifics('鈴木先生')).toBe('鈴木');
  });

  it('does not empty a bare title or a title-only string', () => {
    expect(stripCjkHonorifics('师傅')).toBe('师傅');
    expect(stripCjkHonorifics('先生')).toBe('先生');
    expect(stripCjkHonorifics('地保')).toBe('地保');
  });

  it('leaves non-CJK strings untouched', () => {
    expect(stripCjkHonorifics('oduvan')).toBe('oduvan');
    expect(stripCjkHonorifics('narrator')).toBe('narrator');
    expect(stripCjkHonorifics('Mr Smith')).toBe('Mr Smith');
    expect(stripCjkHonorifics('')).toBe('');
  });

  it('leaves a full CJK name with no fused title untouched', () => {
    expect(stripCjkHonorifics('佩尔·霍利斯')).toBe('佩尔·霍利斯'); // Pel Hollis
    expect(stripCjkHonorifics('蕊恩')).toBe('蕊恩'); // Wren
    expect(stripCjkHonorifics('煤落')).toBe('煤落'); // Coalfall (the dragon)
  });
});

describe('isCjkLanguage', () => {
  it('is true only for zh/ja primary subtags', () => {
    expect(isCjkLanguage('zh')).toBe(true);
    expect(isCjkLanguage('ja')).toBe(true);
    expect(isCjkLanguage('en')).toBe(false);
    expect(isCjkLanguage('de')).toBe(false);
    expect(isCjkLanguage('ru')).toBe(false);
  });
});

describe('resolveCjkHonorificId', () => {
  const roster = [
    { id: '奥杜万', name: '奥杜万师傅' }, // roster carries the fused form
    { id: '玛俐恩', name: '玛俐恩' },
    { id: 'narrator', name: 'Narrator' },
  ];

  it('resolves a bare-form orphan to the fused-form roster id', () => {
    const index = buildCjkHonorificIndex(roster);
    // Phase-1 attributed to bare "奥杜万"; roster id is the fused "奥杜万" here
    // via name "奥杜万师傅" → unique match.
    expect(resolveCjkHonorificId('奥杜万师傅', index)).toBe('奥杜万');
  });

  it('resolves a fused-form orphan to a bare-form roster id', () => {
    const index = buildCjkHonorificIndex([{ id: '玛俐恩', name: '玛俐恩' }]);
    expect(resolveCjkHonorificId('地保玛俐恩', index)).toBe('玛俐恩'); // Constable Maerin → Maerin
  });

  it('returns null for a genuinely-missed speaker (no roster match)', () => {
    const index = buildCjkHonorificIndex(roster);
    expect(resolveCjkHonorificId('哈特', index)).toBeNull(); // Hart never rostered
    expect(resolveCjkHonorificId('烧炭人哈特', index)).toBeNull();
  });

  it('returns null when the stripped form is ambiguous (>1 roster entry)', () => {
    // Two DISTINCT roster people whose title-variants collide on the same core
    // must NOT be merged — never guess.
    const index = buildCjkHonorificIndex([
      { id: 'a', name: '王先生' },
      { id: 'b', name: '王夫人' },
    ]);
    expect(resolveCjkHonorificId('王', index)).toBeNull();
  });

  it('returns null for a latin orphan (no CJK to normalize)', () => {
    const index = buildCjkHonorificIndex(roster);
    expect(resolveCjkHonorificId('unknownguy', index)).toBeNull();
  });

  it('resolves a Chinese-form orphan to a ROMANIZED roster id via the name field', () => {
    // The server.log scenario: roster id is the latin slug "oduvan" but its
    // name is the Chinese "奥杜万"; a weaker Phase-1 model attributed to the
    // Chinese form "奥杜万" → orphan against the latin id. Resolves via name.
    const index = buildCjkHonorificIndex([
      { id: 'oduvan', name: '奥杜万' },
      { id: 'pell', name: '佩尔' },
    ]);
    expect(resolveCjkHonorificId('奥杜万', index)).toBe('oduvan');
    expect(resolveCjkHonorificId('佩尔', index)).toBe('pell');
    expect(resolveCjkHonorificId('奥杜万师傅', index)).toBe('oduvan'); // + honorific
  });

  it('does not remap an id that already equals its own resolved key', () => {
    // orphan literally IS the roster id via a different entry's title — but if
    // the only match is itself, there is nothing to remap.
    const index = buildCjkHonorificIndex([{ id: '奥杜万', name: '奥杜万' }]);
    expect(resolveCjkHonorificId('奥杜万', index)).toBeNull();
  });
});
