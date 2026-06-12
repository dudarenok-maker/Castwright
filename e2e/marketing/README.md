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
# Capture the whole set at the desktop viewport → mockups/marketing-screens/
npm run capture:marketing

# One scene only
CAPTURE_SCENE=cast-reuse npm run capture:marketing

# Responsive variants (phone = Pixel 7, tablet = iPad Pro 11)
npx playwright test --config=playwright.marketing.config.ts --project=phone --project=tablet

# Full-page (whole scroll height) instead of the viewport hero — debugging aid
CAPTURE_FULLPAGE=1 CAPTURE_SCENE=library-shelf npm run capture:marketing
```

Output PNGs land in **`mockups/marketing-screens/`** as `<scene-id>.<viewport>.png`
(git-ignored, regenerable).

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

## Known follow-ups

- **`analysing` scene** is deferred (see the commented row in `scenes.ts`): the
  AnalysingView's content is local-state-driven and doesn't auto-start on a cold
  deep-link, so it shows the loading shell. The mock freeze + runner are ready;
  what remains is making the view start analysis under `VITE_DEMO_CAPTURE`.
- **Voice-library side panel** (visible in `cast-reuse`) still shows the default
  mock voices — the voice-library mock isn't behind the capture flag yet.
