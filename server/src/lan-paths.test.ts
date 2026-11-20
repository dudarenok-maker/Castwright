import { describe, it, expect } from 'vitest';
import { collapseHomePath, expandHomePath, textForClient } from './lan-paths.js';

const w = (home: string) => ({ home, platform: 'win32' as const });
const l = (home: string) => ({ home, platform: 'linux' as const });

describe('collapseHomePath (#4446)', () => {
  it('exact home -> ~', () => {
    expect(collapseHomePath('C:\\Users\\ann', w('C:\\Users\\ann'))).toBe('~');
    expect(collapseHomePath('/home/ann', l('/home/ann'))).toBe('~');
  });
  it('child on win32 with backslash', () => {
    expect(collapseHomePath('C:\\Users\\ann\\books', w('C:\\Users\\ann'))).toBe('~\\books');
  });
  it('child with / on win32 keeps original separators', () => {
    expect(collapseHomePath('C:\\Users\\ann/books/x', w('C:\\Users\\ann'))).toBe('~/books/x');
  });
  it('case-insensitive on win32', () => {
    expect(collapseHomePath('c:\\users\\ANN\\books', w('C:\\Users\\ann'))).toBe('~\\books');
  });
  it('case-sensitive on linux', () => {
    expect(collapseHomePath('/home/Ann/books', l('/home/ann'))).toBe('/home/Ann/books');
  });
  it('ann/anna boundary', () => {
    expect(collapseHomePath('C:\\Users\\anna\\x', w('C:\\Users\\ann'))).toBe('C:\\Users\\anna\\x');
    expect(collapseHomePath('/home/anna/x', l('/home/ann'))).toBe('/home/anna/x');
  });
  it('trailing separator on home', () => {
    expect(collapseHomePath('C:\\Users\\ann\\x', w('C:\\Users\\ann\\'))).toBe('~\\x');
    expect(collapseHomePath('/home/ann/x', l('/home/ann/'))).toBe('~/x');
    expect(collapseHomePath('/home/ann', l('/home/ann/'))).toBe('~');
  });
  it('backslash is not a separator on linux', () => {
    expect(collapseHomePath('/home/ann\\x', l('/home/ann'))).toBe('/home/ann\\x');
  });
  it('not under home -> unchanged', () => {
    expect(collapseHomePath('D:\\books', w('C:\\Users\\ann'))).toBe('D:\\books');
    expect(collapseHomePath('/mnt/books', l('/home/ann'))).toBe('/mnt/books');
  });
  it('empty home -> unchanged', () => {
    expect(collapseHomePath('/x/y', l(''))).toBe('/x/y');
  });
});

describe('expandHomePath (#4446)', () => {
  it('~ alone -> home', () => {
    expect(expandHomePath('~', w('C:\\Users\\ann'))).toBe('C:\\Users\\ann');
    expect(expandHomePath('~', l('/home/ann'))).toBe('/home/ann');
  });
  it('~/x on both platforms', () => {
    expect(expandHomePath('~/x', l('/home/ann'))).toBe('/home/ann/x');
    expect(expandHomePath('~/x', w('C:\\Users\\ann'))).toBe('C:\\Users\\ann/x');
  });
  it('~\\x expands on win32 only', () => {
    expect(expandHomePath('~\\x', w('C:\\Users\\ann'))).toBe('C:\\Users\\ann\\x');
    expect(expandHomePath('~\\x', l('/home/ann'))).toBe('~\\x');
  });
  it('~user/x, a~b and absolute paths are unchanged', () => {
    expect(expandHomePath('~user/x', l('/home/ann'))).toBe('~user/x');
    expect(expandHomePath('a~b', l('/home/ann'))).toBe('a~b');
    expect(expandHomePath('D:\\books', w('C:\\Users\\ann'))).toBe('D:\\books');
    expect(expandHomePath('/mnt/books', l('/home/ann'))).toBe('/mnt/books');
  });
  it('empty home -> unchanged', () => {
    expect(expandHomePath('~/x', l(''))).toBe('~/x');
  });
  it('round-trips collapseHomePath for under-home paths on both platforms', () => {
    const wp = 'C:\\Users\\ann\\Audiobooks\\Lib';
    expect(expandHomePath(collapseHomePath(wp, w('C:\\Users\\ann')), w('C:\\Users\\ann'))).toBe(wp);
    const lp = '/home/ann/Audiobooks/Lib';
    expect(expandHomePath(collapseHomePath(lp, l('/home/ann')), l('/home/ann'))).toBe(lp);
  });
});

