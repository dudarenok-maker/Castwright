---
status: active
shipped: null
owner: null
---

# 58 — E2E coverage refresh

> Status: active
> Key files: `e2e/listen-playback.spec.ts`, `e2e/new-book-flow.spec.ts`,
> `e2e/binary-upload.spec.ts` (NEW), plus serial-mode fixes on
> `cover-framing`, `smoke`, `revision-diff`, `toast-surface`,
> `theme-toggle` (six spec files total).
> URL surface: none (test-only).
> OpenAPI ops: none.

## Benefit / Rationale

- **Technical:** Restores e2e coverage on the two highest-blast-radius
  surfaces (mini-player play + new-book cold-boot walk) that plan 46
  parked when they flaked under parallel-worker contention. Until this
  plan, both code paths had only Vitest+jsdom coverage — which is known
  to lie about audio playback timing and SSE phase ordering.
- **Technical:** Adds binary-upload coverage for EPUB / PDF / MOBI /
  AZW3 (the four extensions plan 52 enabled). Today only the text-paste
  path is exercised in e2e; the binary route is unit-tested at the
  parser level but the browser-level handleFile → setImportCandidate →
  confirm-metadata seam was untested.
- **Technical:** Eliminates the flaky e2e specs that hard-failed across
  multiple verify runs under contention (cover-framing, smoke, toast-
  surface, theme-toggle, revision-diff). Each now uses file-level
  `test.describe.configure({ mode: 'serial' })` so its tests run in
  one worker while other spec files still parallelise — recovers
  stability without sacrificing overall throughput.

## Architectural impact

- **No production changes.** Plan 58 is purely test-side.
- **New seam:** none. The file-level `test.describe.configure({ mode:
  'serial' })` directive is a Playwright primitive used as a workaround
  for worker-contention races that don't reflect a real product bug.
- **Invariants preserved:**
  - Plan 37 (Playwright e2e harness): chromium-only, mock mode on
    port 5174, same `playwright.config.ts` worker/retry policy.
  - Plan 46 (lint baseline): test files satisfy ESLint defaults.
  - Plan 52 (MOBI/AZW3 parsing): the new binary-upload spec uses dummy
    buffers, not real binary fixtures — mock api.uploadManuscript
    accepts any file payload. Real-binary coverage for MOBI/AZW3
    remains an open follow-up (BACKLOG): needs Calibre's `ebook-
    convert` to generate fixtures, which is a per-developer install.

## v1.3.0 scope

- ✅ Un-quarantine `e2e/listen-playback.spec.ts`. Replace `test.fixme`
  with file-level serial mode.
- ✅ Un-quarantine `e2e/new-book-flow.spec.ts`. Same treatment.
- ✅ Apply file-level serial mode to five other consistently-flaky
  spec files: `cover-framing`, `smoke`, `revision-diff`,
  `toast-surface`, `theme-toggle`. These weren't quarantined but
  hard-failed in multiple verify runs across the v1.3.0 development.
- ✅ Add `e2e/binary-upload.spec.ts` — covers EPUB / PDF / MOBI /
  AZW3 upload routing through the mock api. 4 specs, one per
  extension.
- ⏳ Real-binary fixtures for MOBI/AZW3 — punted. Requires Calibre
  install + `scripts/gen-parser-fixtures.mjs` extension. Documented
  in this plan's Out-of-scope section.

## Invariants to preserve

1. **Serial mode is per-file, not global.** Each affected spec carries
   its own `test.describe.configure({ mode: 'serial' })` at the file
   top. Other spec files keep running in parallel — the contention
   isolation is just within a problematic file's own tests, not across
   the suite.
2. **Mock-mode upload accepts any file.** The binary-upload spec
   relies on `mockUploadManuscript` (`src/lib/api.ts`) not parsing
   file content — it just generates a random `manuscriptId` and
   returns an `UploadResponse`. The spec's dummy buffers are valid
   inputs.
3. **The two un-quarantined specs (`listen-playback`,
   `new-book-flow`) cover golden-path behaviour that no other spec
   pins.** They're the primary regression tests for the
   `<audio>`-play + new-book-cold-boot seams.

## Test plan

### Automated coverage

This entire plan IS the automated coverage. Specifically:

- `e2e/listen-playback.spec.ts` (un-quarantined, serial) — 1 spec.
- `e2e/new-book-flow.spec.ts` (un-quarantined, serial) — 1 spec.
- `e2e/binary-upload.spec.ts` (NEW, serial) — 4 specs (one per
  extension).
- `e2e/cover-framing.spec.ts` (serial added) — no spec changes,
  contention fix.
- `e2e/smoke.spec.ts` (serial added) — contention fix.
- `e2e/revision-diff.spec.ts` (serial added) — contention fix.
- `e2e/toast-surface.spec.ts` (serial added) — contention fix.
- `e2e/theme-toggle.spec.ts` (serial added) — contention fix.

### Acceptance

`npm run verify` lands green at least 5 times in a row on a Windows
host with default parallel workers. (Plan 46 quarantined the two
worst offenders because they were 0-for-N green on a busy Windows
box; plan 58's serial-mode fix should make all eight affected files
deterministically green.)

## Out of scope

- **Real MOBI / AZW3 fixtures.** Needs Calibre's `ebook-convert` and
  a per-developer install. The current binary-upload spec covers the
  routing seam with dummy buffers; full parser-integration coverage
  would need real fixtures. BACKLOG follow-up item — keep the entry
  open after this plan ships.
- **Per-worker tuning of `playwright.config.ts`.** File-level serial
  mode is the right fix because the contention is inside specific
  specs (audio timing, SSE phase, localStorage round-trips); a global
  workers=1 would tank overall runtime needlessly.
- **Fixing the `visual.spec.ts` flakes (visual library/upload).**
  Those are flaky-but-pass-on-retry, not hard-failing. They likely
  need their own investigation (likely a layout race during the first
  paint). Tracked separately.
- **Removing the BACKLOG entry for "e2e binary-upload coverage".**
  Plan 58 partially closes it (routing seam); the entry stays open
  until the real MOBI/AZW3 fixture path lands.

## Ship notes

(Filled in when status flips to `stable`.)
