---
status: active
shipped: null
owner: null
---

# 292 — Paragraph-degradation signal: surfacing merged-dialogue paragraphs at import and in the manuscript view (#2254)

> Status: active (landing in this chain; nothing below has shipped yet)
> Key files: `server/src/analyzer/dialogue-structure/legibility.ts`, `server/src/routes/import.ts`, `server/src/routes/book-state.ts`, `src/views/confirm-metadata.tsx`, `src/views/manuscript.tsx`, `src/store/chapters-slice.ts`, `src/lib/api.ts`, `src/lib/types.ts`
> URL surface: the import confirm view; `#/books/<id>/manuscript` (chapter header)
> OpenAPI ops: `POST /api/import` (`ImportCandidate.chapters[].paragraphsMerged`), `GET /api/books/{id}/state` (`BookStateResponse.paragraphsMergedChapters`)

Design of record: [`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`](../superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md) (revision 10, PR #4184). This plan is the durable regression contract. It links the spec instead of copying it, and where the two ever disagree the spec wins. Parent: [#2254](https://github.com/dudarenok-maker/Castwright/issues/2254).

## Benefit / Rationale

- **User:** a Russian dash-dialogue book whose imported text has merged paragraphs (several lines of dialogue run together) gets an honest Heads-up before analysis (at import) and a caption on the affected chapter afterwards, with a suggestion that a different copy or format may do better. Books already in the library get it through the manuscript view.
- **Technical:** the degradation measure (`measureChapterLegibility`, #2267) was computed nowhere in production; it is now a server-side predicate used by both surfaces, and the scanner and the runner reuse the same exports.
- **Architectural:** both notices claim only what the measure counts, so they stay true whoever caused the merge (the source file or Castwright's own extractor). The provisional threshold is explicit in code and docs until the owner-run register row calibrates it.

## Architectural impact

- **Two surfaces, one claim** (Decisions 1 and 2, owner decision 9; spec §3.1, §3.2).
  - **A** is a Heads-up box on the import confirm view (`ImportCandidate.chapters[].paragraphsMerged?: true`, omitted otherwise, no count field).
  - **B** is a per-chapter caption in the manuscript view, computed on `GET /state` (`paragraphsMergedChapters?: number[]`), derived read only, with no `state.json` change.
  - Both claim only what the measure counts: the **imported text** of a chapter has a paragraph with ten or more places where a line of dialogue begins mid-paragraph. The first sentence of each notice is true by construction. The second ("each … would usually start its own paragraph") is a calibration claim, hedged by "usually" (spec §2, AC6 M-6). No notice names a cause or a speaker, and none says Castwright "couldn't check" anything (Decision 2; recovery did reassign some of those lines).
- **The measure and its constants** (spec §2).
  - `measureChapterLegibility` ≥ `MERGED_TURNS_DEGRADED` (10), measured on the **imported text**.
  - `isParagraphDegraded(body, language)` returns `undefined`, never `false`, for an unmeasured language (null, not in `NOTICE_LANGUAGES`, or no conventions): "absent ≠ clean".
  - `NOTICE_LANGUAGES = ['ru']`.
  - The client mirrors `NOTICE_LANGUAGES` and the mock mirrors the threshold, each with a comment naming `legibility.ts` as its source of truth.
  - `TURN_IN_PARAGRAPH` is exported as a fresh-`RegExp` factory, and `countTurnOpeners(body)` sums matches over a chapter; the scanner and runner use them.
- **The threshold is provisional** (owner decisions 3, 13, 15, 17, 21; spec §2, §4.4 step 1). The label is dropped only when the register row's step 1 finds no breach in any scanned book, line-wrapped or not, **and** at least one clean, dialogue-dense ru dash book. Without such a book the threshold stays provisional indefinitely, however many other books the scan holds. The expected outcome (spec §2): the owner's library holds a clean paragraph with 12 openers, so step 1 very likely records a breach and the notice will fire on that clean book. That is the designed path, not a defect.
- **Language scope** (Decision 4).
  - es and fr are excluded and uncalibrated, so they stay operator-log only. `TURN_IN_PARAGRAPH` needs whitespace after the dash, so standard Spanish typography (`—Hola —dijo—.`) can never match, and no real es/fr dash-dialogue source was measured.
  - uk, bg and other Cyrillic books get the notice through detection's ≥ 30% Cyrillic rule. Whether the threshold separates clean from merged text there is an uncalibrated assumption under the provisional label.
- **Under-reading.** The measure splits on `\n`, so line-wrapped imported text (every PDF, hard-wrapped TXT/MD, an EPUB/MOBI that wraps inside `<p>`) under-reads. That is a false negative (a silent notice), never a false positive.
- **What a false positive costs** (spec §2): a Heads-up suggesting a cleaner copy of a book that did not need one. No blocking, no data change, no analysis change.
- **B's guards** (spec §3.2). The key is omitted when the hydrated record is missing, the language is null or out of scope, no non-excluded chapter is flagged, or a `hintsSource: 'parse'` record fails `assertHintsPairWithState(state, hints, parseTitles)`.
  - **Stated residual:** a mispairing confined to synthesized or user-overridden titles still emits.
  - The result is memoised per hydrated record in a `WeakMap` of **unfiltered** ids. Exclusion and the pairing check run **per request**, so a rename, a title override or an exclude toggle takes effect without a re-hydrate. A changed language recomputes.
- **#4217 (F4)** (spec §1.5, owner decision 6). `stripHtml` merges paragraphs in EPUB/MOBI sources whose paragraphs are `<div>`s, so extractor merges are **true positives** for the notice's claim. PR #4318 (the extractor-version fix) is **still open** as this plan is written, so #4217 is described as open here; if it merges first, the spec on `main` describes its extractor-version pin and this plan should cite that.
- **Blocker 1** (spec §4.1–§4.4). Whether recovery changes post-crossExamine speakers, and for the better (1A), is settled by a committed fixture test (§4.2: arms in `analysis.structure-fixture.test.ts`) plus an owner-run measurement on Ночной дозор. The class report is a plain count by class and reason, with **no verdict** (owner decision 14). 1B, 1C and the clean/merged twin are out of scope (owner decisions 10, 14).
- **Committed-fixture limits** (spec §4.5).
  - The Castwright-owned dash text (13 turns) is far too small for an on-box verdict; it feeds the 1A arms and the tools' unit tests.
  - If step 1 scans no clean, dialogue-dense ru dash book, the authored fixtures stay the **only** clean calibration of the threshold, and the threshold stays provisional whatever else the scan finds.
  - Never committed: real books, their text dumps, rosters, saved captures, and the runner's and scanner's reports. Only verdict tables and the scan summary go on #2254 and into the run sheet.
- **Reversibility.** Both fields are additive and optional, nothing is persisted, and neither notice blocks anything. Removing the server predicate calls removes the notices.

## Invariants to preserve

1. `isParagraphDegraded` returns `undefined` (never `false`) for a null, out-of-scope or convention-less language (`legibility.ts`).
2. `NOTICE_LANGUAGES` is `['ru']` and `MERGED_TURNS_DEGRADED` is 10, in `legibility.ts` only; the client constant and the mock threshold each carry a comment naming `legibility.ts` as their source of truth.
3. Notice wording keeps "a paragraph", "ten or more", "places", "mid-paragraph", "imported text" and "usually", never turns places into lines, and never names a cause, a speaker or says Castwright "couldn't check" something.
4. `paragraphsMerged` and `paragraphsMergedChapters` are additive and optional: omitted, never `false` or empty, when there is nothing to say.
5. B's language comes from `bookStateLanguageOrNull(state)`, never the display variant, so an unset language means "not measured".
6. B's memo holds unfiltered ids; chapter exclusion and `assertHintsPairWithState` (caught as `HintsOutOfSyncError` only) run on every request. Excluded chapters are never counted or named.
7. A shows only while the form's selected language is in the client mirror of `NOTICE_LANGUAGES` and at least one non-excluded chapter is flagged; it names up to three titles, then "and N more".
8. The surfaces are static text with no hover-only content and no new touch targets (touch-equivalence rule).
9. No notice or log line asserts a cause, and no register row ID appears in this plan before the row exists.

## Test plan

### Automated coverage

Each item is **landing in this chain** (spec §5 "Paired tests"); none has landed yet at the time of writing.

- **Phase 1 (server, docs):** unit tests beside `legibility.ts`: the 9/10 edge; `undefined` for null, out-of-scope and no-convention languages; `countTurnOpeners` (sum) against `measureChapterLegibility` (max) on one fixture; the `TURN_IN_PARAGRAPH` factory returns a fresh regex.
- **Phase 2:** `server/src/routes/import.ts` route test: merged ru → flag; clean ru → none; es and en → no field.
- **Phase 3:** `confirm-metadata.test.tsx` (shown; hidden after an override to a non-notice language; hidden when only excluded chapters are affected; the "and N more" cap) and `e2e/responsive/paragraph-structure-notice.spec.ts`, with its 375 × 812 chromium case.
- **Phase 4:** `GET /state` route tests (merged ru lists the id; English, null language and a missing record omit the key; excluded chapters omitted, including after an exclude toggle on the same cached record; `parse`-hinted count mismatch and same-count title mismatch omit the key; the same cached record re-emits once `titleOverridden` makes the titles pair, and back; two requests compute once, via a spy on `isParagraphDegraded`; a replaced record recomputes), the `chapters-slice` test, `manuscript.test.tsx`, and an e2e case in the same `responsive/` spec (ch1 → ch2 → ch1 against the mock `/state`).
- **Phase 5:** the characterisation test (5 inputs, one where escalation fills a line; committed before the extraction), a separate new-fields assertion on `onStages`, and the 1A arms 1 and 2 in `analysis.structure-fixture.test.ts`; existing `attributeChapterStage2` tests stay green.
- **Phases 7a–7c:** the scanner tests, the runner tests (capture, pick, swap, re-roll, `--resume`, model refusal; measurement, class report, blind sheet, `--score`), and the aligner tests for `locateSentenceRanges`.
- **Phase 8:** `check:onbox-register` and `register:build` for the register row.

Untested by design: the on-box measurement itself (owner-run, see the register row below).

### Manual acceptance walkthrough

Run in mock mode (`npm run dev:mock`) for steps 1–4.

1. **Import a ru dash book with a merged paragraph** → the confirm view shows the amber "Heads-up:" box naming the affected chapters (up to three, then "and N more").
2. **Change the form's language to English** → the box disappears.
3. **Save the book and open its manuscript view** (`#/books/<id>/manuscript`) → the caption shows on the flagged chapter only, not on clean or excluded chapters.
4. **Toggle a flagged chapter to excluded** → its caption goes away without a reload.
5. **On-box acceptance** is a new Group B register row, added by the last task of this chain (owner-run: false-positive scan, then 1A on Ночной дозор). Its ID is named here once it exists.

## Out of scope

Copied from spec §5 "Out of scope":

- a merge-cost number for clean books (owner decision 10; revision 5's clean/merged twin is withdrawn; if ever wanted, a separate design that starts behind a pilot);
- better-source acquisition;
- changes to the recovery gate;
- #4217's extractor change (its own design pass; the scanner's what-if is diagnostic only);
- recovering bare third-person tags, or re-anchoring tags in dash-open paragraphs (file either only if the register row's 1A points at that lever);
- escalation's compensation for recovery-off flags (spec §4.1 limits);
- script review's use of recovered evidence (spec §4.1);
- es/fr calibration (Decision 4);
- English.

## Ship notes

(Filled in when status flips to `stable`.)
