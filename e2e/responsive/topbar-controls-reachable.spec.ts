/* #4567 (3/4) — every top-bar control is either fully visible inside the
 * viewport or reachable from the nav drawer. Owner decision 2026-11-25: below
 * sm (640) Help / Theme / Account live in the drawer on every stage (the
 * analysing stage gets the hamburger too); at sm+ the inline copies stay.
 * Owner decisions 2026-11-28 (#4691): from 640 to 1023 the book title in the
 * bar truncates with an ellipsis (with a 44px floor) and the wordmark text and
 * version pill hide below 2xl (1536), so Help / Theme / Account stay inline at
 * every width from sm up; at xl (1280+) every inline nav tab fits instead of
 * the middle strip clipping the last one. The queue chip is an icon + count.
 *
 * The in-viewport check enumerates every visible interactive element in the
 * header generically (not a hard-coded 3), so a future control that overflows
 * the bar fails here with its own name in the message. A control must sit inside
 * the viewport AND inside every ancestor whose computed `overflow-x` is not
 * `visible` (the bar's own `overflow-x-clip` row, the middle `overflow-x-auto`
 * strip), so a control scrolled out of sight inside the tab strip fails too.
 *
 * Runs under all three projects (responsive/* glob). Phone-only and sm+-only
 * assertions are skipped by viewport width; the dedicated-widths test at the
 * bottom resizes the page itself, so it pins 640 to 1600 in every project.
 *
 * Stage variants beyond the plain routes, both driven in mock mode through the
 * real reducers on `window.__store__`: "long title" (hydrateFromBookState with a
 * title longer than "The Coalfall Commission") and "generate mid-render" (an
 * open generation stream at 45% plus queued chapters, which is what renders the
 * `Generating · 45%` status pill and the queue chip). */
import { test, expect, type Page } from '@playwright/test';
import { goToAnalysing, waitForLibraryViewReady, waitForListenViewReady } from '../helpers';

type Stage = {
  name: string;
  open: (page: Page) => Promise<void>;
};

type StoreWindow = {
  __store__: {
    dispatch: (a: unknown) => void;
    getState: () => {
      manuscript: { manuscriptId: string | null };
      chapters: { chapters: Array<Record<string, unknown>> };
    };
  };
};

const LONG_TITLE = 'The Coalfall Commission: A Very Long Subtitle That Cannot Fit In The Bar';

/* "CH 01" only renders once the chapters slice has hydrated, and the status chip
   reads "Revisions · 1" once the Solway Bay revisions have loaded — the same
   anchors visual.spec.ts uses, so a header measured before hydration (no title,
   a bare "Status" chip) can never pass for the real bar. */
async function waitForSolwayBayHydrated(page: Page): Promise<void> {
  await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('status-pill').first()).toHaveText('Revisions · 1');
}

async function openListen(page: Page): Promise<void> {
  await page.goto('/#/books/sb/listen');
  await waitForListenViewReady(page, /Solway Bay/i);
  await expect(page.getByTestId('status-pill').first()).toHaveText('Revisions · 1');
}

async function openGenerate(page: Page): Promise<void> {
  await page.goto('/#/books/sb/generate');
  await waitForSolwayBayHydrated(page);
}

/* A generation stream 9/20 done with one chapter running and eleven queued (a
   whole-book render, the widest the bar gets): the status pill becomes
   `Generating · 45%` and the queue chip (icon + `12`) appears. */
async function startMidRender(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as StoreWindow).__store__;
    const chapters = store.getState().chapters.chapters;
    store.dispatch({
      type: 'chapters/setChapters',
      payload: chapters.map((c, i) =>
        i >= chapters.length - 12 ? { ...c, state: i === chapters.length - 12 ? 'in_progress' : 'queued' } : c,
      ),
    });
    store.dispatch({
      type: 'chapters/setActiveStream',
      payload: {
        streamKey: 'sb::*',
        bookId: 'sb',
        chapterId: null,
        modelKey: 'qwen',
        done: 9,
        total: 20,
        inProgress: 1,
        lastTickAt: Date.now(),
        halted: false,
      },
    });
  });
  await expect(page.getByTestId('status-pill').first()).toHaveText('Generating · 45%');
  const chip = page.getByTestId('topbar-queue-chip');
  await expect(chip).toHaveText('12');
  await expect(chip).toHaveAccessibleName('Generation queue — 12 pending');
}

