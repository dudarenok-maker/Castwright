# Keefe / KotLC → Coalfall scrub — scope

**Status:** scope (decisions captured 2026-06-12; adversarial-reviewed; two decisions still open — see Open items; not yet planned)
**Type:** content/copyright scrub (not a feature)

## Goal

Remove all *Keeper of the Lost Cities* (Della Renwick, third-party copyright)
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
| Multilingual (Cat 6) | **(a)** create an owned **Russian** version of a Coalfall excerpt as the committed multilingual fixture. |
| Historicity | **Confirmed:** replace the copyrighted name, keep the illustrative point, do NOT fabricate Coalfall-specific observed values. |

## The footprint (grounded)

The KotLC universe is the primary fixture/mock dataset across the codebase, far
beyond just "Bonus Keefe Story". Union ≈ **150+ files**. Name occurrences:
Sophie (130), Keefe (124), "Keeper of the Lost" (50), Stellarlune (45), Elwin
(33), Fitz (22), Neverseen (19), Everblaze (18).

Five categories by risk:

| # | Category | Where | Risk |
|---|---|---|---|
| 1 | **Canonical manuscript pointer** | `CLAUDE.md` + ~60 doc refs to `…\Bonus Keefe Story.txt` | Low (doc edits) |
| 2a | **Code comments** (KotLC as examples) | `roster-coverage.ts`, `voice-match.ts`, `text-match.ts`, `series-cast-scan.ts`, `drift-report.tsx` | Low — no logic depends, pure reword |
| 2b | **Analyzer PROMPT examples** | `server/src/routes/analysis.ts` (~L1140–1147: KotLC names inside the LLM prompt template literals) | **Med** — these are prompt *content* the analyzer sends, likely pinned by `gemini.test.ts`/prompt tests. NOT a cosmetic reword. |
| 3 | **Frontend mock data** | `src/mocks/` (incl. `canned-data.ts`), `src/data/`, the mock branch of `src/lib/api.ts` (e.g. `mock-book-stellarlune` book entries — *data*, not comments) | Med — drives mock-mode UI, marketing capture, frontend tests asserting names |
| 4 | **Server test fixtures** | many `server/src/**/*.test.ts` (analyzer/audio/export) | **High** — use KotLC manuscripts + assert specific names/counts → owned fixtures + expected-value rewrites |
| 5 | **Docs prose / archived plans** | 45 files (19 of which **also** hold the manuscript pointer from Cat 1 — edit once, not twice) | Med (volume) |
| 6 | **Multilingual fixtures** | `e2e/language-detection.spec.ts`, `162-fs2-multilanguage.md` + non-English (Russian) KotLC content | **Blocked** — Coalfall is English-only; **no owned non-English text exists** (see Open items) |

## Owned replacement canon

**The Coalfall Commission** — Castwright-owned, purpose-built as "a clean, owned
replacement for the proprietary Bonus Keefe Story" (see
`brand/test-book/the-coalfall-commission-cast-sheet.md`). 2 chapters, 2,892
words, **14 speakers + narrator**, with a deliberate **test-case map** that
mirrors the suite's needs:

| Owned cast member | Serves the test pattern |
|---|---|
| **Wren** (alias **Sparrow**) | alias resolution (was `Keefe`/`Sophie` + aliases) |
| **Brann Weir** / **Berrin Weir** (twins) | twin / same-demographics disambiguation |
| **Coalfall** (dragon), **the bell** | non-human voices |
| **Tam Hollis** (unnamed lane voice → named) | incidental-speaker promotion |
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

A single fixed mapping table (KotLC entity → owned entity) applied
consistently, leveraging the deliberate analogues above so test *intent* is
preserved. Examples:
- `Sophie` / `Keefe` → `Wren` (+ alias `Sparrow`) or the appropriate Coalfall role
- KotLC twins / look-alikes → `Brann Weir` / `Berrin Weir`
- `Keeper of the Lost Cities` (series) → `The Hollow Tide`
- `Stellarlune` / `Everblaze` / `Neverseen` / `Unlocked` (books) → Hollow Tide book titles
- `Bonus Keefe Story.txt` → the committed Coalfall manuscript fixture

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

## Phasing (revised after adversarial review)

0. **Commit the owned manuscript fixture** + a `KotLC→owned` mapping doc (the canon).
1. **Code comments (Cat 2a)** — reword (low risk, no tests affected).
2. **Analyzer prompt examples (Cat 2b)** — reword KotLC→Coalfall *inside* the
   analyzer prompt; **update the analyzer/prompt tests in the same change** (this
   is behaviour-adjacent, not cosmetic).
3. **Frontend mock data (Cat 3)** — owned books/chars + frontend test updates.
4. **Server fixtures (Cat 4)** — owned manuscripts/rosters + expected-value
   rewrites (largest; identify pure-rename vs. re-fixture first).
5. **Docs — pointer + prose together (Cat 1 + Cat 5)** — one pass per doc file
   (the manuscript pointer and KotLC prose co-occur in 19 files; CLAUDE.md
   included). Repoints to the committed Coalfall path AND rewords examples.
6. **Multilingual (Cat 6)** — gated on the non-English-source decision below.

Phases 0–5 are independently shippable + verifiable (`npm run verify` /
`test:server`) as separate PRs. Phase 6 is blocked until its decision lands.

## Open items / risks (resolve during planning)

- **DECISION — multilingual source (Cat 6).** Coalfall is English-only and no
  owned non-English text exists. Options: (a) commission a short owned non-English
  passage (e.g. a Russian-translated Coalfall excerpt) as a committed fixture;
  (b) replace the language-detection fixture with a minimal public-domain /
  synthetic non-English snippet (no KotLC, no Coalfall); (c) descope multilingual
  from this scrub and track it separately. **Needs a call before Phase 6.**
- **DECISION — historicity convention.** Many Cat 2a comments and Cat 5 archived
  docs record *real past runs* against Bonus Keefe (observed char lists, char
  positions, e.g. `analysis.ts:946`, "Ch44 pos 37588"). Renaming to Coalfall
  makes them describe a run that never happened. Convention: **replace the
  copyrighted name, keep the illustrative point, and do NOT fabricate
  Coalfall-specific observed values** (genericise the number or mark it
  illustrative). Confirm this reading is acceptable.
- **Server-fixture churn (Cat 4)** is the real cost — some analyzer tests encode
  KotLC-prose-specific expectations; those become owned-manuscript-specific.
  Needs a pass to classify each test pure-rename vs. re-fixture.
- **Cardinality** — KotLC fixtures may name more distinct characters than
  Coalfall's 14 (e.g. a fixture with Sophie+Keefe+Elwin+Biana+Alina+narrator =
  6 is fine, but enumerate the largest before assuming a 1:1 map). Hollow Tide
  rosters (fabricated, owned) absorb the overflow + the series cases.
- **Mapping completeness** — enumerate **every** KotLC name in use (not just the
  top 8: also Biana, Alina, Grizel, Prentice, Dame Alina, etc.) before renaming.
- **Test-pinned prompt (Cat 2b)** — confirm which analyzer tests assert prompt
  substrings before editing `analysis.ts`.

## Effort

Large and cross-cutting (~150+ files), but most is mechanical rename once the
mapping table is fixed. The concentrated-effort core is **Category 4** (server
analyzer fixture re-derivation). Recommend executing phase-by-phase as separate
PRs rather than one mega-change.
