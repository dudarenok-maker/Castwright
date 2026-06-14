/* Marketing capture scene registry. Each row is one screenshot the harness
   produces. Hashes follow the verified router grammar (src/lib/router.ts):
   `#/`, `#/books/:bookId/<view>`, `#/books/:bookId/analysing`, `#/account`,
   `#/voices`. Adding a scene = one row here (see e2e/marketing/README.md). */

export type Viewport = 'desktop' | 'phone' | 'tablet';

export interface Scene {
  /** Output file stem: `<id>.<viewport>.png`. Unique. */
  id: string;
  /** Hash route to navigate to (must start with `#/`). */
  hash: string;
  /** Which viewports to capture. Defaults to ['desktop'] when omitted. */
  viewports?: Viewport[];
  /** Optional selector to await before the shot (ensures the view painted). */
  waitFor?: string;
  /** Optional selector to scrollIntoView({block:'center'}) before the shot, so a
      below-the-fold region (e.g. the continue-listening rail) is framed. */
  scrollTo?: string;
  /** Capture the full scrollable page instead of just the viewport. */
  fullPage?: boolean;
}

export const SCENES: Scene[] = [
  {
    id: 'library-shelf',
    hash: '#/',
    viewports: ['desktop', 'phone', 'tablet'],
    waitFor: '[data-testid="book-cover-hollow-tide-1"]',
  },
  {
    id: 'analysing',
    hash: '#/books/hollow-tide-3/analysing',
    viewports: ['desktop', 'phone', 'tablet'],
    waitFor: 'text=Detecting characters',
  },
  {
    id: 'confirm-cast',
    hash: '#/books/hollow-tide-1/confirm',
    viewports: ['desktop', 'phone', 'tablet'],
  },
  {
    id: 'cast-reuse',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop', 'phone', 'tablet'],
    waitFor: '[data-testid^="cast-row-"]',
  },
  {
    id: 'generating',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop', 'phone', 'tablet'],
  },
  {
    id: 'listen',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop', 'phone', 'tablet'],
    waitFor: '[data-testid="listen-cover-art"]',
  },
  {
    /* Cross-book "Continue listening" rail (fs-15), posed from our manuscripts.
       Scrolled to centre so the rail is the hero with app chrome around it. */
    id: 'continue-listening',
    hash: '#/',
    viewports: ['desktop', 'phone', 'tablet'],
    waitFor: 'section[aria-label="Continue listening"]',
    scrollTo: 'section[aria-label="Continue listening"]',
  },
  {
    /* The honest full front screen — the rail in context below the stats/grid.
       Full-page (desktop only; phone/tablet full-page would be absurdly tall). */
    id: 'library-shelf-full',
    hash: '#/',
    viewports: ['desktop'],
    waitFor: 'section[aria-label="Continue listening"]',
    fullPage: true,
  },
  {
    id: 'account',
    hash: '#/account',
    viewports: ['desktop', 'phone'],
  },
  {
    id: 'profile-drawer',
    hash: '#/books/hollow-tide-2/cast?profile=insp-cray',
    viewports: ['desktop'],
    waitFor: '[data-testid="cast-row-insp-cray"]',
  },
  {
    id: 'voice-library',
    hash: '#/voices',
    viewports: ['desktop'],
  },
  {
    id: 'coalfall-cast',
    hash: '#/books/coalfall-commission/cast',
    viewports: ['desktop'],
    waitFor: '[data-testid="cast-row-wren"]',
  },
  {
    id: 'coalfall-manuscript',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
  },
  {
    /* Series-memory narrative: Wren is called "Sparrow" by Master Oduvan — the
       profile drawer shows the alias ("two names, one voice"). */
    id: 'coalfall-wren-drawer',
    hash: '#/books/coalfall-commission/cast?profile=wren',
    viewports: ['desktop'],
    waitFor: '[data-testid="cast-row-wren"]',
  },
];
