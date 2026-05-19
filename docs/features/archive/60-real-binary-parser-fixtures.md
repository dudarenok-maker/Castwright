---
status: stable
shipped: 2026-05-19
owner: null
---

# Real-binary MOBI / AZW3 fixtures for the parser integration tests

> Status: stable
> Key files: `scripts/gen-parser-fixtures.mjs`, `e2e/binary-upload.spec.ts`, `server/src/parsers/mobi-real-fixtures.test.ts`, `.gitignore`
> URL surface: `#/new` (binary-upload e2e)
> OpenAPI ops: indirect — covers the `POST /api/upload` parser path

## Benefit / Rationale

- **Technical:** the MOBI / AZW3 path through `@lingo-reader/mobi-parser` is the highest-risk seam in the upload flow. The library has real-world quirks — PalmDOC encryption byte detection, KF8 vs legacy Mobipocket initialization, dual-format binary disambiguation — that synthetic test fixtures can't exercise. Real Calibre-generated binaries lock the integration contract end-to-end.
- **User:** n/a directly — this work doesn't change runtime behaviour. It hardens the regression net so future refactors to `parsers/mobi.ts` or `mobi-parser` upgrades can't silently regress the upload flow.
- **Architectural:** sets the precedent for "real-fixture integration test, skipped cleanly when the per-developer prerequisite is missing" for any future third-party-binary parser additions (e.g. KFX, FB2). The skip-when-missing pattern is the key invariant.

## Architectural impact

- **New seam:** `scripts/gen-parser-fixtures.mjs` grows a Calibre probe (`where.exe ebook-convert` on Windows, `which ebook-convert` elsewhere) and two derivation functions — `generateMobiFixture` and `generateAzw3Fixture` — that shell out to `ebook-convert <epub> <out>`. Missing-Calibre exits success with a clear warning; partial-success exits success after warning about the specific failing format.
- **New test files:** `server/src/parsers/mobi-real-fixtures.test.ts` runs the REAL `parseMobi` (no library mocks) against the generated `sample.mobi` + `sample.azw3`. Uses `describe.skipIf(!existsSync(path))` so the entire suite no-ops when fixtures aren't generated. `e2e/binary-upload.spec.ts` mirrors the same skip pattern via `test.skip(true, 'Calibre required…')` for the MOBI/AZW3 cases.
- **Invariants preserved:**
  - `npm run verify` stays green on a fresh clone (no Calibre installed). The skip-when-missing pattern is the key invariant — break it and a fresh-clone dev environment can't ship.
  - The existing sibling `mobi.test.ts` (library-mocked) keeps its assertions; this new suite is purely additive. The two together cover contract (mocked, controlled inputs) AND integration (real, end-to-end).
  - EPUB + PDF e2e cases continue to use synthetic buffers — no Calibre needed for those formats.
- **Migration story:** none. New files only; existing fixtures + tests untouched.
- **Reversibility:** drop `mobi-real-fixtures.test.ts`, revert the binary-upload spec to the plan-58 dummy-buffer version, and remove the Calibre block from the fixture script. No on-disk state to undo.

## Invariants to preserve

