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
  /** Optional query string (must start with `?`) prepended before the hash —
      e.g. `?demoWhatsNew=1` for the mock api's URL seams (api.ts reads
      window.location.search, which hash navigation alone can't set). */
  search?: string;
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
  /** Restrict this scene to a subset of themes. Defaults to whatever the
      runner asks for (both light + dark, or `CAPTURE_THEME`). Only for a
      scene whose output is a FIXED-treatment surface, where the second theme
      is not a second look but a worse version of the same one — see the
      series-cast-card-export scene for the motivating case. */
  themes?: ('light' | 'dark')[];
  /** Capture the artefact the app itself EXPORTS, instead of a screenshot of
      the page. When present, the runner triggers this (the in-app export
      click) inside the theme loop and saves the resulting browser download
      as the scene's PNG — so the output is the real user-facing file, byte
      for byte, not the harness's re-render of the same pixels.

      Runs INSIDE the theme loop, unlike `action`, which runs once before it.
      That ordering matters: an exported card bakes the active theme's tokens
      into the file, so the click has to happen after `emulateMedia`. Use
      `action` to reach the export affordance, this to press it. */
  downloadAction?: (page: Page) => Promise<void>;
}

/* fs-1318 Tier D — real Cyrillic text (ported from
   server/src/__fixtures__/the-coalfall-commission.ru.md) fed through the
   Upload view's "Paste text" flow, so the mock's own language-detection
   heuristic (api.ts mockImportManuscript — Cyrillic ratio >= 30% => 'ru')
   drives the confirm-metadata screen's real "Auto-detected Russian —
   verify" chip. See the language-detect-russian scene below for why this
   replaces the brief's original (nonexistent) "Detecting language" phase. */