async function setLongTitle(page: Page): Promise<void> {
  await page.evaluate((title) => {
    const store = (window as unknown as StoreWindow).__store__;
    store.dispatch({
      type: 'manuscript/hydrateFromBookState',
      payload: {
        state: {
          bookId: 'sb',
          manuscriptId: store.getState().manuscript.manuscriptId,
          title,
        },
        sentences: null,
      },
    });
  }, LONG_TITLE);
  await expect(page.locator('header').getByText(LONG_TITLE)).toBeVisible();
}

const STAGES: Stage[] = [
  {
    name: 'analysing',
    open: goToAnalysing,
  },
  {
    name: 'listen',
    open: openListen,
  },
  {
    name: 'generate',
    open: openGenerate,
  },
  {
    name: 'books home',
    open: async (page) => {
      await page.goto('/#/');
      await waitForLibraryViewReady(page);
      await expect(page.getByTestId('status-pill').first()).toHaveText('Status');
    },
  },
  {
    name: 'listen, long title',
    open: async (page) => {
      await openListen(page);
      await setLongTitle(page);
    },
  },
  {
    name: 'generate, mid-render',
    open: async (page) => {
      await openGenerate(page);
      await startMidRender(page);
    },
  },
];

/* Every visible button / link / role=button inside the top bar must (1) sit fully
 * inside [0, viewport width] (+-1px) and inside every ancestor that clips
 * horizontally, (2) have a real box (a control the layout renders but that
 * measures 0 wide/high was crushed by its siblings, so it FAILS; only an element
 * `checkVisibility` drops, e.g. a `hidden sm:inline-flex` wrapper, is skipped),
 * (3) not overlap any other header control, (4) not clip its own content
 * (`scrollWidth <= clientWidth + 1`; the book-title TEXT is the one deliberate
 * truncation and is a span, not a control, so it is not measured — the title
 * button is, so its `/` and arrow can't spill), and (5) leave the bar's right
 * padding free: the right-most control must end inside the row's content box, which
 * is where a wider-font runner (Linux) first shows up before it cuts a control. The
 * title button also keeps a floor: >= 44px wide on a coarse pointer, with some of
 * its text showing. */