describe('separator-insensitive home matching (#4446 review)', () => {
  const lan = { ip: '192.168.1.50', socket: { remoteAddress: '192.168.1.50' }, headers: {} } as any;
  const wh = 'C:\\Users\\dudar';

  it('collapseHomePath matches forward-slash and doubled-backslash spellings on win32', () => {
    expect(collapseHomePath('C:/Users/dudar/Sync', w(wh))).toBe('~/Sync');
    expect(collapseHomePath('C:\\\\Users\\\\dudar\\\\venv', w(wh))).toBe('~\\\\venv');
    expect(collapseHomePath('c:/users/DUDAR', w(wh))).toBe('~');
  });
  it('collapseHomePath keeps the ann/anna boundary across spellings', () => {
    expect(collapseHomePath('C:/Users/dudara/x', w(wh))).toBe('C:/Users/dudara/x');
    expect(collapseHomePath('C:\\\\Users\\\\dudara\\\\x', w(wh))).toBe('C:\\\\Users\\\\dudara\\\\x');
  });
  it('collapseHomePath on linux tolerates repeated / but not backslash', () => {
    expect(collapseHomePath('/home//ann/x', l('/home/ann'))).toBe('~/x');
    expect(collapseHomePath('\\home\\ann\\x', l('/home/ann'))).toBe('\\home\\ann\\x');
  });
  it('textForClient collapses Python repr (doubled backslash) and forward-slash text', () => {
    const o = { home: wh, platform: 'win32' as const };
    expect(textForClient(lan, "No such file or directory: 'C:\\\\Users\\\\dudar\\\\venv'", o))
      .toBe("No such file or directory: '~\\\\venv'");
    expect(textForClient(lan, 'FileNotFoundError: C:/Users/dudar/x.wav', o)).toBe('FileNotFoundError: ~/x.wav');
    expect(textForClient(lan, 'plain C:\\Users\\dudar\\x', o)).toBe('plain ~\\x');
    expect(textForClient(lan, 'C:\\Users\\dudara\\x', o)).toBe('C:\\Users\\dudara\\x');
  });
  it('textForClient on linux does not treat backslash as a separator', () => {
    const o = { home: '/home/ann', platform: 'linux' as const };
    expect(textForClient(lan, 'open /home/ann/x and /home//ann/y', o)).toBe('open ~/x and ~/y');
    expect(textForClient(lan, '/home\\ann/x', o)).toBe('/home\\ann/x');
  });
  it('textForClient leaves a sibling that merely shares the home prefix (win32)', () => {
    const o = { home: 'C:\\Users\\ann', platform: 'win32' as const };
    for (const sib of ['C:\\Users\\ann-x\\foo', 'C:\\Users\\ann.old\\foo', 'C:\\Users\\ann_x', 'C:\\Users\\ann+x']) {
      expect(textForClient(lan, `open ${sib}`, o)).toBe(`open ${sib}`);
      expect(collapseHomePath(sib, w(o.home))).toBe(sib);
    }
  });
  it('textForClient collapses home before whitespace, quotes, closers and punctuation', () => {
    const o = { home: 'C:\\Users\\ann', platform: 'win32' as const };
    for (const [tail, out] of [
      [' is missing', '~ is missing'],
      ["'", "~'"],
      ['"', '~"'],
      ['`', '~`'],
      [')', '~)'],
      [']', '~]'],
      ['}', '~}'],
      [':', '~:'],
      [',', '~,'],
      [';', '~;'],
      ['\\', '~\\'],
      ['/', '~/'],
      ['', '~'],
    ]) {
      expect(textForClient(lan, `in C:\\Users\\ann${tail}`, o)).toBe(`in ${out}`);
    }
  });
  it('textForClient on linux leaves a sibling and a backslash-continued name', () => {
    const o = { home: '/home/ann', platform: 'linux' as const };
    expect(textForClient(lan, 'see /home/ann-x/foo and /home/ann.old/foo', o))
      .toBe('see /home/ann-x/foo and /home/ann.old/foo');
    expect(textForClient(lan, '/home/ann\\x', o)).toBe('/home/ann\\x');
    expect(textForClient(lan, "'/home/ann'", o)).toBe("'~'");
  });
  it('collapses the 8.3 short spelling of a long home segment (win32)', () => {
    const home = 'C:\\Users\\Michael Dudarenok';
    expect(collapseHomePath('C:\\Users\\MICHAE~1\\AppData\\Local\\Temp\\OllamaSetup.exe', w(home)))
      .toBe('~\\AppData\\Local\\Temp\\OllamaSetup.exe');
    expect(textForClient(lan, "'C:\\\\Users\\\\MICHAE~1\\\\x'", { home, platform: 'win32' })).toBe("'~\\\\x'");
    // a different user whose short name has another prefix is untouched
    expect(collapseHomePath('C:\\Users\\SOMEON~1\\x', w(home))).toBe('C:\\Users\\SOMEON~1\\x');
    // short names are only recognised for segments that need one
    expect(collapseHomePath('C:\\Users\\DUDAR~1\\x', w(wh))).toBe('C:\\Users\\DUDAR~1\\x');
  });
});
