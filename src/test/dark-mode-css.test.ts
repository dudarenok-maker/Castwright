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
       documented in docs/features/archive/42-dark-mode.md "Contrast
       invariants". */
    { selector: '.bg-white', label: 'solid white surface' },
    { selector: '.bg-white\\/40', label: 'translucent /40 surface (drawer engine tabs)' },
    { selector: '.bg-white\\/60', label: 'translucent /60 surface' },
    { selector: '.bg-white\\/70', label: 'translucent /70 surface' },
    { selector: '.bg-white\\/95', label: 'translucent /95 surface (drawer sticky header)' },
    { selector: '.hover\\:bg-white:hover', label: 'hover solid white' },
    { selector: '.hover\\:bg-white\\/60:hover', label: 'hover /60' },
    { selector: '.hover\\:bg-white\\/70:hover', label: 'hover /70' },
    /* Plan-42 follow-up (2026-05-18): the analysing-view error panel
       and the top-bar Halted pill paint -800/-900 red/rose text on
       pale red/rose fills. Without a dark override they bleed
       dark-on-dark — the exact bug the user hit in the screenshot
       that opened this round. */
    { selector: '.text-rose-800', label: 'rose-800 pill text' },
    { selector: '.text-rose-600', label: 'rose-600 muted text' },
    { selector: '.text-red-800', label: 'red-800 error body text' },
    { selector: '.text-red-900', label: 'red-900 error header text' },
    { selector: '.text-red-600', label: 'red-600 modal-action text' },
    { selector: '.text-red-700\\/70', label: 'red-700 /70 caption text' },
    { selector: '.text-red-800\\/90', label: 'red-800 /90 body text' },
    { selector: '.text-red-900\\/80', label: 'red-900 /80 label text' },
    { selector: '.bg-red-100', label: 'red-100 fill' },
    { selector: '.bg-red-100\\/60', label: 'red-100 /60 fill (details pre)' },
    { selector: '.hover\\:bg-rose-100:hover', label: 'hover rose-100' },
    { selector: '.hover\\:bg-rose-200:hover', label: 'hover rose-200 (Halted pill)' },
    { selector: '.hover\\:bg-red-50:hover', label: 'hover red-50' },
    { selector: '.border-red-200', label: 'red-200 panel border' },
    { selector: '.border-red-300\\/60', label: 'red-300 /60 select border' },
    /* Voice-drift banner palette (cast view, `src/views/cast.tsx:206–228`).
       Uses `bg-amber-50/60` as base + `hover:bg-amber-50` on hover, plus
       `text-amber-700` / `bg-amber-100` / `border-amber-200`. The translucent
       /60 variant and the hover form each need their own selector overrides
       — Tailwind compiles them separately from the bare `.bg-amber-50` rule. */
    { selector: '.bg-amber-50', label: 'amber-50 status fill' },
    { selector: '.bg-amber-50\\/60', label: 'amber-50 /60 (drift banner base)' },
    { selector: '.bg-amber-100', label: 'amber-100 icon bubble' },
    { selector: '.hover\\:bg-amber-50:hover', label: 'amber-50 hover (drift banner)' },
    { selector: '.text-amber-700', label: 'amber-700 status text' },
    { selector: '.border-amber-200', label: 'amber-200 panel border' },
    /* `floating-pill-inverse` is a bespoke utility for the cast-view
       selection bar at `src/views/cast.tsx:439`. The bar wants to read as
       a dark capsule in BOTH modes — using `bg-ink text-canvas` was a
       coincidence that broke under token inversion. The new utility pins
       the colours explicitly per mode. Asserted here so a future deletion
       doesn't silently re-introduce the cream-on-cream invisibility. */
    { selector: '.floating-pill-inverse', label: 'floating pill inverse (selection bar)' },
    /* Generation-view "Done" chapter card tint + companion progress-bar
       shades. `.bg-emerald-50/50` is the outer card wash in
       `src/views/generation.tsx` (stateConfig.done.tint); without the
       override it paints 50% opacity of the near-white `#ecfdf5` over
       the dark canvas → muddy cream wash instead of a green "done" cue.
       The -200/-400/-500 shades are the ChapterProgressBar track/fill
       and the CharStatusBar fullyDone pip — without overrides they hold
       up but read oversaturated next to the new soft card tint. */
    { selector: '.bg-emerald-50\\/50', label: 'emerald-50 /50 (Done chapter card tint)' },
    { selector: '.bg-emerald-200', label: 'emerald-200 (Done progress-bar track)' },
    { selector: '.bg-emerald-400', label: 'emerald-400 (CharStatusBar fullyDone pip)' },
    { selector: '.bg-emerald-500', label: 'emerald-500 (Done progress-bar fill)' },
    /* Install-status banners (`ollama-install.tsx`, `qwen-install.tsx`)
       paint emerald-900 heading + emerald-900/70 version line on the
       emerald-50 fill. Without these the banner read as green-on-green
       on the dark canvas — the original bug this round fixed. The /70
       alpha modifier compiles to its own selector. */
    { selector: '.text-emerald-900', label: 'emerald-900 banner heading text' },
    { selector: '.text-emerald-900\\/70', label: 'emerald-900 /70 banner subtext' },
    /* Cast-view VRAM-eviction banner (`src/views/cast.tsx:401–409`):
       `bg-emerald-50/70` base + `text-emerald-700/60` dismiss button +
       `hover:text-emerald-700`. Each `/N` / hover form compiles to its
       own selector the bare rules don't reach — without these the banner
       painted a cream wash with light-on-light body text and a dark-green
       dismiss control. */
    { selector: '.bg-emerald-50\\/70', label: 'emerald-50 /70 (eviction banner base)' },
    /* Analysing-view PhaseModelChip done/streaming pill
       (`src/components/analysing/phase-model-chip.tsx`): `bg-emerald-100/70`
       fill under `text-emerald-700` model-name text (e.g. "Gemini 3.1 Flash
       Lite"). The bare `.bg-emerald-100` has a dark override but the `/70`
       alpha variant compiles to its own selector that rule can't reach —
       without this the pill painted near-white emerald-100 at 70% alpha over
       the dark canvas, washing the light-green text out to low contrast. */
    { selector: '.bg-emerald-100\\/70', label: 'emerald-100 /70 (phase-model-chip pill)' },
    { selector: '.text-emerald-700\\/60', label: 'emerald-700 /60 (dismiss button)' },
    { selector: '.hover\\:text-emerald-700:hover', label: 'emerald-700 hover (dismiss)' },
    /* Floating reassign picker (CharacterSearchPicker) — `bg-white` alone
       only redirects to #1f1b19, which sat at nearly the same hue as
       --canvas (#14110f) and made the popover read as if it had no
       background over the manuscript view. `.picker-surface` lifts it
       one more elevation step (#2a2520) and strengthens the border. */
    { selector: '.picker-surface', label: 'floating picker surface (reassign popover)' },
  ])('repaints $label ($selector) under [data-theme=\'dark\']', ({ selector }) => {
    const pattern = new RegExp(
      String.raw`\[data-theme='dark'\][^{]*` +
        selector.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m),
    );
    expect(css).toMatch(pattern);
  });
});