async function expectHeaderControlsInViewport(page: Page): Promise<void> {
  const vw = page.viewportSize()?.width ?? 0;
  const { controls, rowContentRight, coarse } = await page
    .locator('header')
    .first()
    .evaluate((header) => {
      type C = {
        label: string;
        x: number;
        right: number;
        y: number;
        bottom: number;
        w: number;
        h: number;
        scrollW: number;
        clientW: number;
        clippedBy: string | null;
        isTitle: boolean;
        titleTextW: number;
        titleText: string;
      };
      const out: C[] = [];
      const els: HTMLElement[] = [];
      for (const el of Array.from(
        header.querySelectorAll<HTMLElement>('button, a, [role=button]'),
      )) {
        // checkVisibility() honours display:none / visibility on ANCESTORS (the
        // `hidden sm:inline-flex` wrapper spans), which getComputedStyle(el) misses.
        if (!el.checkVisibility({ visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        const label =
          el.getAttribute('data-testid') ||
          el.getAttribute('aria-label') ||
          (el.textContent ?? '').trim().slice(0, 40) ||
          el.tagName.toLowerCase();
        // The control must also fit inside every ancestor that clips or scrolls
        // horizontally (the clip box is the ancestor's padding box).
        let clippedBy: string | null = null;
        for (let p = el.parentElement; p && p !== header.parentElement; p = p.parentElement) {
          if (getComputedStyle(p).overflowX === 'visible') continue;
          const pr = p.getBoundingClientRect();
          const left = pr.left + p.clientLeft;
          const right = left + p.clientWidth;
          if (r.x < left - 1 || r.right > right + 1) {
            clippedBy = `${p.tagName.toLowerCase()}.${p.className.toString().split(/\s+/).slice(0, 4).join('.')} [${Math.round(left)}..${Math.round(right)}]`;
            break;
          }
        }
        const isTitle = el.getAttribute('data-testid') === 'topbar-title';
        const text = isTitle ? el.querySelector<HTMLElement>('span.truncate') : null;
        els.push(el);
        out.push({
          label,
          x: r.x,
          right: r.right,
          y: r.y,
          bottom: r.bottom,
          w: r.width,
          h: r.height,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          clippedBy,
          isTitle,
          titleTextW: text ? text.getBoundingClientRect().width : 0,
          titleText: text ? (text.textContent ?? '').trim() : '',
        });
      }
      const row = header.firstElementChild as HTMLElement;
      const rr = row.getBoundingClientRect();
      const rowContentRight = rr.right - parseFloat(getComputedStyle(row).paddingRight);
      return {
        controls: out,
        rowContentRight,
        coarse: window.matchMedia('(pointer: coarse)').matches,
      };
    });
  expect(controls.length, 'header has visible interactive controls').toBeGreaterThan(0);
  for (const c of controls) {
    expect(c.w, `top-bar control "${c.label}" crushed to zero width (vw=${vw})`).toBeGreaterThan(0);
    expect(c.h, `top-bar control "${c.label}" crushed to zero height (vw=${vw})`).toBeGreaterThan(0);
    expect(c.x, `top-bar control "${c.label}" clipped off the left (vw=${vw})`).toBeGreaterThanOrEqual(-1);
    expect(c.right, `top-bar control "${c.label}" clipped off the right (vw=${vw})`).toBeLessThanOrEqual(
      vw + 1,
    );
    expect(
      c.clippedBy,
      `top-bar control "${c.label}" clipped by an overflow ancestor (vw=${vw})`,
    ).toBeNull();
    expect(
      c.scrollW,
      `top-bar control "${c.label}" clips its own content (scrollWidth ${c.scrollW} > clientWidth ${c.clientW}, vw=${vw})`,
    ).toBeLessThanOrEqual(c.clientW + 1);
    if (c.isTitle) {
      if (coarse) {
        expect(c.w, `book-title button under the 44px touch target (vw=${vw})`).toBeGreaterThanOrEqual(43.5);
      }
      expect(c.titleText, 'book-title button has text').not.toBe('');
      expect(c.titleTextW, `book-title text fully squeezed out (vw=${vw})`).toBeGreaterThanOrEqual(8);
    }
  }
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      expect(
        ox > 1 && oy > 1,
        `top-bar controls "${a.label}" and "${b.label}" overlap by ${Math.round(ox)}x${Math.round(oy)}px (vw=${vw})`,
      ).toBe(false);
    }
  }
  const last = controls.reduce((m, c) => (c.right > m.right ? c : m), controls[0]);
  expect(
    last.right,
    `top-bar control "${last.label}" runs into the row's right padding (content edge ${Math.round(rowContentRight)}, vw=${vw})`,
  ).toBeLessThanOrEqual(rowContentRight + 1);
}
for (const stage of STAGES) {
  test.describe(`top-bar controls reachable — ${stage.name}`, () => {
    test('phone: every header control is in the viewport and Help/Theme/Account are in the drawer', async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 0;
      test.skip(width >= 640, 'phone-only: sm+ keeps the inline Help/Theme/Account');

      await stage.open(page);
      await expectHeaderControlsInViewport(page);

      const toggle = page.getByTestId('topbar-nav-toggle');
      await expect(toggle, 'hamburger present (analysing included)').toBeVisible();
      const tbox = await toggle.boundingBox();
      expect(tbox, 'hamburger has a box').not.toBeNull();
      expect(tbox!.width, 'hamburger width >= 44').toBeGreaterThanOrEqual(43.5);
      expect(tbox!.height, 'hamburger height >= 44').toBeGreaterThanOrEqual(43.5);

      await toggle.click();
      await expect(page.getByTestId('topbar-nav-drawer')).toBeVisible();
      for (const id of ['help', 'theme', 'account'] as const) {
        const row = page.getByTestId(`nav-drawer-link-${id}`);
        await expect(row, `drawer row ${id} visible`).toBeVisible();
        // The drawer slides in (slide-in-left): poll until the animation settles
        // so a mid-slide negative x is not read as "clipped".
        await expect
          .poll(async () => (await row.boundingBox())?.x ?? Number.NEGATIVE_INFINITY, {
            message: `drawer row ${id} settles inside the left edge`,
          })
          .toBeGreaterThanOrEqual(-1);
        const box = (await row.boundingBox())!;
        expect(box.x + box.width, `drawer row ${id} not off the right`).toBeLessThanOrEqual(
          (page.viewportSize()?.width ?? 0) + 1,
        );
      }

      await page.getByTestId('nav-drawer-link-account').click();
      await expect(page).toHaveURL(/#\/account/);
    });
  });
}

test.describe('top-bar controls reachable — sm+ inline cluster unchanged', () => {
  for (const stage of STAGES) {
    test(`sm+: inline Help/Theme/Account are visible and in the viewport — ${stage.name}`, async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 0;
      test.skip(width < 640, 'sm+ only: phone moves these into the drawer');

      await stage.open(page);
      await expectHeaderControlsInViewport(page);
      await expect(page.getByTestId('topbar-help'), 'inline Help').toBeVisible();
      await expect(page.getByTestId('theme-toggle'), 'inline Theme').toBeVisible();
      await expect(page.getByRole('button', { name: /^Account/ }), 'inline Account').toBeVisible();
    });
  }
});

