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
it('has exactly three createDevice( mint sites in production source, with pinned scopes', () => {
  const root = fileURLToPath(new URL('./', import.meta.url));
  const found: [string, string][] = [];
  for (const f of walk(root)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(f, 'utf8');
    // [^,]+ spans newlines (multi-line call); the definition is excluded by the "function " prefix.
    const re = /(?<!function\s)\bcreateDevice\(\s*[^,]+,\s*[^,]+,\s*'(\w+)'/g;
    for (const m of src.matchAll(re)) found.push([relative(root, f).split('\\').join('/'), m[1]]);
  }
  found.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  expect(found).toEqual([
    ['routes/devices.ts', 'full'],
    ['routes/pairing.ts', 'companion'],
    ['routes/pairing.ts', 'full'],
  ]);
});
