import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAGLINE, TAGLINE_SHORT, MANIFESTO, TEASER, TEASER_FLAG, DOMAIN, MADE_WITH } from './brand';

const RETIRED_TAGLINE = 'Any book, performed by a full cast — effortlessly. Even in your own voice.';
const BANNED_WORD = 'effortlessly';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('brand constants', () => {
  it('uses the v2 tagline, never the retired one', () => {
    expect(TAGLINE).toBe(
      'Any book, performed by a full cast — kept true, kept yours, book after book.',
    );
    expect(TAGLINE.toLowerCase()).not.toContain(BANNED_WORD);
    expect(TAGLINE).not.toContain('Even in your own voice');
  });

  it('keeps the short form, manifesto, domain and stamp stable', () => {
    expect(TAGLINE_SHORT).toBe('Any book, fully cast.');
    expect(MANIFESTO).toBe('Many voices, one machine.');
    expect(DOMAIN).toBe('castwright.ai');
    expect(MADE_WITH).toBe('Made with Castwright');
  });

  it('exposes the teaser with its mandatory in-development flag', () => {
    expect(TEASER).toContain('Even in your own voice');
    expect(TEASER_FLAG).toBeTruthy();
  });
});

describe('static brand surfaces carry the v2 copy (no TS import possible)', () => {
  it('index.html meta + og description use the new tagline, not the retired one', () => {
    const html = read('index.html');
    expect(html).not.toContain(RETIRED_TAGLINE);
    expect(html.toLowerCase()).not.toContain(`content="${BANNED_WORD}`);
    expect(html).toContain(TAGLINE);
  });

  it('the PWA manifest uses the new tagline, not the retired one', () => {
    const manifest = read('public/manifest.webmanifest');
    expect(manifest).not.toContain(RETIRED_TAGLINE);
    expect(manifest).toContain(TAGLINE);
  });
});