/* The project viewports (412 / 834 / 1280) sample three widths; the owner's
 * decisions cover the whole 640..1600 range, so each stage is opened once and
 * the page is resized through the widths that bracket the sm / md / lg / xl /
 * 2xl breakpoints. Below xl no inline nav tab is rendered; from 1280 every tab
 * must be fully visible (the clipping-ancestor check fails a tab cut off by the
 * strip). */
const WIDTHS = [640, 768, 834, 1023, 1024, 1279, 1280, 1400, 1535, 1536, 1600];
test.describe('top-bar controls reachable — explicit widths 640 to 1600', () => {
  for (const stage of STAGES) {
    test(`every header control fits at ${WIDTHS.join(' / ')} px — ${stage.name}`, async ({
      page,
    }) => {
      test.slow();
      await stage.open(page);
      // Collect every failing width so one run reports them all, not just the first.
      const failures: string[] = [];
      for (const width of WIDTHS) {
        try {
          await page.setViewportSize({ width, height: 800 });
          // Let the layout settle after the breakpoint flip before measuring.
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
          await expectHeaderControlsInViewport(page);
          // Owner decision 2026-11-28: the wordmark text and the version pill show
          // from 2xl (1536) only; the logo mark itself always stays.
          const wide = width >= 1536;
          expect(
            await page.getByTestId('version-pill').isVisible(),
            `version pill visibility at ${width}`,
          ).toBe(wide);
          expect(
            await page.getByRole('button', { name: 'Castwright — home' }).getByText('Castwright').isVisible(),
            `wordmark text visibility at ${width}`,
          ).toBe(wide);
          if (width >= 1280 && !stage.name.startsWith('analysing') && stage.name !== 'books home') {
            for (const tab of ['Cast', 'Manuscript', 'Generate', 'Listen', 'Log', 'Voices']) {
              await expect(
                page.locator('header nav').getByRole('button', { name: tab, exact: true }),
                `inline tab "${tab}" visible at ${width}`,
              ).toBeVisible();
            }
          }
        } catch (e) {
          // Keep the headline and the measurement ("Received: ...") lines.
          const lines = (e as Error).message.split('\n');
          const kept = lines.filter((l, i) => i === 0 || l.trimStart().startsWith('Received'));
          failures.push(`@${width}px: ${kept.join(' | ')}`);
        }
      }
      expect(failures, 'widths where a header control does not fit').toEqual([]);
    });
  }
});
