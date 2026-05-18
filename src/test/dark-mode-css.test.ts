/* Regression coverage for the dark-mode token overrides in
   `src/styles.css`. The dark theme repaints a handful of Tailwind
   utilities via `[data-theme='dark']` selectors instead of migrating
   every component over to design tokens; that fan-out makes the file
   the actual contract for "every utility used as a surface has a
   dark counterpart." If a future edit drops one of those overrides
   the bug surfaces as low-contrast text on a near-white pill — the
   exact regression that put the streaming-state ConnPill on
   `bg-white/70` with `text-emerald-700` text on top, which on the
   dark canvas painted light-emerald-on-cream and was unreadable.

   Asserting the rule's text presence is brittler than a computed-
   style check, but jsdom doesn't apply external stylesheets so
   `getComputedStyle()` in Vitest can't catch the bug. Playwright
   visual baselines for `analysing-dark.png` cover the pre-start
   state only — the streaming pill never appears in the screenshot.
   This unit closes the gap until an e2e visual lands for the
   streaming state. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stylesPath = resolve(__dirname, '..', 'styles.css');
const css = readFileSync(stylesPath, 'utf8');

describe('dark-mode CSS overrides (styles.css)', () => {
  it.each([
    /* Each entry is a Tailwind utility that's used in component code
       as a surface (background) or hovered surface. If the dark
       theme doesn't repaint it, light-mode pales (white, near-white,
       pastel pills) bleed through and break the contrast contract
       documented in docs/features/42-dark-mode.md "Contrast
       invariants". */
    { selector: '.bg-white', label: 'solid white surface' },
    { selector: '.bg-white\\/60', label: 'translucent /60 surface' },
    { selector: '.bg-white\\/70', label: 'translucent /70 surface' },
    { selector: '.hover\\:bg-white:hover', label: 'hover solid white' },
    { selector: '.hover\\:bg-white\\/60:hover', label: 'hover /60' },
    { selector: '.hover\\:bg-white\\/70:hover', label: 'hover /70' },
  ])('repaints $label ($selector) under [data-theme=\'dark\']', ({ selector }) => {
    const pattern = new RegExp(
      String.raw`\[data-theme='dark'\][^{]*` +
        selector.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m),
    );
    expect(css).toMatch(pattern);
  });
});
