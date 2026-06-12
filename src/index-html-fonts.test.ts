import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Fast-tier canary for #698. Fonts are self-hosted in public/fonts/ so the
 * page `load` event never waits on an external CDN — that stall flaked the
 * e2e pre-push gate (a slow CDN pushed page.goto past its 60s budget; proven
 * causally in the #698 spike: goto dropped from ~28s to ~1s once the external
 * fonts were gone). This guard fails fast in pre-commit if anyone re-adds an
 * external font <link>. The e2e/self-hosted-fonts.spec.ts is the behavioural
 * counterpart (asserts zero external font *requests* at runtime). */

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('index.html font loading (#698)', () => {
  it('does not reference any external font CDN', () => {
    expect(indexHtml).not.toMatch(/api\.fontshare\.com/);
    expect(indexHtml).not.toMatch(/cdn\.fontshare\.com/);
    expect(indexHtml).not.toMatch(/fonts\.googleapis\.com/);
    expect(indexHtml).not.toMatch(/fonts\.gstatic\.com/);
  });

  it('links the self-hosted stylesheet', () => {
    expect(indexHtml).toMatch(/<link[^>]+href="\/fonts\/fonts\.css"/);
  });
});
