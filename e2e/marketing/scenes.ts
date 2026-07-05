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
  /** Optional selector to await AFTER `action` runs (not before, unlike
      `waitFor` — see the ordering note below). This is how a scene confirms
      its action actually reached its target state (a modal opened, a
      section expanded), since `waitFor` runs before `action` and can only
      ever confirm PRE-action page state. */
  waitForAfterAction?: string;
  /** When true, a `waitFor`/`waitForAfterAction` timeout or `action` throw is
      re-thrown instead of caught — failing this scene's test outright.
      Every scene this repo adds going forward that has an `action` should
      set this and use `waitForAfterAction` (not `waitFor`) to confirm the
      action's target state, so "capture ran green" means the scene actually
      reached that state, not merely that nothing threw. `waitFor` alone is
      only for confirming pre-action page/navigation state (e.g. the page
      loaded before any click happens). Existing/legacy scenes stay
      non-strict. */
  strict?: boolean;
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
  {
    id: 'manuscript-review-script',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByTestId('review-script-chapter').click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="apply-button"]',
    strict: true,
  },
  {
    /* The two-cast-member A/B compare (select exactly 2 rows' checkboxes,
       click "Compare") — NOT the Profile drawer's single-character "Design &
       compare" (that's VoiceCompareModal, the current-vs-proposed flow shown
       on Designing-a-Voice.md instead). Insp. Cray + Dr. Wren, both carried
       into Saltgrave from The Drowning Bell. */
    id: 'cast-ab-compare',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByTestId('cast-row-insp-cray').locator('span').first().click({ timeout: 5000 });
      await page.getByTestId('cast-row-dr-wren').locator('span').first().click({ timeout: 5000 });
      await page.getByRole('button', { name: 'Compare', exact: true }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[aria-label="Compare cast members"]',
    strict: true,
  },
  {
    /* NOTE (Task 8 capture run): every marketing fixture book reachable under
       VITE_DEMO_CAPTURE=1 (hollow-tide-1, hollow-tide-2, coalfall-commission)
       is already fully cast-designed — "Design full cast" renders disabled
       ("Every character already has a voice.") on all three, so this scene
       can't actually be captured without adding a genuinely-undesigned
       character to fixture data, which is out of scope for this task. Left
       here (selectors verified correct against live DOM) for whichever task
       adds that fixture data. */
    id: 'voice-design-scope-picker',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Design full cast' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="design-scope-picker"]',
    strict: true,
  },
  {
    id: 'model-pill-idle',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="model-row-ollama:llama3.1:8b"]',
    scrollTo: '[data-testid="model-row-ollama:llama3.1:8b"]',
    strict: true,
  },
  {
    id: 'listen-share-clip',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: /Share clip of chapter/i }).first().click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="share-clip-modal"]',
    strict: true,
  },
  {
    id: 'export-format-companion',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="companion-app-banner"]',
    scrollTo: '[data-testid="companion-app-banner"]',
    strict: true,
  },
  {
    id: 'mobile-lan-qr',
    hash: '#/admin',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Authorize a device' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="pair-qr-image"]',
    strict: true,
  },
  {
    id: 'mobile-pair-device',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Pair a device with the Castwright Companion' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="pair-device-modal"]',
    strict: true,
  },
  {
    id: 'export-lan-qr',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Export audiobook', exact: true }).first().click({ timeout: 5000 });
      await page.getByTestId('export-tab-download').click({ timeout: 5000 });
    },
    waitForAfterAction: 'img[alt="LAN URL QR code"]',
    strict: true,
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
    action: async (page) => {
      await page.getByRole('button', { name: 'Next low-confidence sentence' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[aria-label="Close inspector"]',
    strict: true,
  },
  {
    id: 'admin',
    hash: '#/admin',
    viewports: ['desktop'],
  },
  {
    id: 'model-manager-installed',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid^="model-row-"]',
    strict: true,
  },
  {
    id: 'model-manager-device',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="device-panel"]',
    scrollTo: '[data-testid="device-panel"]',
    strict: true,
  },
  {
    id: 'model-manager-defaults',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Defaults for new books', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '#cfg-section-model-defaults',
    scrollTo: '#cfg-section-model-defaults',
    strict: true,
  },
  {
    id: 'model-manager-analyzer-split',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Two-model analyzer split (advanced)', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-analyzer-phase1-min-lag"]',
    scrollTo: '[data-testid="account-analyzer-phase1-min-lag"]',
    strict: true,
  },
  {
    id: 'model-manager-voice-engine',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice engine', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-generation-workers"]',
    scrollTo: '[data-testid="account-generation-workers"]',
    strict: true,
  },
  {
    id: 'model-manager-server-config',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Server configuration', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-sidecar-url"]',
    scrollTo: '[data-testid="account-sidecar-url"]',
    strict: true,
  },
  {
    id: 'model-manager-install-ollama',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Install / update analyzer (Ollama)', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-models-card"]',
    scrollTo: '[data-testid="account-models-card"]',
    strict: true,
  },
  {
    id: 'adv-tts-engine',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      // "Voice engine & device" also renders as the accordion section's own
      // header button and (hidden on desktop) as a mobile <option> inside
      // the lg:hidden dropdown — scope to the left-rail <nav
      // aria-label="Settings sections"> so the match is unambiguous.
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice engine & device', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Accelerator profile',
    scrollTo: 'text=Accelerator profile',
    strict: true,
  },
  {
    id: 'adv-analyzer-sampling',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('LLM sampling parameters', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Ollama temperature',
    scrollTo: 'text=Ollama temperature',
    strict: true,
  },
  {
    id: 'adv-analyzer-chunking',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Analyzer chunking & truncation guards', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Stage-2 chunk char budget',
    scrollTo: 'text=Stage-2 chunk char budget',
    strict: true,
  },
  {
    id: 'adv-analyzer-prompts',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Analyzer prompts & skills', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Cast detection prompt',
    scrollTo: 'text=Cast detection prompt',
    strict: true,
  },
  {
    id: 'adv-analyzer-models',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Analyzer models & endpoints', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Analyzer keep-alive',
    scrollTo: 'text=Analyzer keep-alive',
    strict: true,
  },
  {
    id: 'adv-tts-batching',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice batching & throughput', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Qwen batch length bucketing',
    scrollTo: 'text=Qwen batch length bucketing',
    strict: true,
  },
  {
    id: 'adv-qa-gates',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Per-sentence QA gates', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Signal QA max re-records',
    scrollTo: 'text=Signal QA max re-records',
    strict: true,
  },
  {
    id: 'adv-audio-loudness',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Audio loudness targets', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Target LUFS',
    scrollTo: 'text=Target LUFS',
    strict: true,
  },
  {
    id: 'adv-gpu-lifecycle',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('GPU arbitration, memory & lifecycle', { exact: true })
        .click({ timeout: 5000 });
    },
    // Not "GPU concurrency" — this group's own `help` text ("GPU concurrency,
    // VRAM budgets, and sidecar recycling. Footguns live here.") contains that
    // exact phrase too, so `text=GPU concurrency` strict-mode-matches 2
    // elements and silently fails to scroll (caught by the harness's
    // best-effort `.catch()`), landing the shot on whatever section happened
    // to be in view instead. "GPU VRAM token budget" is unique on the page.
    waitForAfterAction: 'text=GPU VRAM token budget',
    scrollTo: 'text=GPU VRAM token budget',
    strict: true,
  },
  {
    id: 'adv-rate-limits',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Gemini rate limits', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Gemma 4 31B RPM',
    scrollTo: 'text=Gemma 4 31B RPM',
    strict: true,
  },
  {
    id: 'adv-lan-access',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('LAN access & device tokens', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Device authorization lifetime',
    scrollTo: 'text=Device authorization lifetime',
    strict: true,
  },
  {
    /* Saltgrave (hollow-tide-2) is mid-generation (7/11 done) — the Regenerate
       action on a finished chapter opens the real per-chapter modal. The
       per-chapter button's accessible name is its aria-label
       ("Regenerate this chapter"), not its visible "Regenerate" text. */
    id: 'regenerate-modal',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Regenerate this chapter' }).first().click({ timeout: 5000 });
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
  {
    /* NOTE (Task 9 capture run): blocked for the same reason as
       voice-design-scope-picker above — every marketing fixture book
       (hollow-tide-1, hollow-tide-2, coalfall-commission) is already fully
       cast-designed, so "Design full cast" renders disabled ("Every
       character already has a voice.") and the click never reaches the
       Confirm/Start-design step, so `design-waveform` never mounts. Left
       here (selectors verified correct against live DOM) for whichever task
       adds a genuinely-undesigned character to fixture data. */
    id: 'voice-design-in-progress',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Design full cast' }).click({ timeout: 5000 });
      await page.getByRole('button', { name: /Confirm|Start design/i }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="design-waveform"]',
    strict: true,
  },
  {
    /* The mock's own load delay (60ms, api.ts mockLoadSidecar/mockLoadAnalyzer)
       resolves well inside the harness's fixed 300ms post-action settle +
       400ms theme settle, so without help the loading pill is always gone by
       the time the screenshot fires. Freeze the page's fake clock right
       before the click so the in-browser setTimeout backing that delay never
       fires — the loading state holds indefinitely for the shot, entirely
       within this scene's own action (no change to the harness or the mock
       needed). */
    id: 'model-pill-loading',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page.clock.install();
      await page.clock.pauseAt(Date.now());
      await page.getByRole('button', { name: 'Load model' }).first().click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Loading…',
    strict: true,
  },
];
