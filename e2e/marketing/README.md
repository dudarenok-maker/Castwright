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
- `viewports` defaults to `['desktop']`.

## Covers

The four covers are copied into the git-ignored `public/marketing-covers/`:

```bash
mkdir -p public/marketing-covers
cp "brand/book-covers/The Drowning Bell - Marin Vale.png"      public/marketing-covers/hollow-tide-1.png
cp "brand/book-covers/Saltgrave - Marin Vale.png"              public/marketing-covers/hollow-tide-2.png
cp "brand/book-covers/The Tidewatcher's Oath - Marin Vale.png" public/marketing-covers/hollow-tide-3.png
cp "brand/test-book/the-coalfall-commission-cover-final.png"   public/marketing-covers/coalfall-commission.png
```

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
