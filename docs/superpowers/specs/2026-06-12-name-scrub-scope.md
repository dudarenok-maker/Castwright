# Marlow / the Hollow Tide → Coalfall scrub — scope

**Status:** scope (decisions captured 2026-06-12; not yet planned)
**Type:** content/copyright scrub (not a feature)

## Goal

Remove all *The Hollow Tide* (Della Renwick, third-party copyright)
content from the repository — used today as the de-facto test/mock dataset — and
replace it with Castwright-owned content (**The Coalfall Commission** + the
invented **Hollow Tide** series). Commit an owned canonical e2e manuscript so the
documented test recipe no longer points at a copyrighted local-only file.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Scope boundary | **Everything**, including the ~45 archived/historical regression-plan docs. |
| Canonical manuscript | **Commit an owned manuscript** (the Coalfall Commission, 2 chapters) into the repo as the e2e fixture. |
| Manuscript length | 2 chapters is **sufficient** (user-confirmed). |

## The footprint (grounded)

The the Hollow Tide universe is the primary fixture/mock dataset across the codebase, far
beyond just "the Coalfall Commission". Union ≈ **150+ files**. Name occurrences:
Wren (130), Marlow (124), "Keeper of the Lost" (50), The Drowning Bell (45), Oduvan
(33), Brann (22), Saltgrave (19), The Tidewatcher's Oath (18).

Five categories by risk:

| # | Category | Where | Risk |
|---|---|---|---|
| 1 | **Canonical manuscript pointer** | `CLAUDE.md` + ~60 doc refs to `…\the Coalfall Commission.txt` | Low (doc edits) |
| 2 | **Code comments** (the Hollow Tide as examples) | `roster-coverage.ts`, `voice-match.ts`, `text-match.ts`, `series-cast-scan.ts`, `drift-report.tsx`, `api.ts` comments | Low — verified **no logic depends on them**, pure reword |
| 3 | **Frontend mock data** | `src/mocks/` (incl. `canned-data.ts`), `src/data/`, the mock branch of `src/lib/api.ts` (e.g. `mock-book-The Drowning Bell`) | Med — drives mock-mode UI, marketing capture, frontend tests asserting names |
| 4 | **Server test fixtures** | many `server/src/**/*.test.ts` (analyzer/audio/export) | **High** — use the Hollow Tide manuscripts + assert specific names/counts → owned fixtures + expected-value rewrites |
| 5 | **Docs prose / archived plans** | 45 files, mostly historical regression plans | Med (volume) — reword the Hollow Tide walkthrough examples |

## Owned replacement canon

**The Coalfall Commission** — Castwright-owned, purpose-built as "a clean, owned
replacement for the proprietary the Coalfall Commission" (see
`brand/test-book/the-coalfall-commission-cast-sheet.md`). 2 chapters, 2,892
words, **14 speakers + narrator**, with a deliberate **test-case map** that
mirrors the suite's needs:

| Owned cast member | Serves the test pattern |
|---|---|
| **Wren** (alias **Sparrow**) | alias resolution (was `Marlow`/`Wren` + aliases) |
| **Brann Weir** / **Berrin Weir** (twins) | twin / same-demographics disambiguation |
| **Coalfall** (dragon), **the bell** | non-human voices |
| **Pell Hollis** (unnamed lane voice → named) | incidental-speaker promotion |
| **Master Oduvan** (70), **Sela** (8), **Widow Casper** (80s) | age-spread |
| **Narrator**, **Maerin**, **Father Lessom** (whisper), **Ivo**, **Hart** | register spread, narrator slot |

Source files already exist (git-ignored, owned): `brand/test-book/the-coalfall-commission.md`
(manuscript), `.epub`, `-cast-sheet.md` (roster + expected casting + test-case map).

**Series cases** (cross-book reuse, `series-cast-scan`, voice-match across
books) need an owned *multi-book series*. Coalfall is standalone → use the
invented **Hollow Tide** series (3 books: *The Drowning Bell*, *The Tidewatcher's
Oath*, *Saltgrave*; author *Marin Vale*) already established in the marketing
capture, with **fabricated owned rosters** (tests need consistent owned names,
not real prose).

## Replacement-mapping approach

A single fixed mapping table (the Hollow Tide entity → owned entity) applied
consistently, leveraging the deliberate analogues above so test *intent* is
preserved. Examples:
- `Wren` / `Marlow` → `Wren` (+ alias `Sparrow`) or the appropriate Coalfall role
- the Hollow Tide twins / look-alikes → `Brann Weir` / `Berrin Weir`
- `The Hollow Tide` (series) → `The Hollow Tide`
- `The Drowning Bell` / `The Tidewatcher's Oath` / `Saltgrave` / `Unlocked` (books) → Hollow Tide book titles
- `the Coalfall Commission.txt` → the committed Coalfall manuscript fixture

## Fidelity strategy

- **Categories 1, 2, 5** (pointer, comments, docs): structure-preserving rename
  via the mapping table — mechanical.
- **Category 3** (frontend mocks): swap book/character fixtures to owned ones;
  update frontend tests that assert names. The mock manuscripts dir is already
  partly owned (`src/mocks/manuscripts/the-northern-star.md`).
- **Category 4** (server analyzer fixtures): where a test asserts *prose-derived*
  values (occurrence counts, char positions, roster coverage), a pure rename is
  insufficient — re-fixture against the **owned Coalfall manuscript text** and
  recompute expected values. This is the bulk of the effort.

## Committed-manuscript location (proposal)

Move an owned copy of the manuscript out of git-ignored `brand/test-book/` into a
committed fixtures path — proposed `server/src/__fixtures__/the-coalfall-commission.md`
(+ `.epub` if a parser fixture wants it), alongside the existing
`server/src/parsers/__fixtures__/`. Update CLAUDE.md's "Canonical end-to-end
manuscript" to cite the committed path. (Brand cover art etc. stay git-ignored;
only the manuscript text + cast sheet become committed test fixtures.)

## Phasing (recommended)

0. **Commit the owned manuscript fixture** + a `the Hollow Tide→owned` mapping doc (the canon).
1. **Canonical pointer** — CLAUDE.md + ~60 doc refs → committed Coalfall path.
2. **Code comments** — reword (low risk, no tests affected).
3. **Frontend mock data** — owned books/chars + frontend test updates.
4. **Server fixtures** — owned manuscripts/rosters + expected-value rewrites (largest).
5. **Docs prose / archived plans** — reword the Hollow Tide examples (mechanical, high volume).

Each phase is independently shippable and verifiable (`npm run verify` /
`test:server`), so they can land as separate PRs.

## Open items / risks (resolve during planning)

- **Server-fixture churn (Cat 4)** is the real cost — some analyzer tests encode
  the Hollow Tide-prose-specific expectations; those become owned-manuscript-specific.
  Needs a pass to identify which tests are pure-rename vs. re-fixture.
- **Hollow Tide rosters** must be fabricated for series tests (owned names only).
- **Archived-doc churn (Cat 5)** edits historical records; acceptable per the
  "everything" decision, but it's ~45 files of prose.
- **Mapping completeness** — enumerate every the Hollow Tide name in use (not just the top
  8) before the rename so nothing is missed.

## Effort

Large and cross-cutting (~150+ files), but most is mechanical rename once the
mapping table is fixed. The concentrated-effort core is **Category 4** (server
analyzer fixture re-derivation). Recommend executing phase-by-phase as separate
PRs rather than one mega-change.
