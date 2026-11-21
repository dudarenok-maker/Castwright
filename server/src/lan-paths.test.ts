import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('trailing separator on home is trimmed before joining', () => {
    expect(expandHomePath('~', l('/home/ann/'))).toBe('/home/ann');
    expect(expandHomePath('~/x', l('/home/ann/'))).toBe('/home/ann/x');
    expect(expandHomePath('~', w('C:\\Users\\ann\\'))).toBe('C:\\Users\\ann');
    expect(expandHomePath('~\\x', w('C:\\Users\\ann\\'))).toBe('C:\\Users\\ann\\x');
    expect(expandHomePath('~/x', w('C:\\Users\\ann\\/'))).toBe('C:\\Users\\ann/x');
    expect(expandHomePath('~/x', l('/home/ann\\'))).toBe('/home/ann\\/x');
    expect(expandHomePath('~', l('/'))).toBe('/');
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
  it('textForClient collapses home before sentence-ending punctuation and keeps it', () => {
    const o = { home: 'C:\\Users\\ann', platform: 'win32' as const };
    for (const [tail, out] of [
      ['.', '~.'],
      ['...', '~...'],
      ['!', '~!'],
      ['?', '~?'],
      ['?!', '~?!'],
      ['. Next', '~. Next'],
      ['.)', '~.)'],
      ['."', '~."'],
      ['.,', '~.,'],
      ['.\nnext', '~.\nnext'],
    ]) {
      expect(textForClient(lan, `failed in C:\\Users\\ann${tail}`, o)).toBe(`failed in ${out}`);
    }
    const l = { home: '/home/ann', platform: 'linux' as const };
    expect(textForClient(lan, 'failed in /home/ann.', l)).toBe('failed in ~.');
  });
  it('textForClient still leaves a sibling when the dot is followed by a name character', () => {
    const o = { home: 'C:\\Users\\ann', platform: 'win32' as const };
    for (const sib of ['C:\\Users\\ann.old', 'C:\\Users\\ann.old\\x', 'C:\\Users\\ann!x', 'C:\\Users\\ann-x', 'C:\\Users\\ann_x', 'C:\\Users\\ann+x']) {
      expect(textForClient(lan, `open ${sib}`, o)).toBe(`open ${sib}`);
    }
  });
  it('textForClient on linux leaves a sibling and a backslash-continued name', () => {
    const o = { home: '/home/ann', platform: 'linux' as const };
    expect(textForClient(lan, 'see /home/ann-x/foo and /home/ann.old/foo', o))
      .toBe('see /home/ann-x/foo and /home/ann.old/foo');
    expect(textForClient(lan, '/home/ann\\x', o)).toBe('/home/ann\\x');
    expect(textForClient(lan, "'/home/ann'", o)).toBe("'~'");
  });
  /* Real `dir /x` pairs; the resolver stands in for the filesystem so every shape is
     deterministic on any OS (the win32-only test below uses the real one). A prefix not
     in the table resolves to itself, like a path that does not exist. */
  const fakeFs = (table: Record<string, string>) => {
    const key = (p: string) => p.split(/[\\/]+/).join('\\').toLowerCase();
    const map = new Map(Object.entries(table).map(([k, v]) => [key(k), v]));
    /* like the real resolver, the longest prefix in the table is rewritten and the rest kept */
    return (p: string) => {
      const parts = p.split(/[\\/]+/);
      for (let n = parts.length; n > 0; n--) {
        const hit = map.get(key(parts.slice(0, n).join('\\')));
        if (hit !== undefined) return [hit, ...parts.slice(n)].join('\\');
      }
      return p;
    };
  };
  describe('8.3 short spelling of a home segment (win32)', () => {
    const at = (home: string, hint: string, table: Record<string, string>) => ({
      home,
      platform: 'win32' as const,
      shortPaths: [hint],
      resolve: fakeFs(table),
    });
    const temp = '\\AppData\\Local\\Temp';
    const real: [string, string][] = [
      ['Michael Dudarenok', 'MICHAE~1'],
      ['firstname.lastname', 'FIRSTN~1.LAS'],
      ['firstname.lastname', 'FI8B6D~1.LAS'],
      ['john.q.smith', 'JOHNQ~1.SMI'],
      ['mary-jane.watson', 'MARY-J~1.WAT'],
      ['jo.smith', 'JO1CC0~1.SMI'],
      ['Zoë.Smith', 'ZO5721~1.SMI'],
      ['josé', 'JOS~1'],
      ['Müller', 'MLLER~1'],
      ['André', 'ANDR~1'],
      ['Søren', 'SREN~1'],
      ['François', 'FRANOI~1'],
      ['José García', 'JOSGAR~1'],
      ['Björn Ek', 'BJRNEK~1'],
      ['Ana Núñez', 'ANANEZ~1'],
      ['renée.dupont', 'RENE~1.DUP'],
      ['j.smith', 'JCA64~1.SMI'],
      ['x.abcd', 'X8B92~1.ABC'],
      ['ab.cdefgh', 'ABA3E4~1.CDE'],
    ];
    it.each(real)('collapses the real alias of %s (%s) in both helpers', (long, short) => {
      const home = `C:\\Users\\${long}`;
      const o = at(home, `C:\\Users\\${short}${temp}`, { [`C:\\Users\\${short}`]: home });
      expect(collapseHomePath(`C:\\Users\\${short}${temp}\\OllamaSetup.exe`, o)).toBe(`~${temp}\\OllamaSetup.exe`);
      expect(collapseHomePath(`c:/users/${short.toLowerCase()}/x`, o)).toBe('~/x');
      expect(textForClient(lan, `[WinError 5] Access is denied: 'C:\\\\Users\\\\${short}\\\\x'`, o))
        .toBe("[WinError 5] Access is denied: '~\\\\x'");
    });
    it('never collapses a sibling or the alias without its extension', () => {
      const home = 'C:\\Users\\john.smith';
      const o = at(home, `C:\\Users\\JOHN~1.SMI${temp}`, { 'C:\\Users\\JOHN~1.SMI': home });
      expect(collapseHomePath('C:\\Users\\JOHN~2.SMI\\x', o)).toBe('C:\\Users\\JOHN~2.SMI\\x');
      expect(collapseHomePath('C:\\Users\\JOHN~1\\x', o)).toBe('C:\\Users\\JOHN~1\\x');
      expect(textForClient(lan, 'open C:\\Users\\JOHN~2.SMI\\x', o)).toBe('open C:\\Users\\JOHN~2.SMI\\x');
    });
    it('collapses no short form when no alias resolves to home', () => {
      const home = 'C:\\Users\\Michael Dudarenok';
      const x = 'C:\\Users\\MICHAE~1\\x';
      const cases: Record<string, string>[] = [{}, { 'C:\\Users\\MICHAE~1': 'C:\\Users\\Someone Else' }];
      for (const table of cases) {
        expect(collapseHomePath(x, at(home, `C:\\Users\\MICHAE~1${temp}`, table))).toBe(x);
      }
      for (const hint of ['C:\\Users\\Michael Dudarenok\\Temp', 'D:\\Temp', 'C:\\Users']) {
        expect(collapseHomePath(x, at(home, hint, { 'C:\\Users\\MICHAE~1': home }))).toBe(x);
      }
    });
    it('never throws when the resolver does', () => {
      const o = {
        home: 'C:\\Users\\Müller',
        platform: 'win32' as const,
        shortPaths: ['C:\\Users\\MLLER~1\\Temp'],
        resolve: () => {
          throw new Error('EPERM');
        },
      };
      expect(collapseHomePath('C:\\Users\\MLLER~1\\x', o)).toBe('C:\\Users\\MLLER~1\\x');
      expect(collapseHomePath('C:\\Users\\Müller\\x', o)).toBe('~\\x');
    });
    it('resolves a hint whose tail does not exist through its existing prefix', () => {
      const home = process.cwd();
      const o = { home, platform: 'win32' as const, shortPaths: [`${home}\\no-such-dir\\Temp`] };
      expect(collapseHomePath(`${home}\\x`, o)).toBe('~\\x');
    });
    describe('a relocated profile (the alias is checked against the RESOLVED home)', () => {
      const realHome = 'D:\\Profiles\\Michael Dudarenok';
      it('collapses the alias when C:\\Users is a junction to another folder', () => {
        const home = 'C:\\Users\\Michael Dudarenok';
        const o = at(home, `C:\\Users\\MICHAE~1${temp}`, { [home]: realHome, 'C:\\Users\\MICHAE~1': realHome });
        expect(collapseHomePath(`C:\\Users\\MICHAE~1${temp}\\OllamaSetup.exe`, o)).toBe(`~${temp}\\OllamaSetup.exe`);
        expect(collapseHomePath(`${realHome}\\x`, o)).toBe('~\\x');
        expect(collapseHomePath('C:\\Users\\MICHAE~2\\x', o)).toBe('C:\\Users\\MICHAE~2\\x');
      });
      it('collapses the alias when the profile folder is itself a junction', () => {
        const home = 'C:\\Users\\Michael Dudarenok';
        const o = at(home, `C:\\Users\\MICHAE~1${temp}`, { [home]: 'D:\\Mike', 'C:\\Users\\MICHAE~1': 'D:\\Mike' });
        expect(collapseHomePath('C:\\Users\\MICHAE~1\\x', o)).toBe('~\\x');
        expect(collapseHomePath('C:\\Users\\MICHAE~2\\x', o)).toBe('C:\\Users\\MICHAE~2\\x');
      });
      it('collapses the alias when home itself is spelled with an 8.3 ancestor', () => {
        const home = 'C:\\LONGPA~1\\José García';
        const longReal = 'C:\\LongPathDir\\José García';
        const o = at(home, `C:\\LONGPA~1\\JOSGAR~1${temp}`, { [home]: longReal, 'C:\\LONGPA~1\\JOSGAR~1': longReal });
        expect(collapseHomePath('C:\\LONGPA~1\\JOSGAR~1\\x', o)).toBe('~\\x');
        expect(collapseHomePath('C:\\LONGPA~1\\José García\\x', o)).toBe('~\\x');
        expect(collapseHomePath(`${longReal}\\x`, o)).toBe('~\\x');
      });
      it.each([
        ['shallower', 'D:\\Michael Dudarenok', 'D:\\MICHAE~1', 'D:\\MICHAE~2'],
        ['deeper', 'D:\\a\\b\\Michael Dudarenok', 'D:\\a\\b\\MICHAE~1', 'D:\\a\\b\\MICHAE~2'],
      ])('collapses the alias when the junction target is %s than C:\\Users', (_n, rHome, alias, sibling) => {
        const home = 'C:\\Users\\Michael Dudarenok';
        const hint = `${alias}${temp}`;
        const o = at(home, hint, { [home]: rHome, [alias]: rHome });
        expect(collapseHomePath(`${alias}${temp}\\OllamaSetup.exe`, o)).toBe(`~${temp}\\OllamaSetup.exe`);
        expect(collapseHomePath(`${rHome}\\x`, o)).toBe('~\\x');
        expect(collapseHomePath(`${sibling}\\x`, o)).toBe(`${sibling}\\x`);
        expect(collapseHomePath(`${alias}0\\x`, o)).toBe(`${alias}0\\x`);
      });
      it('does not mix spellings: a junction elsewhere into home never collapses a lookalike', () => {
        const home = 'C:\\DD\\Users\\mike';
        const o = at(home, `C:\\DD\\J\\link${temp}`, { [home]: 'E:\\real\\mike', 'C:\\DD\\J\\link': 'E:\\real\\mike' });
        expect(collapseHomePath('C:\\DD\\J\\link\\secret.txt', o)).toBe('~\\secret.txt');
        expect(collapseHomePath('C:\\DD\\Users\\link\\secret.txt', o)).toBe('C:\\DD\\Users\\link\\secret.txt');
        expect(collapseHomePath('C:\\DD\\J\\mike\\secret.txt', o)).toBe('C:\\DD\\J\\mike\\secret.txt');
      });
    });
    it.skipIf(process.platform !== 'win32')('matches the alias the OS itself assigns to a non-ASCII profile', (ctx) => {
      const parent = mkdtempSync(join(tmpdir(), 'lanp-'));
      try {
        const home = join(parent, 'José García');
        mkdirSync(home);
        // `/u` = UTF-16 output, so the non-ASCII name survives the OEM code page
        const dir = execFileSync('cmd', ['/u', '/c', 'dir', '/x', '/ad', parent], { encoding: 'utf16le', windowsHide: true });
        const m = /(\S+~\d+\S*)\s+José García/i.exec(dir);
        if (!m) return ctx.skip('8.3 name generation is disabled on this volume');
        const o = { home, platform: 'win32' as const, shortPaths: [join(parent, m[1], 'Temp')] };
        expect(collapseHomePath(join(parent, m[1], 'x'), o)).toBe('~\\x');
        expect(collapseHomePath(`${join(parent, m[1])}0\\x`, o)).not.toMatch(/^~/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });
});
