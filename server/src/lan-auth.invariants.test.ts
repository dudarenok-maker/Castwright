import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// app.ts is where middleware is mounted (extracted from index.ts in Task 8)
const appSrc = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
// index.ts holds lifecycle/listen code only
const idxSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

it('never enables trust proxy in app.ts source (early-catch layer; the runtime assert is the real gate)', () => {
  expect(appSrc).not.toMatch(/trust proxy/);
});
it('never enables trust proxy in index.ts source', () => {
  expect(idxSrc).not.toMatch(/trust proxy/);
});
it('mounts requireSameOrigin after requireLanToken in app.ts', () => {
  const csrf = appSrc.indexOf('requireSameOrigin');
  const guard = appSrc.indexOf('requireLanToken');
  expect(guard).toBeGreaterThan(-1);
  expect(csrf).toBeGreaterThan(guard);
});

// M13: exactly three production createDevice( call sites, with these scopes.
// Review-forcing, not correctness-proving: it reads source at RUNTIME so it is
// inert under `vitest --changed`; verify.yml's `server` scope covers server/src/**.
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
/* Every `createDevice(` occurrence outside its definition is a site, whatever its
   arguments look like; the 3rd argument is split at top-level commas so a
   multi-line, nested or non-literal call is still found rather than skipped. */
function collectMintSites(): { file: string; scopeArg: string }[] {
  const root = fileURLToPath(new URL('./', import.meta.url));
  const sites: { file: string; scopeArg: string }[] = [];
  for (const f of walk(root)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?<!function\s)\bcreateDevice\(/g)) {
      const args: string[] = [];
      let depth = 0;
      let cur = '';
      for (let i = m.index + m[0].length; i < src.length; i++) {
        const c = src[i];
        if (depth === 0 && (c === ',' || c === ')')) {
          args.push(cur.trim());
          cur = '';
          if (c === ')') break;
          continue;
        }
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c)) depth--;
        cur += c;
      }
      sites.push({ file: relative(root, f).split('\\').join('/'), scopeArg: args[2] ?? '' });
    }
  }
  return sites.sort((a, b) => (a.file + a.scopeArg).localeCompare(b.file + b.scopeArg));
}
it('has exactly three createDevice( mint sites in production source, with pinned scopes', () => {
  expect(collectMintSites().map((s) => [s.file, s.scopeArg])).toEqual([
    ['routes/devices.ts', "'full'"],
    ['routes/pairing.ts', "'companion'"],
    ['routes/pairing.ts', "'full'"],
  ]);
});
it('passes every createDevice( site a string-literal scope, never one derived at runtime', () => {
  const nonLiteral = collectMintSites().filter((s) => !/^'(full|companion)'$/.test(s.scopeArg));
  expect(nonLiteral).toEqual([]);
});
