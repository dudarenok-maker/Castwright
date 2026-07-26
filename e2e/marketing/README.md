# Marketing screenshot capture

Deterministic, on-brand screenshots of the Castwright app for marketing, driven
by a fictional **"The Hollow Tide"** series (by *Marin Vale*) plus **The Coalfall
Commission**, posed in mock mode. This is a **tool, not a regression gate** — it
is not part of `npm run verify`.

## Prerequisites

- One-time: `npx playwright install chromium`
- The cover art lives in git-ignored `public/marketing-covers/` (sourced from
  `brand/book-covers/`). If missing, see "Covers" below.

## Commands

```bash
# Capture the whole set at the desktop viewport, light + dark → mockups/marketing-screens/
npm run capture:marketing

# One scene only
CAPTURE_SCENE=cast-reuse npm run capture:marketing

# One theme only (default captures both light + dark)
CAPTURE_THEME=dark npm run capture:marketing

# Responsive variants (phone = Pixel 7, tablet = iPad Pro 11)
npx playwright test --config=playwright.marketing.config.ts --project=phone --project=tablet

# Full-page (whole scroll height) instead of the viewport hero — debugging aid
CAPTURE_FULLPAGE=1 CAPTURE_SCENE=library-shelf npm run capture:marketing
```

Output PNGs land in **`mockups/marketing-screens/`** as
`<scene-id>.<viewport>.<theme>.png` (git-ignored, regenerable). Each scene is
captured in both **light** and **dark** (the app's default "system" theme follows
the emulated `prefers-color-scheme`).

## How it works

- `playwright.marketing.config.ts` runs Vite in **`--mode marketing`**
  (`.env.marketing` → `VITE_USE_MOCKS=true` + `VITE_DEMO_CAPTURE=1`) on port 5175.
- Under `VITE_DEMO_CAPTURE`, the mock API layer (`src/lib/api.ts`) serves the
  additive **Hollow Tide** fixtures (`src/mocks/marketing/hollow-tide.ts`) and
  freezes the generating stream to a fixture-posed frame.
- `capture.spec.ts` warms the library (to hydrate `s.library.books`, which several
  views read for the cover), navigates to each scene's hash, waits for content +
  images, and screenshots.

## Adding a scene

Add one row to `scenes.ts`:

```ts
{ id: 'my-scene', hash: '#/books/hollow-tide-1/<view>', viewports: ['desktop'],
  waitFor: '[data-testid="..."]' },
```

- `hash` follows the router grammar (`src/lib/router.ts`): `#/`,
  `#/books/:bookId/<view>`, `#/account`, `#/voices`.
- `waitFor` is an optional content selector (non-fatal) so the shot isn't taken
  on the loading shell.
- `themes` pins a scene to `['dark']` or `['light']`. Only for a surface that
  pins its own colours, so the other theme would render the same bytes and its
  file would be a pure duplicate (see `series-cast-card-export`). It intersects
  with `CAPTURE_THEME` rather than overriding it, so a scene never writes a
  theme it disowns. Don't reach for it to hide a theme that merely looks
  *worse* — that's a contrast bug in the component, and pinning the capture
  hides it from everyone except the marketing shot (which is exactly how
  #1831 stayed invisible: the card was already failing WCAG AA on the light
  theme for real users while the captures only ever showed dark).
- `viewports` defaults to `['desktop']`.

## Export scenes (capturing what the app *produces*, not what it shows)

Most scenes screenshot the page. A scene with a **`downloadAction`** instead
presses an in-app export button and keeps the file the browser downloads — so
the output PNG is the real user-facing artefact, byte for byte, rather than the
harness's own re-render of the same pixels.

```ts
{ id: 'series-cast-card-export', hash: '#/', themes: ['dark'],
  waitFor: '[data-testid="series-memory-chip"]',
  action: async (page) => { /* …open the modal… */ },
  waitForAfterAction: '[data-testid="series-share-card"]',
  downloadAction: async (page) =>
    page.getByRole('button', { name: /download image \(\.png\)/i }).click(),
  strict: true },
```

Two ordering rules matter:

- **`action` reaches the export affordance; `downloadAction` presses it.**
  `action` runs once, before the theme loop; `downloadAction` runs *inside* it,
  because an exported card bakes the active theme's tokens into the file, so the
  click has to happen after `emulateMedia`.
- **Export scenes never degrade to a screenshot.** A fallback would write a
  plausible-looking PNG of the wrong thing (the modal, chrome and all) under the
  export's filename — worse than a red run.

Export scenes are marked `test.slow()` automatically. `html-to-image` walks the
node, inlines every stylesheet, re-fetches each `url()` under `cacheBust`, then
rasterises; stacked on the cold Vite compile the stock 120s budget already
assumes, that overran the deadline mid-render on a cold first run (the button
was still reading "Rendering…") while finishing in ~2s warm.

## Covers

The covers are copied into the git-ignored `public/marketing-covers/`:

```bash
mkdir -p public/marketing-covers
cp "brand/book-covers/The Drowning Bell - Marin Vale.png"      public/marketing-covers/hollow-tide-1.png
cp "brand/book-covers/Saltgrave - Marin Vale.png"              public/marketing-covers/hollow-tide-2.png
cp "brand/book-covers/The Tidewatcher's Oath - Marin Vale.png" public/marketing-covers/hollow-tide-3.png
cp "brand/test-book/the-coalfall-commission-cover-final.png"   public/marketing-covers/coalfall-commission.png
# Localized editions — each has its translated title baked into the art, so a
# book must never borrow a sibling language's cover (see hollow-tide.test.ts's
# "never a sibling edition's" case, which locks a regression where the German
# entry showed the English cover).
cp brand/book-covers/coalfall-commission-de.png                public/marketing-covers/coalfall-commission-de.png
cp brand/book-covers/coalfall-commission-ru.png                public/marketing-covers/coalfall-commission-ru.png
```

The localized masters are extracted from the real per-language renders in the
maintainer's library (`books/Castwright/Standalones/<translated title>/.audiobook/cover.jpg`,
2048×2048); a copy of each lives in
`brand/go-to-market/launch-post-images/marketing-site/book/coalfall-cover-<lang>.jpg`
so they don't have to be dug out of the library again. `es`/`fr` masters exist there
too; `ja`/`zh` have none (those samples ship as Markdown, not EPUB, so there is no
embedded cover).

Grid cards crop the square covers to 16:10; the fixtures set a top-biased
`coverFraming` so titles aren't clipped on the shelf.

## Scenes (v1)

`library-shelf`, `confirm-cast`, `cast-reuse`, `generating`, `listen`,
`account`, `profile-drawer`, `voice-library`. Desktop for all; phone + tablet
variants for the core six.

## Known follow-ups

- **`analysing` scene** is deferred (see the commented row in `scenes.ts`): the
  AnalysingView's content is local-state-driven and doesn't auto-start on a cold
  deep-link, so it shows the loading shell. The mock freeze + runner are ready;
  what remains is making the view start analysis under `VITE_DEMO_CAPTURE`.
