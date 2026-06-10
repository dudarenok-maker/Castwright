import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// fe-37 / item 4 — the brand v2 neutral ramp (BRAND_CHANGELOG decision 10 /
// guidelines §5) must be mirrored into styles.css so app + brand share one
// neutral vocabulary. Pins the tokens + their @theme mappings.

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
);

const NEUTRALS: Array<[string, string]> = [
  ['--ink-mute', '#5a534e'],
  ['--line', '#d9cfc7'],
  ['--line-soft', '#eee2da'],
  ['--canvas-mute', '#cfc8c2'],
  ['--peach-ink', '#5a2417'],
];

describe('brand v2 neutral ramp in styles.css', () => {
  it.each(NEUTRALS)('declares %s with the brand value %s in :root', (token, hex) => {
    expect(css).toContain(`${token}: ${hex};`);
  });

  it.each(NEUTRALS)('exposes %s to Tailwind via an @theme --color mapping', (token) => {
    // token '--ink-mute' maps to the Tailwind color var '--color-ink-mute'.
    expect(css).toContain(`--color-${token.slice(2)}: var(${token});`);
  });
});
