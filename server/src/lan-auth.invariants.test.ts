import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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