const RUSSIAN_PASTE_TEXT = `# Заказ Коалфолла

## Глава первая — Стук

Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук.

«Оставь, — сказал мастер Одуван, не поднимая глаз. Семьдесят зим стёрли его голос до гравия и терпения. — Кто бы это ни был, пусть стучит».

«Может, заказчик».

«В такой час это либо пьяный, либо долг. Ни тот ни другой не заплатит больше оттого, что его впустят быстрее».`;

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
    /* RETARGETED (Task 11, fs-1318 Tier D): hollow-tide-4 (The Harborlight
       Ledger) carries the one genuinely-undesigned character (harbor-clerk),
       so "Design full cast" is enabled there — unlike every other marketing
       fixture book (hollow-tide-1/2, coalfall-commission), which are fully
       cast-designed and render the button disabled ("Every character already
       has a voice."). Originally blocked in Task 8's capture run; unblocked
       once hollow-tide-4 landed. */
    id: 'voice-design-scope-picker',
    hash: '#/books/hollow-tide-4/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
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
      // Name-first modal: generate the code so the scene captures the scannable QR, not the naming form.
      await page.getByRole('button', { name: /generate pairing code/i }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="pair-qr-image"]',
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
    /* Pinokio one-click-install hero (castwright.ai v1.12 blog post): the
       first-run setup check in its fully-ready state — every row green, no
       "needs attention" / "Fix setup" anywhere — with the What's-new banner
       (forced on via the mock api's ?demoWhatsNew=1 seam) dating the shot to
       the current release above the clean checklist. Same route as
       'setup-wizard' above; kept as its own scene because the site references
       this exact file stem and the banner is wanted here but not there. */
    id: 'pinokio-install-ready',
    hash: '#/setup',
    search: '?demoWhatsNew=1',
    viewports: ['desktop'],
    waitFor: 'text=Everything’s ready',
    /* No action — waitForAfterAction runs regardless, so under strict this
       enforces the seam-driven banner too, not just the ready checklist. */
    waitForAfterAction: '[data-testid="whats-new-banner"]',
    strict: true,
  },

  /* Wiki wave — guided first-run wizard, one scene per step. The `setup=notready`
     hash seam (mockGetSetupReadiness) forces guided mode (completedAt: null), so
     #/setup renders the linear "Step N of 8" walkthrough instead of the re-entry
     checklist. Each scene pages forward with the always-enabled Next button and
     confirms it landed via `Step N of 8`. Steps (0-indexed): 0 Environment /
     1 ffmpeg / 2 Analysis / 3 Voice / 4 Defaults / 5 Library / 6 LAN access /
     7 Finish. (A "Library" step was inserted at index 5, after Defaults — the
     paging counts below are unaffected since every step they target precedes it.) */
  {
    id: 'setup-environment',
    hash: '#/setup?setup=notready',
    viewports: ['desktop'],
    waitFor: 'text=Step 1 of 8',
    strict: true,
  },
  {
    id: 'setup-analysis',
    hash: '#/setup?setup=notready',
    viewports: ['desktop'],
    waitFor: 'text=Step 1 of 8',
    action: async (page) => {
      for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Next' }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
    waitForAfterAction: 'text=Step 3 of 8',
    strict: true,
  },
  {
    id: 'setup-voice',
    hash: '#/setup?setup=notready',
    viewports: ['desktop'],
    waitFor: 'text=Step 1 of 8',
    action: async (page) => {
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next' }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
    waitForAfterAction: 'text=Step 4 of 8',
    strict: true,
  },
  {
    id: 'setup-defaults',
    hash: '#/setup?setup=notready',
    viewports: ['desktop'],
    waitFor: 'text=Step 1 of 8',
    action: async (page) => {
      for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next' }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
    waitForAfterAction: 'text=Step 5 of 8',
    strict: true,
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
    waitForAfterAction: 'text=Analyzer engine',
    scrollTo: 'text=Analyzer engine',
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
    // The weighted-semaphore knobs (GPU concurrency / VRAM token budget / …)
    // were retired in #1737, so target the surviving unique knob "GPU VRAM
    // reserve cap (MB)" — the only remaining GPU admission knob and unique on
    // the page (the group `help` no longer contains it).
    waitForAfterAction: 'text=GPU VRAM reserve cap',
    scrollTo: 'text=GPU VRAM reserve cap',
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
    id: 'adv-dialogue-attribution',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Dialogue-structure attribution', { exact: true })
        .click({ timeout: 5000 });
      // The nav click smooth-scrolls to this LAST section (settings-
      // accordion.tsx:189, behavior:'smooth'). Both themes are shot from one
      // scroll position, so the animation must fully settle before the first
      // (light) capture — otherwise light freezes mid-scroll while dark, shot
      // ~800ms later, lands correctly. Wait it out here.
      await page.getByText('Structure engine', { exact: true }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(1200);
    },
    // "Structure engine" is the group's first knob and unique on the page
    // (not a substring of the group title "Dialogue-structure attribution").
    waitForAfterAction: 'text=Structure engine',
    scrollTo: 'text=Structure engine',
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
    /* RETARGETED (Task 11, fs-1318 Tier D) — same unblock as
       voice-design-scope-picker above: hollow-tide-4 has the one genuinely
       undesigned character, so "Design full cast" is enabled and picking a
       scope actually starts a design, mounting `design-waveform`.
       Originally blocked in Task 9's capture run.

       ADAPTED second click: the brief's `/Confirm|Start design/i` button
       doesn't exist on this path — DesignScopePicker
       (src/components/design-scope-picker.tsx) has no separate confirm
       step; each scope row (data-testid="scope-bases"/"scope-variants"/
       "scope-both", role="menuitem") starts the design directly on click.
       Harbor Clerk needs only a base voice, so "Base voices" is the live
       (non-"all done") row here.

       ADAPTED again, twice over:
       1) With only 1 character to design, the mock's synth delay resolved
          before the harness's fixed post-action settle even ran — same
          class of problem the existing `model-pill-loading` scene (below)
          solves. Reusing its fix: freeze the fake clock right before the
          triggering click so the in-browser setTimeout backing the mock
          delay never fires, holding the design in flight for the shot.
       2) `design-waveform` (src/components/design-progress.tsx) doesn't
          render on the bulk cast-list row at all — it lives inside
          VoiceEnginePicker, which only mounts inside an OPEN profile
          drawer (confirmed: profile-drawer.test.tsx is the only other
          reference). The bulk "Design full cast" flow instead shows a
          top-bar "Designing · N%" pill + a row-level "Cancel design"
          state, with no waveform of its own. So the actual "design in
          progress" waveform shot needs the drawer open for the character
          currently being designed — open Harbor Clerk's profile (its cast
          row, same `onOpenProfile` used by the 'profile-drawer' scene)
          while the frozen-clock design is still in flight. */
    id: 'voice-design-in-progress',
    hash: '#/books/hollow-tide-4/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Design full cast' }).click({ timeout: 5000 });
      await page.clock.install();
      await page.clock.pauseAt(Date.now());
      await page.getByTestId('scope-bases').click({ timeout: 5000 });
      await page.getByTestId('cast-row-harbor-clerk').click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="design-waveform"]',
    scrollTo: '[data-testid="design-waveform"]',
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
       needed).

       REGRESSED (Task 14 final verification) then FIXED: this scene had no
       `waitFor`, so `action` ran straight after `waitForImages` — fine when
       the inventory row it targets happened to already be in the DOM, but a
       race the moment the initial `GET` (mockGetModelInventory's own 80ms
       delay) is still in flight when `page.clock.install()` + `pauseAt()`
       fire: that freezes the in-page fake clock before the delay's own
       setTimeout resolves, so the page hangs on "Loading model inventory…"
       forever and no "Load model" button ever appears (5s timeout). Added
       the same `waitFor: '[data-testid^="model-row-"]'` guard used by the
       'model-manager-installed' scene above, so the clock only gets frozen
       once the inventory (and its Load buttons) has actually rendered. */
    id: 'model-pill-loading',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid^="model-row-"]',
    action: async (page) => {
      await page.clock.install();
      await page.clock.pauseAt(Date.now());
      await page.getByRole('button', { name: 'Load model' }).first().click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Loading…',
    strict: true,
  },
  {
    /* Mid-drag simulation for the chapter-boundary handle (Task 10, #1318).
       `data-tour-id="chapter-boundary"` is only emitted for the first
       boundary handle (boundaryIdx === 1, src/views/manuscript.tsx:1663) —
       fine here, since the scene just needs *a* boundary to drag, not a
       specific one. Uses raw page.mouse events (not the `action` click
       helpers) so the drag lands mid-gesture: the boundary handler listens
       for PointerEvent (onPointerDown/pointermove/pointerup), but Chromium
       synthesizes real pointer events for mouse input, so page.mouse still
       drives it. Deliberately no mouse.up() — the screenshot must land
       mid-drag, before the gesture resolves. */
    id: 'manuscript-boundary-drag',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
    waitFor: '[data-tour-id="chapter-boundary"]',
    action: async (page) => {
      const handle = page.locator('[data-tour-id="chapter-boundary"]');
      const box = await handle.boundingBox();
      if (!box) throw new Error('boundary handle not found');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 40, { steps: 10 });
      // Deliberately no mouse.up() — the screenshot must land mid-drag.
    },
    strict: true,
  },

  /* ── fs-1318 Tier D — new marketing-only fixture data (Task 11) ── */
  {
    /* hollow-tide-4 is the only marketing book with a genuinely undesigned
       character (harbor-clerk), so it's the one book where "Approve cast &
       start generating" actually opens the voice-readiness gate instead of
       proceeding straight through. */
    id: 'generating-voice-readiness',
    hash: '#/books/hollow-tide-4/manuscript',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Approve cast & start generating' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="voice-readiness-gate"]',
    strict: true,
  },
  {
    id: 'listen-markers-rerecord',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="listen-markers-panel"]',
    scrollTo: '[data-testid="listen-markers-panel"]',
    strict: true,
  },
  {
    /* #1289/#1318 leftover — the per-line re-record flow itself, opened by
       clicking "Fix this line" on the rerecord-kind marker (mk-2, "Mispronounced
       name — needs a re-record" — see the fixture's LISTEN_MARKERS map). Opens
       FixCharacterAudioModal pre-scoped to that chapter/segment. */
    id: 'listen-fix-line-modal',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="listen-marker-fix-mk-2"]',
    action: async (page) => {
      await page.getByTestId('listen-marker-fix-mk-2').click({ timeout: 5000 });
    },
    /* `fix-audio-summary` only renders once the (re-)recording job finishes
       (allFinished) — the wrong target for "the modal just opened" state.
       `fix-audio-backdrop` is the modal's own outer container, present as
       soon as FixCharacterAudioModal mounts. */
    waitForAfterAction: '[data-testid="fix-audio-backdrop"]',
    strict: true,
  },
  {
    id: 'export-queue',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="export-queue-rail"]',
    scrollTo: '[data-testid="export-queue-rail"]',
    strict: true,
  },
  {
    /* fs-52 follow-up — the "Or download a file" tile row (M4B / MP3 ZIP /
       Streaming link / Portable bundle / Captions), captured in context so
       the new Captions tile shows alongside its siblings. Fulfills the
       screenshot docs/wiki/Exporting.md's "Choose a format" section has been
       missing since the format-tile row was first documented text-only.
       5 tiles wrap to a second row under the grid's `lg:grid-cols-4` cap.
       scrollIntoView-ing the Captions tile cropped the first row's titles off
       the top; centering on the section heading instead still cropped
       Captions down to just its header (caught in review — the whole point
       of this scene is showing Captions in full alongside its siblings).
       fullPage instead, same fix as 'chapter-suspect'/'library-table' above. */
    id: 'export-download-tiles',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="download-tile-captions"]',
    fullPage: true,
    strict: true,
  },
  {
    /* fs-52 — the Captions export modal itself: SRT/VTT file format,
       Line/Sentence/Word granularity, and whole-book/per-chapter scope. This
       is the shot that actually shows the feature (the tile row alone just
       shows a label), used for the wiki "Captions" section and the Pinokio
       v1.12.2 post's captions bullet. */
    id: 'export-captions-options',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="download-tile-captions"]',
    action: async (page) => {
      await page
        .getByTestId('download-tile-captions')
        .getByRole('button', { name: 'Download' })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="captions-options"]',
    strict: true,
  },
  {
    /* ADAPTED from the brief's original spec, which targeted
       `#/books/<russian-book-id>/analysing` with `waitFor: 'text=Detecting
       language'`. That text doesn't exist anywhere in the app (checked
       src/data/analysis-phases.ts's 3 phase labels and every string in
       src/views/analysing.tsx — no language-specific phase exists; the
       analysing view's DEMO_CAPTURE pose is a single frozen
       HOLLOW_TIDE_POSED.analysing object, not book-specific). Language
       detection is a confirm-metadata-view concept instead — the real
       "Auto-detected {label} — verify" chip (src/views/confirm-metadata.tsx:303),
       which is exactly what docs/wiki/Multi-language-Support.md already
       describes ("Pasting in the Russian variant ... shows the
       'Auto-detected Russian — verify' chip"). This scene drives that real
       flow: paste real Cyrillic text (RUSSIAN_PASTE_TEXT, above), let the
       mock's own language-detection heuristic classify it, and land on the
       chip it actually renders. */
    id: 'language-detect-russian',
    hash: '#/new',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Paste text' }).click({ timeout: 5000 });
      await page.locator('textarea').fill(RUSSIAN_PASTE_TEXT);
      await page.getByRole('button', { name: 'Upload pasted text' }).click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Auto-detected Russian — verify',
    strict: true,
  },
  {
    /* der-bernsteinturm — new German-language standalone (hollow-tide.ts) —
       non-English cast confirmation, names shown in their own language.
       ADAPTED from the brief's `[data-testid^="cast-row-"]` — that testid
       belongs to src/views/cast.tsx (the post-confirm cast VIEW, used by
       e.g. the 'cast-reuse'/'coalfall-cast' scenes' `#/books/:id/cast`
       hash), not src/views/confirm-cast.tsx (this `#/books/:id/confirm`
       CAST-CONFIRMATION screen, which has no per-row testid at all —
       confirmed against a live capture). Each row's real, unique selector
       is the `aria-label="Open profile for {name}"` button
       (confirm-cast.tsx:419), which also happens to double-confirm the
       row is showing the character's own-language name. */
    id: 'language-cast-confirm-german',
    hash: '#/books/der-bernsteinturm/confirm',
    viewports: ['desktop'],
    waitFor: '[aria-label^="Open profile for"]',
    /* confirm-cast.tsx:80 resolves the shown suggested-voice engine from the
       GLOBAL account default (`engineForModelKey(s.ui.ttsModelKey)`), not
       from the book or character — real behavior, not a fixture bug. Qwen is
       the product's actual default engine now, so force ttsModelKey to a
       Qwen key before the shot rather than letting whatever the marketing
       account's default happens to be (previously Kokoro) show instead —
       bernsteinturmCast's characters already carry a designed
       `overrideTtsVoices.qwen.name`, so switching the engine renders their
       real designed voice ("Qwen · qwen-erzaehlerin · Designed voice")
       instead of a generic Kokoro preset suggestion. */
    action: async (page) => {
      await page.evaluate(() => {
        const s = (
          window as unknown as { __store__?: { dispatch: (a: unknown) => void } }
        ).__store__;
        s?.dispatch({ type: 'ui/setTtsModelKey', payload: 'qwen3-tts-0.6b' });
      });
    },
    /* Must confirm the DESIGNED-voice branch specifically, not just that the
       engine switched to Qwen — confirm-cast.tsx:476 renders the "Qwen · "
       provider-label span unconditionally whenever ttsVoice.provider is
       'qwen', even on the "No voice designed yet" fallback (tts-voice-
       mapping.ts:333), so 'text=Qwen ·' alone would still pass if
       bernsteinturmCast's overrideTtsVoices.qwen.name ever regressed. */
    waitForAfterAction: 'text=Designed voice',
    strict: true,
  },
  {
    id: 'voice-engines-coqui',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="model-row-coqui"]',
    scrollTo: '[data-testid="model-row-coqui"]',
    strict: true,
  },
  {
    id: 'voice-engines-qwen',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="model-row-qwen-base"]',
    scrollTo: '[data-testid="model-row-qwen-base"]',
    strict: true,
  },
  {
    /* fs-1318 Tier F (hardest scene) — the preview + A/B revision diff player.
       ADAPTED from the brief's guess on two counts:

       1. Trigger sequence. The per-CHAPTER "Regenerate this chapter" button
          (RegenerateModal, already captured above as 'regenerate-modal') has
          no preview mode at all. Preview-mode regen is a per-CHARACTER flow:
          open a character's profile drawer → "Regenerate {name}'s lines
          across the book" → CharacterRegenerateModal
          (src/modals/character-regenerate.tsx) → its own "Preview CH## first"
          button (data-testid="regen-character-preview") → onConfirm wiring in
          src/components/layout.tsx:1848-1911 dispatches
          uiActions.setPreviewRegen(...) and enqueues just the first affected
          chapter. This exact flow already has real browser coverage at
          e2e/profile-regen-preview.spec.ts (fe-15/plan-114) — this scene
          mirrors its proven sequence rather than the brief's checkbox guess
          (there is no checkbox; the modal has two distinct submit buttons).

       2. Reaching chapter_complete. Per Step 1 of this task: src/lib/api.ts's
          mockStreamGeneration has a DEMO_CAPTURE-only early return
          (api.ts:1517-1530) that emits ONE static "progress" tick for
          HOLLOW_TIDE_POSED.generating and returns a no-op unsubscribe — NO
          setInterval is ever created in marketing-capture mode ("Task B4
          emits these once, then hangs", per the comment above
          HOLLOW_TIDE_POSED in src/mocks/marketing/hollow-tide.ts). So
          chapter_complete never fires through the real mock stream here at
          all — this rules out both the Tasks 9/11 fake-clock technique
          (nothing to fast-forward; there's no timer) and the real e2e spec's
          `chapters/setChapters` progress-bump trick (nothing ever reads it
          back; no interval ever ticks again). Modifying api.ts/hollow-tide.ts
          is out of scope for this task (scenes.ts + docs only), so this scene
          reaches the exact same end state — the middleware's
          `revisions/markRevisionPlayable` handler,
          generation-stream-middleware.ts:165-183 — via the `window.__store__`
          test hook already wired for e2e (src/main.tsx:56-58; live under
          `--mode marketing` too, since Vite's DEV flag is command-based, not
          mode-based). It dispatches the exact action a real completed tick
          would have dispatched, once the real click flow has genuinely set
          `ui.previewRegen`. The phantom mock revision the 30s per-book poll
          seeds for every book is cleared first (same reason
          profile-regen-preview.spec.ts clears it) so pending[0] is genuinely
          our stub, not a stray one; the profile drawer is also dismissed
          first since its sticky footer overlaps the modal's Preview button
          at this viewport (same fix that real spec uses).

       3. Duration side effect. Code review on this task flagged that
          skipping the tick pipeline entirely also skips
          chapters-slice.ts's `applyGenerationTick` `chapter_complete`
          branch (~line 498), which is what stamps `ch.duration` from
          `ev.durationSec` on a real render. Without it, `chapter.duration`
          is still its seeded '00:00', and build-pending-revision.ts:45-46
          reads that SAME field into both `oldDuration` and `newDuration` —
          so the screenshot would show "00:00" on both A and B cards (both
          fields deriving from one still-unset value, not two
          independently-wrong ones). So this scene dispatches a minimal
          `chapters/applyGenerationTick` `chapter_complete` event (just
          `chapterId` + a realistic `durationSec`) BEFORE
          `revisions/markRevisionPlayable`, mirroring what the real tick
          would have done first. Same "stand in for the tick the dead mock
          stream can't fire" workaround as point 2 above, just for the
          reducer that runs one step earlier in the real pipeline. */
    id: 'generating-revision-diff',
    hash: '#/books/hollow-tide-2/cast?profile=insp-cray',
    viewports: ['desktop'],
    waitFor: '[data-testid="cast-row-insp-cray"]',
    action: async (page) => {
      await page
        .getByRole('button', { name: /Regenerate .*'s lines across the book/i })
        .click({ timeout: 5000 });
      await page.getByTestId('regen-character-preview').waitFor({ state: 'visible', timeout: 5000 });
      await page.evaluate(() => {
        const s = (
          window as unknown as {
            __store__?: { dispatch: (a: unknown) => void };
          }
        ).__store__;
        // Dismiss the (overlapping) profile drawer and clear any phantom
        // pending revision before Preview fires — mirrors
        // e2e/profile-regen-preview.spec.ts's openPreviewPlayer helper.
        s?.dispatch({ type: 'ui/setOpenProfileId', payload: null });
        s?.dispatch({ type: 'revisions/rejectAllPending' });
      });
      await page.getByTestId('regen-character-preview').click({ timeout: 5000 });
      await page.evaluate(() => {
        const s = (
          window as unknown as {
            __store__?: {
              getState: () => { ui: { previewRegen: { previewChapterId: number } | null } };
              dispatch: (a: unknown) => void;
            };
          }
        ).__store__;
        const chapterId = s?.getState().ui.previewRegen?.previewChapterId;
        // Stand in for the chapter_complete tick that would normally arrive
        // via the mock generation stream — dead code in DEMO_CAPTURE mode
        // (see the comment above), so we dispatch what it would have fired.
        if (chapterId != null) {
          // Also stand in for the chapter_complete tick's OWN upstream
          // effect (chapters-slice.ts's applyGenerationTick, which the real
          // stream would have run first) — it stamps `chapter.duration`
          // from `durationSec`, which the revision stub below reads for
          // both its A and B card durations. Skipping this would leave the
          // screenshot showing "00:00" on both cards (see comment above).
          s?.dispatch({
            type: 'chapters/applyGenerationTick',
            payload: { type: 'chapter_complete', chapterId, durationSec: 680 },
          });
          s?.dispatch({ type: 'revisions/markRevisionPlayable', payload: { chapterId } });
        }
      });
    },
    waitForAfterAction: '[data-testid="revision-diff-player"]',
    strict: true,
  },
  {
    /* Quality Gate marketing/wiki screenshot #1286 — Saltgrave chapter 7's
       row expanded, showing the Suspect badge + amber waveform bands + "N
       issues to review" caption. `waitFor` targets the chapter's stable
       `#chapter-<id>` container (chapters-slice.ts/generation.tsx) so the
       click has something real to act on; the action's own waitFor (not a
       fixed delay) waits for "issues to review" text, which only renders
       once ChapterSegmentStrip's async getChapterAudio fetch resolves — and
       doubles as an assertion that both flagged segments produced distinct
       issue regions (the plural "issues", not singular "issue"). */
    id: 'chapter-suspect',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    waitFor: '#chapter-7',
    action: async (page) => {
      await page.locator('#chapter-7').getByRole('button').first().click({ timeout: 5000 });
      await page.waitForSelector('text=issues to review', { timeout: 5000 });
    },
    /* The segment strip (amber bands + caption) renders at the BOTTOM of the
       expanded row, below chapter 7's per-speaker breakdown — well below the
       fold at a fixed viewport since chapters 1-6 sit above it uncollapsed.
       fullPage captures the whole scrollable page instead of scrolling to a
       single target, so both the row header (with the Suspect badge, up top)
       and the expanded caption/waveform (further down) land in the same
       shot — scrollIntoView-ing the caption alone risks pushing the badge
       off the top of a fixed-height viewport frame. */
    fullPage: true,
  },
  {
    /* Drift-report modal — two severity-tiered flags (Severe with Auto-regen,
       Moderate). The drift events arrive via the active-book poll
       (api.pollRevisions, layout.tsx ~line 949, fires immediately on mount
       when the book is `ready`) rather than the background bulk poll, so no
       extra settle beyond the action's own content-aware waits is needed.
       The modal caps itself at max-h-[90vh] with its own internal scroll —
       at the stock 1280x720 desktop viewport only the first (Severe/Cray)
       card fits before the overflow clips it, so Moderate/Wren never makes
       the shot. Grow the viewport height before opening the modal so 90vh
       comfortably exceeds both cards' combined height and nothing scrolls
       out of frame. */
    id: 'voice-drift-report',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    waitFor: '[data-testid^="cast-row-"]',
    action: async (page) => {
      await page.setViewportSize({ width: 1280, height: 1800 });
      await page.waitForSelector('text=Voice drift detected in', { timeout: 5000 });
      await page.getByText(/Voice drift detected in/).click({ timeout: 5000 });
      await page.waitForSelector('[data-testid^="drift-event-"]', { timeout: 5000 });
    },
  },
  {
    /* The "a flag follows you" preview surface — the mini-player's amber
       issue band persists once you hit Preview on the flagged chapter. The
       Preview button lives in the chapter row's always-visible action strip
       (not gated on the row being expanded), so no expand-click is needed
       here — only the click-then-wait-for-content pattern. */
    id: 'preview-flagged',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    waitFor: '#chapter-7',
    action: async (page) => {
      await page
        .locator('#chapter-7')
        .getByRole('button', { name: 'Preview' })
        .click({ timeout: 5000 });
      await page.waitForSelector('[data-testid="mini-player-next-issue"]', { timeout: 5000 });
    },
  },
  {
    /* v1.11 book-level QA receipt (src/components/qa-report-card.tsx),
       shown on the Listen view once a book has rendered. Uses hollow-tide-2
       (Saltgrave) so the receipt's mixed figures agree with the same book's
       existing chapter-suspect/voice-drift-report/preview-flagged scenes
       (Task 3's HOLLOW_TIDE_QA_REPORT reuses HOLLOW_TIDE_DRIFT_EVENTS). No
       `action` needed — the Listen view calls useQaReport(bookId) with the
       route's own bookId (src/views/listen.tsx), the same per-book routing
       every other book-scoped scene in this file already relies on. The card
       sits below the fold, so `scrollTo` (added after Task 6's visual
       verification caught the original scene missing it) brings it into
       frame. */
    id: 'qa-report-card',
    hash: '#/books/hollow-tide-2/listen',
    viewports: ['desktop'],
    waitFor: 'text=Quality gate',
    scrollTo: 'text=Quality gate',
  },
  {
    /* Emotion + delivery-direction story — a single line (Coalfall ch.4,
       sentence 107) carrying both chips filled in: the emotion chip
       (already-existing fixture data) and the new instruct chip (Task 1's
       fixture patch).

       NOT `[data-sentence-id="107"] [data-testid="instruct-chip"]` — the
       chip is rendered as a SIBLING of the `data-sentence-id` span, not a
       descendant (sentence-instruct-control.tsx / manuscript.tsx's own
       comment: chips sit outside the text span deliberately, so they never
       perturb the selection→split offset math). A descendant selector can
       never match. Instead target the chip's own aria-label, which bakes in
       Task 1's exact instruct text — unambiguous regardless of DOM nesting.

       NOT passive-load, unlike most manuscript scenes: chapter 4 has 235
       segments (manuscript.tsx's own `virtualEnabled = segments.length >=
       60`, plan 92), so sentence 107 (segment index 106/235) is unmounted
       until scrolled near — chapter 3, which every other manuscript scene in
       this file uses, has only 57 segments and never crosses that
       threshold, which is why none of them needed this. `waitFor` below only
       confirms the (always-mounted) virtual container exists; `action`
       window-scrolls in a loop until the sentence's span actually mounts,
       then centers it; `waitForAfterAction` (strict) is what actually
       confirms the aria-label resolved. */
    id: 'manuscript-emotion-direction',
    hash: '#/books/coalfall-commission/manuscript?chapter=4',
    viewports: ['desktop'],
    waitFor: '[data-testid="manuscript-virtual-container"]',
    action: async (page) => {
      for (let i = 0; i < 40; i++) {
        if (await page.locator('[data-sentence-id="107"]').count()) break;
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(50);
      }
      await page.locator('[data-sentence-id="107"]').scrollIntoViewIfNeeded({ timeout: 5000 });
    },
    waitForAfterAction: '[aria-label="Delivery direction: shouted from across the yard, half-laughing — edit"]',
    scrollTo: '[data-sentence-id="107"]',
    strict: true,
  },
  {
    /* Higher-quality tier story — the bulk "Pin higher quality" flow
       (cast.tsx:773, visible whenever the book has any Qwen cast members;
       Saltgrave does). Captures the confirm dialog, not just the button. */
    id: 'cast-pin-higher-quality',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    waitFor: '[data-testid^="cast-row-"]',
    action: async (page) => {
      await page.getByTestId('pin-higher-quality').click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Pin 1.7B quality to all Qwen cast?',
    strict: true,
  },
  {
    /* Series memory — "N books in, not a voice changed" reveal panel,
       opened from the library shelf's series-memory-chip (Task 2's fixture
       fix is what makes this chip render at all under DEMO_CAPTURE).

       Depends on the library rendering in CARD view, not table view — the
       chip only exists in library-grid.tsx, never library-table.tsx
       (book-library.tsx:228's effectiveViewMode reads a persisted
       localStorage value, defaulting to 'card' on the empty storage a fresh
       Playwright context always has). This holds today; if that default or
       a persisted value ever flips to 'table', this scene and
       series-share-card below silently stop finding the chip. */
    id: 'series-memory-reveal',
    hash: '#/',
    viewports: ['desktop'],
    waitFor: '[data-testid="series-memory-chip"]',
    action: async (page) => {
      await page.getByTestId('series-memory-chip').click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=books in, and the cast carries through',
    strict: true,
  },
  {
    /* Series memory — the shareable portrait card (ShareCardModal / +
       SeriesShareCard), opened from the reveal panel's "Share this cast"
       button. Same chip + fixture dependency as series-memory-reveal above. */
    id: 'series-share-card',
    hash: '#/',
    viewports: ['desktop'],
    waitFor: '[data-testid="series-memory-chip"]',
    action: async (page) => {
      await page.getByTestId('series-memory-chip').click({ timeout: 5000 });
      await page.waitForSelector('text=books in, and the cast carries through', { timeout: 5000 });
      await page.getByRole('button', { name: 'Share this cast' }).click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Download image',
    strict: true,
  },
  {
    /* Series memory — the portrait cast card as the app EXPORTS it, not as the
       page shows it. The sibling series-share-card scene above frames the modal
       in context (dimmed library behind, close button, both download buttons);
       this one presses "Download image (.png)" and keeps the file that comes
       back, so the output is the standalone 4:5 share unit with no app chrome
       — the one launch asset that has to travel on its own, off-app (Reddit,
       the marketing site) rather than as a screenshot of a window.

       Same chip + Hollow Tide fixture dependency as the two scenes above; a
       real multi-book series is the whole point of the card (its hero line
       counts voices kept true ACROSS books, so a single-book library would
       render a meaningless card).

       Dark-only, deliberately. The card is a fixed dark surface
       (series-share-card.tsx hardcodes `bg-[#1b1714] text-cream`) but it draws
       its accent from the themed `--magenta` token, which is #a43c6c in light
       and #e58fb8 in dark (src/styles.css). Only the dark value has usable
       contrast on a near-black card, so a light capture is not a second
       treatment to choose from — it is the same card with a muddy accent. */
    id: 'series-cast-card-export',
    hash: '#/',
    viewports: ['desktop'],
    themes: ['dark'],
    waitFor: '[data-testid="series-memory-chip"]',
    action: async (page) => {
      await page.getByTestId('series-memory-chip').click({ timeout: 5000 });
      await page.waitForSelector('text=books in, and the cast carries through', { timeout: 5000 });
      await page.getByRole('button', { name: 'Share this cast' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="series-share-card"]',
    downloadAction: async (page) => {
      await page.getByRole('button', { name: /download image \(\.png\)/i }).click({ timeout: 5000 });
    },
    strict: true,
  },
];
