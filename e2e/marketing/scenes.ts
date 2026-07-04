/* Marketing capture scene registry. Each row is one screenshot the harness
   produces. Hashes follow the verified router grammar (src/lib/router.ts):
   `#/`, `#/books/:bookId/<view>`, `#/books/:bookId/analysing`, `#/account`,
   `#/voices`. Adding a scene = one row here (see e2e/marketing/README.md). */
import type { Page } from '@playwright/test';

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
  /** Optional interaction (e.g. open a modal) run after navigation + waitFor,
      before the screenshot. Best-effort — a thrown action is caught and
      logged, never aborts the run, so a selector drift degrades to "scene
      captured pre-interaction" rather than failing the whole capture. */
  action?: (page: Page) => Promise<void>;
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

  /* ── Wiki wave: replace personal-account screenshots with the marketing
     fixtures wiki-wide (docs/wiki/**). No personal display name, no single
     sparse demo book — a real series + a finished standalone. ── */
  {
    id: 'setup-wizard',
    hash: '#/setup',
    viewports: ['desktop'],
  },
  {
    id: 'help-getting-started',
    hash: '#/help',
    viewports: ['desktop'],
    waitFor: 'text=Getting started',
  },
  {
    id: 'upload',
    hash: '#/new',
    viewports: ['desktop'],
  },
  {
    id: 'restructure',
    hash: '#/books/coalfall-commission/restructure',
    viewports: ['desktop'],
  },
  {
    /* Chapter 3 carries a genuine sub-75% confidence sentence (id 26,
       "Run, you fools", 0.65) — the low-confidence navigator and its badge
       render for real here, no fixture needed. */
    id: 'coalfall-manuscript-low-confidence',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
  },
  {
    id: 'admin',
    hash: '#/admin',
    viewports: ['desktop'],
  },
  {
    id: 'model-manager',
    hash: '#/models',
    viewports: ['desktop'],
  },
  {
    id: 'advanced-settings',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByText('Voice engine & device', { exact: true }).click({ timeout: 5000 });
    },
  },
  {
    /* Saltgrave (hollow-tide-2) is mid-generation (7/11 done) — the Regenerate
       action on a finished chapter opens the real per-chapter modal. */
    id: 'regenerate-modal',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Regenerate', exact: true }).first().click({ timeout: 5000 });
    },
  },
  {
    /* Audiobookshelf gets its own dedicated export-modal copy (folder root,
       chaptered-vs-per-chapter choice) — opened from the Drowning Bell
       (finished book) listener-app tile. */
    id: 'export-audiobookshelf',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: /Audiobookshelf/i }).first().click({ timeout: 5000 });
    },
  },
  {
    /* Table view's series-grouping section, with real multi-book series
       (The Hollow Tide, 3 books) instead of a lone standalone. */
    id: 'library-table',
    hash: '#/',
    viewports: ['desktop'],
    waitFor: '[data-testid="book-cover-hollow-tide-1"]',
    action: async (page) => {
      await page.getByRole('button', { name: 'Table', exact: true }).click({ timeout: 5000 });
    },
    fullPage: true,
  },
];
