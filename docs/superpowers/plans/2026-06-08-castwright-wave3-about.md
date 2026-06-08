# Castwright Wave 3 — /about brand page + error-copy polish (plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** A dedicated `#/about` brand page (Castwave mark, primary tagline, manifesto, castwright.ai link, app version), linked from Admin; plus a light brand-voice polish of the top-level error boundary. **Descoped:** a broad toast-copy rewrite — existing toast/error strings already follow the brand voice (functional, no AI hype); rewriting them all is low-value churn (CLAUDE.md "surgical changes"). Noted in the PR.

**Source of truth:** `docs/superpowers/specs/2026-06-08-castwright-brand-full-pass-design.md` (Wave 3). Precedent for a standalone route: the Model Manager (`#/models`).

Brand strings (verbatim):
- Primary tagline (FIXED): `Any book, performed by a full cast — effortlessly. Even in your own voice.`
- Manifesto: `Many voices, one machine.`
- Story line: `Castwright turns a book into a full-cast performance — and keeps each voice true from book one to the last. Even in your own voice.`
- Domain link: `https://castwright.ai` (label `castwright.ai`)

---

## Task 1 — `#/about` route plumbing + view + Admin link

Mirror the Model Manager wiring EXACTLY (it's the working precedent).

**Files:**
- `src/lib/types.ts` (the `Stage` discriminated union) — add `{ kind: 'about' }`.
- `src/lib/router.ts` — `stageToHash`: add `case 'about': return '#/about';`; `parseHash`: map `#/about` → `{ kind: 'about' }` (mirror the `models`→`model-manager` mapping).
- `src/store/ui-slice.ts` — add reducer `openAbout: (s) => { s.stage = { kind: 'about' }; }` (mirror `openModelManager`, ~line 160).
- `src/routes/index.tsx` — lazy import `AboutView` (mirror `ModelManagerView` ~line 69); add `function AboutRoute() { useHydrateStage({ kind: 'about' }, []); return <AboutView />; }` (mirror `ModelManagerRoute` ~line 326); register `{ path: 'about', element: <AboutRoute /> }` (mirror ~line 922).
- Create `src/views/about.tsx` — `export function AboutView()`. Mirror `model-manager.tsx` structure: `<div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">`, a `SectionLabel` ("About"), a `MixedHeading regular="About" bold="Castwright" level="h1"`. Then content (`space-y-6`):
  - Big `<CastwaveMark className="w-16 h-16 text-magenta" aria-hidden="true" />` (import from `../lib/icons`).
  - Primary tagline in serif, prominent: `<p className="font-serif text-xl text-ink">Any book, performed by a full cast — effortlessly. Even in your own voice.</p>`.
  - Manifesto: `<p className="text-ink/60">Many voices, one machine.</p>`.
  - Story paragraph (the story line above) in `text-ink/70 max-w-prose`.
  - External link: `<a href="https://castwright.ai" target="_blank" rel="noreferrer" className="text-magenta font-medium hover:underline">castwright.ai</a>`.
  - App version: `import { buildInfo } from '../lib/build-info'` → show `Castwright v{buildInfo.version} ({buildInfo.sha})` in `text-xs text-ink/50`.
  - A back link to the library (mirror however model-manager returns; if it relies on the top-bar back, add a simple `<button onClick={() => dispatch(uiActions...)}>← Back</button>` only if model-manager has one — otherwise omit and rely on the top bar).
- `src/views/admin.tsx` — add an `AboutLink` section mirroring `ModelManagerLink` (~line 119-149): heading "About Castwright", a one-line description, a button `onClick={() => dispatch(uiActions.openAbout())}` with `data-testid="admin-open-about"` and label "About Castwright →".

**Tests (TDD):**
- `src/views/about.test.tsx`: renders the primary tagline, the manifesto, the `castwright.ai` link (href), and the version (`buildInfo.version`).
- Router: if `src/lib/router.test.ts` exists, add `stageToHash({kind:'about'}) === '#/about'` and `parseHash('#/about')` round-trip; else add a `ui-slice` test that `openAbout` sets `stage.kind === 'about'`.
- `src/views/admin.test.tsx`: the `admin-open-about` button dispatches `openAbout` (stage becomes about). Mirror the existing `admin-open-model-manager` test.

**Verify:** `npm test -- about admin router ui-slice` green; `npm run typecheck` clean (Stage union exhaustiveness — make sure any `switch` over `stage.kind` that must handle all variants still compiles; if a switch needs an `about` case, add it minimally).

**Commit:** `feat(frontend): /about brand page (Castwave mark, tagline, version) linked from Admin`.

## Task 2 — Error-boundary brand-voice polish (light)

**File:** `src/components/error-boundary.tsx` + `error-boundary.test.tsx`.

- The current heading "The Generate screen hit a render error." is oddly specific (it's the app-wide boundary). Make it general + on-brand-calm:
  - Eyebrow: keep `Something broke` (fine) OR `Something went sideways` (dry, on-brand). Use `Something went sideways`.
  - Heading: `Castwright hit a snag rendering this screen.`
  - Body: keep the existing reassurance ("Your work is still safe on disk. …") — it's already on-voice; leave it.
  - Button: keep `Try again`.
- TDD: update `error-boundary.test.tsx`'s copy assertion to the new heading/eyebrow; keep the reset-button test green.

**Commit:** `feat(frontend): brand-voice polish on the error boundary`.

## Task 3 — Verify + PR

- [ ] `npm run verify` green.
- [ ] Add one Playwright assertion: navigating to `#/about` shows the tagline (small new spec or extend an existing one). Keep e2e green.
- [ ] Push `feat/castwright-about-voice`; `gh pr create` with `Refs #631` (Wave 3, final wave); body links spec + plan and notes the descoped toast rewrite.

## Notes
- Reuse `<CastwaveMark/>` (magenta); do not inline SVGs.
- Mirror the model-manager route wiring precisely — don't invent a new routing mechanism.
- Keep the look consistent with model-manager (same container/heading pattern).