1. `scripts/gen-parser-fixtures.mjs` MUST exit 0 when `ebook-convert` is missing from PATH. The script prints the breadcrumb to stderr and continues to write the EPUB fixtures (which don't need Calibre). Enforced by the `findCalibre()` early-return at the end of the script.
2. `server/src/parsers/mobi-real-fixtures.test.ts` uses `describe.skipIf` keyed on `existsSync()` — the suite reports 0 tests run rather than failing when fixtures are absent.
3. `e2e/binary-upload.spec.ts` MOBI + AZW3 cases call `test.skip(true, 'Calibre required for real …')` when their `realFixturePath` doesn't exist. The skip message names Calibre + the regeneration command + the install URL.
4. `.gitignore` excludes `server/src/parsers/__fixtures__/sample.mobi` + `sample.azw3`. The binaries are regeneratable from the checked-in EPUB; committing them would bloat the repo and pin against a specific Calibre version's output.
5. The source EPUB at `server/src/parsers/__fixtures__/sample.epub` is the canonical input — both MOBI and AZW3 fixtures derive from it via `ebook-convert`. Tests assert `title === 'The Solway Light'` and `author === 'Jane Doe'` (matching the EPUB's `<dc:title>` + `<dc:creator>`).

## Test plan

### Automated coverage

- **Vitest server (`server/src/parsers/mobi-real-fixtures.test.ts`)** — 8 assertions across both formats: parse without throw, dc:title extraction, dc:creator extraction, chapter body contains source text. Skipped via `describe.skipIf` when fixtures are missing.
- **Playwright e2e (`e2e/binary-upload.spec.ts`)** — MOBI + AZW3 cases load the real binary via `readFileSync(realFixturePath)`, drop it into the upload `<input type="file">`, and assert the confirm-metadata "Save book and start analysis" button renders. Skipped via `test.skip(true, …)` when fixtures are missing.
- **Existing `server/src/parsers/mobi.test.ts`** (library-mocked) stays intact — it covers the contract surfaces (DRM detection, AZW3 ext routing, TOC label resolution) that real binaries can't easily exercise.

### Manual acceptance walkthrough

1. **Fresh clone, no Calibre:** `git clone … && npm install && npm run verify` — expected: all suites green; the new server suite reports "0 tests" with the `[mobi-real-fixtures] Calibre-generated …` warning in stderr; the e2e MOBI/AZW3 cases show `skipped` with the "Calibre required…" message.
2. **With Calibre on PATH:** `node scripts/gen-parser-fixtures.mjs` — expected: prints `using Calibre at …` then `wrote …/sample.mobi` and `wrote …/sample.azw3`. Files appear under `server/src/parsers/__fixtures__/` but are gitignored.
3. **Re-run verify with Calibre:** `npm run verify` — expected: all suites green; new server suite reports 8 tests passed; e2e MOBI/AZW3 cases run through the real binary path and pass.
4. **Calibre missing mid-stream:** delete the two generated files and run `npm run test:e2e e2e/binary-upload.spec.ts` — expected: EPUB + PDF cases pass, MOBI + AZW3 cases skip with the "Calibre required" message.

## Out of scope

- **Auto-installing Calibre.** Calibre is a per-developer install, not bundled with the repo. The BACKLOG entry for this work was explicit on that point — bundling Calibre would balloon the install footprint by hundreds of MB for a test-only dependency. Documented as a developer prerequisite at the top of `scripts/gen-parser-fixtures.mjs`.
- **Real-server upload path through `parseMobi`.** The e2e harness runs Vite in mock mode (`VITE_USE_MOCKS=true`); the mock `uploadManuscript` doesn't parse file contents. The strongest "real parser invoked end-to-end" assertion lives in the server-side Vitest spec, not the e2e. Future work that boots the real Node analysis backend during e2e (BACKLOG Could #18 — CI integration) would extend this naturally.
- **DRM-protected real binaries.** The synthetic-byte test in `mobi.test.ts` exercises the DRM guard; reproducing a DRM-locked binary requires either a Kindle Store purchase or a deliberately-corrupted PalmDOC header. Both are out of scope; the synthetic test is sufficient.
- **KFX / FB2 / LIT / other rare formats.** Today's parser only supports MOBI + AZW3; if/when a new format lands it picks up the same skip-when-missing pattern.

## Ship notes

Shipped 2026-05-19 as part of Wave 2.S2 of the v1.4.0 alpha-launch pre-cutover slate. Branch: `test/e2e-real-binary-fixtures`. BACKLOG entry: Could #38 (now removed).

Calibre 7.x verified working at `C:\Program Files\Calibre2\ebook-convert.exe` on Windows 11. The two derived fixtures land at ~10 KB each (MOBI 9.8 KB, AZW3 12 KB), small enough that even a future "commit them anyway" call would be reasonable — but gitignored for now per the BACKLOG entry's prescription.
