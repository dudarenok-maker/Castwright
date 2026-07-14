import { describe, it, expect } from 'vitest';
import {
  stripCjkHonorifics,
  buildCjkHonorificIndex,
  resolveCjkHonorificId,
  isCjkLanguage,
} from './cjk-honorifics.js';

describe('stripCjkHonorifics', () => {
  it('strips trailing Chinese honorifics/titles (zh)', () => {
    expect(stripCjkHonorifics('奥杜万师傅', 'zh')).toBe('奥杜万'); // Master Oduvan
    expect(stripCjkHonorifics('卡斯珀寡妇', 'zh')).toBe('卡斯珀'); // Widow Casper
    expect(stripCjkHonorifics('莱瑟姆神父', 'zh')).toBe('莱瑟姆'); // Father Lessom
    expect(stripCjkHonorifics('王先生', 'zh')).toBe('王');
    expect(stripCjkHonorifics('李夫人', 'zh')).toBe('李');
    expect(stripCjkHonorifics('张大人', 'zh')).toBe('张');
  });

  it('strips leading Chinese role-titles (zh)', () => {
    expect(stripCjkHonorifics('地保玛俐恩', 'zh')).toBe('玛俐恩'); // Constable Maerin
    expect(stripCjkHonorifics('货郎伊沃', 'zh')).toBe('伊沃'); // Ivo the peddler
    expect(stripCjkHonorifics('烧炭人哈特', 'zh')).toBe('哈特'); // Hart the charcoal-burner
  });

  it('does NOT strip single-char familiar prefixes 老/小/阿 (integral name syllables)', () => {
    // These are deliberately excluded from the leading list — 小雀 is a name
    // (Sparrow), not "little 雀"; stripping it would silently mis-remap.
    expect(stripCjkHonorifics('小雀', 'zh')).toBe('小雀');
    expect(stripCjkHonorifics('阿强', 'zh')).toBe('阿强');
    expect(stripCjkHonorifics('老王', 'zh')).toBe('老王');
  });

  it('strips Japanese honorific suffixes (ja)', () => {
    expect(stripCjkHonorifics('田中さん', 'ja')).toBe('田中');
    expect(stripCjkHonorifics('佐藤様', 'ja')).toBe('佐藤');
    expect(stripCjkHonorifics('鈴木先生', 'ja')).toBe('鈴木');
    expect(stripCjkHonorifics('山田君', 'ja')).toBe('山田');
  });

  it('does NOT apply the ja affix list to a zh book (per-language gating)', () => {
    // 君/氏/様/殿 are single-char ja honorifics but common Chinese name chars.
    // In a zh book they must be left intact so a Chinese given name survives.
    expect(stripCjkHonorifics('丽君', 'zh')).toBe('丽君'); // 君 is a zh name char
    expect(stripCjkHonorifics('王氏', 'zh')).toBe('王氏');
  });

  it('does NOT apply the zh affix list to a ja book', () => {
    // A zh leading occupation title must not strip inside a ja book.
    expect(stripCjkHonorifics('地保玛俐恩', 'ja')).toBe('地保玛俐恩');
  });

  it('does not empty a bare title or a title-only string', () => {
    expect(stripCjkHonorifics('师傅', 'zh')).toBe('师傅');
    expect(stripCjkHonorifics('先生', 'zh')).toBe('先生');
    expect(stripCjkHonorifics('地保', 'zh')).toBe('地保');
  });

  it('leaves non-CJK strings untouched', () => {
    expect(stripCjkHonorifics('oduvan', 'zh')).toBe('oduvan');
    expect(stripCjkHonorifics('narrator', 'zh')).toBe('narrator');
    expect(stripCjkHonorifics('Mr Smith', 'zh')).toBe('Mr Smith');
    expect(stripCjkHonorifics('', 'zh')).toBe('');
  });

  it('leaves a full CJK name with no fused title untouched', () => {
    expect(stripCjkHonorifics('佩尔·霍利斯', 'zh')).toBe('佩尔·霍利斯'); // Pel Hollis
    expect(stripCjkHonorifics('蕊恩', 'zh')).toBe('蕊恩'); // Wren
    expect(stripCjkHonorifics('煤落', 'zh')).toBe('煤落'); // Coalfall (the dragon)
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
    const index = buildCjkHonorificIndex(roster, 'zh');
    // Phase-1 attributed to bare "奥杜万"; roster id is the fused "奥杜万" here
    // via name "奥杜万师傅" → unique match.
    expect(resolveCjkHonorificId('奥杜万师傅', index, 'zh')).toBe('奥杜万');
  });

  it('resolves a fused-form orphan to a bare-form roster id', () => {
    const index = buildCjkHonorificIndex([{ id: '玛俐恩', name: '玛俐恩' }], 'zh');
    expect(resolveCjkHonorificId('地保玛俐恩', index, 'zh')).toBe('玛俐恩'); // Constable Maerin → Maerin
  });

  it('returns null for a genuinely-missed speaker (no roster match)', () => {
    const index = buildCjkHonorificIndex(roster, 'zh');
    expect(resolveCjkHonorificId('哈特', index, 'zh')).toBeNull(); // Hart never rostered
    expect(resolveCjkHonorificId('烧炭人哈特', index, 'zh')).toBeNull();
  });

  it('returns null when the stripped form is ambiguous (>1 roster entry)', () => {
    // Two DISTINCT roster people whose title-variants collide on the same core
    // must NOT be merged — never guess.
    const index = buildCjkHonorificIndex(
      [
        { id: 'a', name: '王先生' },
        { id: 'b', name: '王夫人' },
      ],
      'zh',
    );
    expect(resolveCjkHonorificId('王', index, 'zh')).toBeNull();
  });

  it('does NOT over-strip a familiar-prefix orphan into a wrong single match (小雀 → 雀)', () => {
    // The silent WRONG-remap vector the review flagged: if 小 were a leading
    // affix, orphan "小雀" would strip to "雀" and uniquely match a DIFFERENT
    // roster character "雀" — a wrong voice, worse than a demote. 小 is not an
    // affix, so 小雀 stays whole → no match → stays demoted.
    const index = buildCjkHonorificIndex(
      [
        { id: '雀', name: '雀' },
        { id: 'narrator', name: 'Narrator' },
      ],
      'zh',
    );
    expect(resolveCjkHonorificId('小雀', index, 'zh')).toBeNull();
  });

  it('does NOT over-strip a ja-honorific-shaped zh name into a wrong match (丽君 → 丽)', () => {
    // 君 is a ja honorific but a common zh name char. Per-language gating means
    // the ja list never runs on a zh book, so "丽君" does not strip to "丽" and
    // cannot mis-remap to a roster "丽".
    const index = buildCjkHonorificIndex(
      [
        { id: '丽', name: '丽' },
        { id: 'narrator', name: 'Narrator' },
      ],
      'zh',
    );
    expect(resolveCjkHonorificId('丽君', index, 'zh')).toBeNull();
  });

  it('returns null for a latin orphan (no CJK to normalize)', () => {
    const index = buildCjkHonorificIndex(roster, 'zh');
    expect(resolveCjkHonorificId('unknownguy', index, 'zh')).toBeNull();
  });

  it('resolves a Chinese-form orphan to a ROMANIZED roster id via the name field', () => {
    // The server.log scenario: roster id is the latin slug "oduvan" but its
    // name is the Chinese "奥杜万"; a weaker Phase-1 model attributed to the
    // Chinese form "奥杜万" → orphan against the latin id. Resolves via name.
    const index = buildCjkHonorificIndex(
      [
        { id: 'oduvan', name: '奥杜万' },
        { id: 'pell', name: '佩尔' },
      ],
      'zh',
    );
    expect(resolveCjkHonorificId('奥杜万', index, 'zh')).toBe('oduvan');
    expect(resolveCjkHonorificId('佩尔', index, 'zh')).toBe('pell');
    expect(resolveCjkHonorificId('奥杜万师傅', index, 'zh')).toBe('oduvan'); // + honorific
  });

  it('does not remap an id that already equals its own resolved key', () => {
    // orphan literally IS the roster id via a different entry's title — but if
    // the only match is itself, there is nothing to remap.
    const index = buildCjkHonorificIndex([{ id: '奥杜万', name: '奥杜万' }], 'zh');
    expect(resolveCjkHonorificId('奥杜万', index, 'zh')).toBeNull();
  });
});
