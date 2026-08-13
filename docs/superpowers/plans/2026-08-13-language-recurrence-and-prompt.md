# Book language: recurrence paths + the ambiguity prompt (#2246 items 3–4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ✅ Blocker 1 RESOLVED — `feat/server-1984-wave1` has landed (PR #2328, `090168a5`)
>
> The sequencing wait is over. This plan was refreshed against current `main` on
> 2026-08-14: **every enumeration grep in Tasks 1, 2 and 6 was re-run with no output
> limit**, and the stale `routes/analysis.ts` line numbers were updated to their current
> values (`5773`/`5806` and `7255`/`7283` for the two persist sites; `3163` for the
> reader site `resolveBookLanguageForManuscript`). The seam call-site total is unchanged
> (**13**). Re-run these greps again in the working branch before any task binds to a
> count — line numbers drift on every merge.
>
> **2. `scripts/repair-missing-book-language.mts` is OFF LIMITS.** Its residual is
> [#2256](https://github.com/dudarenok-maker/Castwright/issues/2256), being implemented
> concurrently. No task here reads from or writes to that file.
>
> **`C:\AudiobookWorkspace` is STRICTLY READ-ONLY** for every task in this plan.

> ## ✅ Task 0 — ANSWERED, 2026-08-13. Both accepted as recommended.
>
> **D-1: "Decide later" ships** (gated Task 10). **D-2: uniform hard-fail** (gated
> Task 6) — no warn-only carve-out for the three voice-design sites. Task 0 is closed;
> **no further design input is owed and every task below is dispatchable.**
>
> **Two consequences to carry, not re-derive:** site 15 follows the uniform rule under
> D-2; and *uniform severity is not a uniform status code* — failure shape stays
> per-route, because a `409` is unreachable at several sites including the detached SSE
> job holding the 25,063-line case. Reading D-2 as "409 everywhere" reintroduces a
> Critical the assumption-checker already caught.
>
> **Blocker 1 is resolved** (1984 merged, PR #2328; line numbers refreshed 2026-08-14).
> The remaining blocker is **#2** — `repair-missing-book-language.mts` stays off-limits
> until #2256 lands. That is a scope constraint, not a design one.

**Goal:** Close [#2246](https://github.com/dudarenok-maker/Castwright/issues/2246) items **3** and **4** — make it impossible for a book to acquire or keep an unstated `language` silently, and give the user a way to set one when detection genuinely cannot decide.

**Already shipped — DO NOT REDO.** Items **1** (`DetectionResult.fallback`, PR #2251) and **2** (the backfill, applied to the live workspace 2026-08-11, 7 books) are complete. `server/src/tts/detect-language.ts` already sets `fallback` on every surrender branch, and `routes/import.ts:149` already puts `languageFallback` on the wire. This plan **consumes** that field; it does not add it.

**Architecture — four layers, in this order, because each depends on the one before:**
1. **Make the seam real** (Task 1). Eleven of 24 state.json writers bypass `writeStateJsonAtomic` today. Until they don't, the type change and the guard both cover about half the tree.
2. **Types** (Task 2). A write-side `BookStateJsonWrite` requiring `language: string | null` makes every *typed* write state the language or state its absence.
3. **A static guard** (Task 7). Enforces that nothing writes state.json outside the seam — closing the paths that write parsed `unknown`/`any`, which types provably cannot.
4. **Readers + UI** (Tasks 6, 8–10). Thirteen call sites stop defaulting, each in its own route's failure shape; the frontend turns that into a way to answer.

**Tech Stack:** TypeScript (Node, ESM), Vitest (server + frontend), Playwright (e2e), React 18 + RTK.

**Design of record:** [`docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md`](../specs/2026-08-13-language-recurrence-and-prompt-design.md). **Read Part 1 before Task 1, Part 3 before Tasks 2 and 7, and Part 2 before Task 6.** Its first draft was revised after an adversarial pass found four critical defects; the "Assumption-checker pass" table records what changed and why. **Do not re-derive any of this from the ticket wording** — the ticket's obvious reading produces a guard that is green today and catches nothing.

---

## Global Constraints

**The four acceptance items, verbatim from #2246:**

> - The seven books carry a `language` after the backfill, and the value is the one
>   detection actually decided — verified by re-running the corpus measurement.
> - A book whose detection surrenders is left unset and named in the report, not
>   written.
> - A new `state.json` write site that omits `language` fails the build, and that guard
>   ships with a neutralisation proof (remove the field, watch it go red).
> - No reader silently substitutes a default on a path where the language changes
>   attribution.

**Items 1–2 are DISCHARGED** by PR #2251 + the 2026-08-11 run. Do not re-run the backfill; do not touch the repair script. **Item 3 is Tasks 1–7. Item 4 is Tasks 8–10.** Both must hold at the end of the branch, not at the task that introduces them — Task 6's failures are only *usable* once Task 9 gives them somewhere to land.

Binding every task:

- **Never write a language you are not sure of.** Post-#2245 `language` selects the quote tables that decide what counts as dialogue (`conventionsFor(lang).quotePairs`), and a non-`'en'` value forces designed Qwen voices and blocks the Kokoro fallback (enforced at `generation.ts:796-815`, `chapter-splice.ts:333-341`). **An unset book that asks is always preferable to a book stamped wrong.** Any task inventing a default has gone wrong.
- **`normaliseBookLanguage` keeps its signature and its default.** Its eight parameter-taking callers are downstream and unchanged. The defaulting is *moved off* thirteen paths, not deleted.
- **No client-facing failure carries a workspace path** — the `requestFailureMessage` rule in `workspace/file-lock.ts`. LAN HTTPS.
- **Every task ships its paired test in the same commit**, and the red must be for the right reason — check the failure *message*, not the exit code.
- **Re-run every enumeration before binding to it.** Three separate counts in the design's first draft were wrong, one because a grep was piped through `head -40`. Each task below states its own grep; run it, and if the count differs from the stated one, stop and reconcile rather than proceeding on a stale table.

---

## Task 0 — Owner decisions

- [ ] **D-1 — May the confirm screen offer "Decide later"?** *(gates Task 10)*
  **Recommended: yes.** A surrendered detection means the system doesn't know; the user importing a file someone sent them may not either. Forcing a choice is how you get a shrugged "English" — the exact bad write this ticket exists to stop. "Decide later" writes `null`; the gate stops the book at analysis, where the user is far better placed to answer.
  *Alternative:* force the choice at import. Buys a smaller surface, not a simpler system — `null` handling is needed for bundle/sample/restore paths regardless.

- [ ] **D-2 — Uniform hard-fail across the CHANGE list, or warn on the three voice-design sites?** *(gates Task 6)*
  **Recommended: uniform**, within each route's own failure shape (the tier table in Task 6 — the *mechanism* is fixed by route shape; this decision is about *severity* only).
  *Alternative:* warn at `cast-design`/`qwen-voice`/`single-design`, since a wrong language word yields an audibly wrong voice rather than silently wrong data. Real position; the "self-evident" claim is unmeasured.

---

## Task 1 — Make the seam real (PREREQUISITE — nothing else is sound without it)

**Files:** `audio/finalize-chapter-write.ts`, `cover/store.ts`, `cover/upload.ts`, `routes/analysis.ts`, `routes/generation.ts`.

Nine state.json writers bypass `writeStateJsonAtomic` via an extracted path:
`writeJsonAtomic(statePath, stampStateSchema(next))`. **The type change in Task 2 reddens none of them** (`stampStateSchema` is `<T extends BookStateJson>`, `writeJsonAtomic` takes `unknown`), and a guard keyed on adjacency matches none of them either.

- [ ] Confirm the population first:

```
grep -rn "writeJsonAtomic(statePath\|writeJsonAtomic(path\|writeJsonAtomic(stateJsonPath" --include=*.ts server/src | grep -v "\.test\.ts"
```

Expected (re-measured 2026-08-14): `finalize-chapter-write.ts:398`, `cover/store.ts:97,107`, `cover/upload.ts:111,129`, `analysis.ts:5806,7283`, `generation.ts:1453,2239` (nine), plus `auto-backup.ts:215` (Task 5). **`book-state.ts:1778` is `listenStatsJsonPath`, not state.json — leave it.** The same pattern also matches four NON-state.json writers that happen to use a `path`/`statePath` local — `render-integrity/embeddings-io.ts:36`, `render-integrity/verdicts-io.ts:27,82`, `cast-merge-base.ts:119`, `queue-migrate.ts:80` — they write other JSON and must NOT be routed through the seam.

- [ ] Convert each of the nine to `writeStateJsonAtomic(statePath, next)`, dropping the now-redundant `stampStateSchema` call (the seam stamps internally).
- [ ] **Verify:** `cd server && npm run test && npm run test:server-slow` green — these are hot paths (chapter finalise, cover write, analysis persist, generation persist) and this task changes nothing but the writer. Any behaviour change here is a bug in the conversion, not an intended effect.
- [ ] **Verify the seam is now total:** the grep above returns only `auto-backup.ts:215`.

---

## Task 2 — `BookStateJsonWrite`: make the write type require the field

**Files:** `workspace/state-migrate.ts`, plus every seam caller.

- [ ] Add `BookStateJsonWrite` and change `writeStateJsonAtomic`'s parameter, with the design's doc comment (why `undefined` must not be expressible).
- [ ] Run `npm run typecheck` and **record the exact red count and site list in the task report.** After Task 1 the seam has 22 callers; expect red at every one that spreads a `BookStateJson`. If the list does not match the design's Part 1 table plus Task 1's nine, stop and reconcile.
- [ ] Fix the spread sites with `language: prev.language ?? null` (matching each site's local variable name). **Semantically exact:** carries a stated language forward, and carries absence forward *as an explicit null* rather than as a silence.
- [ ] **Two hazards — do not apply the recipe blindly:**
  - **`scan.ts:1054-1064`** is written *and returned twice*, from a function typed `Promise<{ state: BookStateJson; … }>`. Retyping it reddens both returns; adding `language:` to a `BookStateJson`-annotated literal is itself an error. Needs two objects or a widened return type. Same shape at `book-state.ts:230` and `chapters-restructure.ts:171`.
  - **Four seam calls pass a bare `state` variable, not a literal** — `book-state.ts:249`, `library-sync-manifest.ts:58`, `scan.ts:711`, `samples.ts:110`. They need `{ ...state, language: state.language ?? null }`, **which changes object identity** for callers relying on mutation-in-place (`ensureChapterUuids(state)` at `book-state.ts:248`, and the equivalents at `library-sync-manifest.ts:56`, `scan.ts:710`). Check each caller.
- [ ] **Leave `import.ts` for Task 3** — the one true mint needs a real decision, not a `?? null`.
- [ ] **Verify:** `npm run typecheck` green, then mutations **M1** and **M2** below (Task 7's table), each reverted, with the compiler message recorded per site.

---

## Task 3 — R1: import stops stamping a guess

**Files:** `routes/import.ts`, `routes/import.test.ts`.

> **#2337 review N4 (2026-08-13) — this PR already shipped the first bullet and
> HALF the implement line, before this task was ever dispatched.** `#2335`/PR
> `#2337` landed independently of this plan and covers the confident-detection
> half of this task's scope. **What is already done, verbatim against the
> bullets below:**
>
> - [x] **"Persist `detected.fallback` (and the detected language) on the
>   staging entry"** — done. `StagedImport` (`store/import-staging.ts`) carries
>   `detectedLanguage` / `detectedLanguageSupported` / `detectedLanguageFallback`,
>   written at `routes/import.ts:135-136` (`detected.supported` /
>   `detected.fallback`) and read back in the confirm handler at
>   `routes/import.ts:308-313`.
> - [x] **Implement, "Absent + `fallback: false` → the detected language"** —
>   done: `!languageChosen && entry.detectedLanguageSupported &&
>   !entry.detectedLanguageFallback ? normaliseBookLanguage(entry.detectedLanguage)
>   : …` (`routes/import.ts:310-313`).
> - [x] Failing test **"writes the DETECTED language when the request states
>   none but detection was confident"** — **this is now GREEN before this
>   task's implementer would ever write a line**, because the behaviour it
>   pins already shipped. A scaffolded red-phase test that is already green is
>   a defect in the plan itself (a test that cannot fail proves nothing) — it
>   is not evidence Task 3 is complete, only that ONE of its four sub-cases
>   is. It stayed in the plan as a regression pin, not a red-phase target.
> - [x] "still writes and validates an explicitly stated language" and "still
>   rejects an explicitly stated unsupported language with 400" — pre-existing
>   #1955 behaviour, untouched by #2337, already covered by
>   `import.test.ts`'s `describe('POST /api/books — unsupported language
>   rejected at the import boundary (#1955)', …)`.
>
> **What is NOT done — the only thing an implementer still needs to build:**
>
> - [ ] **"Absent + `fallback: true` → `null`."** Today the fallback-gate
>   condition at `routes/import.ts:310-313` falls through to
>   `normaliseBookLanguage(body.language)` on a surrendered detection, and
>   `normaliseBookLanguage(undefined)` is `'en'` — the historical default, not
>   `null`. This is a **deliberate, documented** interim choice (see
>   `routes/import.ts`'s "NOT-A-FALLBACK" comment, and #2337 review N1, which
>   corrected that comment's claim about which conditions are load-bearing),
>   not an oversight — but it is exactly what this plan's `R1` design (state
>   an explicit `null` rather than silently deciding `'en'`) still calls for.
> - [ ] Failing test **"writes language: null when detection surrendered and
>   the request states none"** is still red and is this task's real
>   remaining target.
>
> **Re-scoped implement step:** `body.language` stated → today's
> normalise-then-gate, verbatim (unchanged). Absent + `fallback: true` → `null`,
> skipping `isSupportedLanguage` (nothing to validate). Absent + `fallback:
> false` → the detected language (**already shipped, do not re-implement —
> just don't regress it**).
> - [ ] **Verify:** `cd server && npx vitest run src/routes/import.test.ts`,
>   including the pre-existing #1955 cases AND #2337's own new cases (the
>   blank-language class test, the non-string-`language` 400 test, and the
>   coerced-Latin-detection fallback tests in `tts/detect-language.test.ts`) —
>   this task must not regress any of them.

---

## Task 4 — R5: the sample-bundle installer

**Files:** `routes/samples.ts`, its test.

`samples.ts:64` does `const bundleState = JSON.parse(...)` → `:104` `{ ...bundleState, bookId, … }` → `:110` `writeStateJsonAtomic(...)`. **Spreading an `any` into the new write type compiles clean** (design Part 3, probe case 6), so Task 2 cannot reach this. R2's twin: it reinstates a pre-fs-2 unset book from a parsed bundle.

- [ ] Failing test: installing a sample whose bundled `state.json` has no `language` must produce `language: null` on disk, not a missing key and not `'en'`.
- [ ] Implement: parse into a typed shape and set `language: bundleState.language ?? null` explicitly.
- [ ] **Verify:** test green; `npx vitest run src/routes/samples.test.ts`.

---

## Task 5 — R2 + R3: the two untyped writers

**Files:** `import/scan-import-folder.ts`, `workspace/auto-backup.ts`, their tests.

- [ ] **R2 — bundle import** (`scan-import-folder.ts:253`). Failing test: a bundle whose `state.json` has no `language` must produce `language: null` on disk. Implement by normalising the parsed state's language before `JSON.stringify`, alongside the existing `title`/`author`/`manuscriptFile` validation above it.
- [ ] **R3 — backup restore** (`auto-backup.ts:215`). Failing test: restoring a snapshot with no `language` must produce `language: null` **and** a `schema` stamp. Implement by routing through `writeStateJsonAtomic` after normalising.
  **This fixes a second, pre-existing defect in the same line:** the bare call also skips `stampStateSchema`, so restore has been writing unstamped state.json files. A chore this work surfaced — fix it here and declare it in the PR body; do not file it for later.
- [ ] **Verify:** both tests green; `cd server && npm run test`.

---

## Task 6 — The thirteen readers stop defaulting

**Files:** the 13 CHANGE sites in the design's Part 2, plus a test per shape.

> **Gated on D-2** (severity only — the mechanism below is fixed by route shape).

- [ ] Re-run the enumeration first — **no output limit**:

```
grep -rn "bookStateLanguage(" --include=*.ts --include=*.tsx server/src src | grep -v "\.test\.ts" | grep -v "export function"
```

Expected 19 sites / 15 files. If not, reconcile against the design's Part 2 before touching anything.

- [ ] Add `bookStateLanguageOrNull`, `requireBookStateLanguage`, `BookLanguageUnsetError` to `workspace/scan.ts`, with tests in the existing `workspace/book-state-language.test.ts`:

```ts
it('returns null when the key is absent — absence is a fact, not English', () => {
  expect(bookStateLanguageOrNull(makeStateBase())).toBeNull();
});
it('returns null for empty and whitespace-only values', () => { /* '' and '   ' */ });
it('throws BookLanguageUnsetError when unset', () => {
  expect(() => requireBookStateLanguage(makeStateBase())).toThrow(BookLanguageUnsetError);
});
it('the message carries no filesystem path — it is client-facing', () => {
  try { requireBookStateLanguage(makeStateBase()); } catch (e) {
    expect((e as Error).message).not.toMatch(/[A-Za-z]:\\|\/(Users|home|AudiobookWorkspace)/);
    expect((e as Error).message).toContain('Book settings');
  }
});
```

- [ ] **Apply the tier table — one shape per route, never one shape for all:**

| Tier | Sites | Shape |
|---|---|---|
| Pre-flight | `chapter-splice:333`, `chapter-qa-repair:158`, `:311`, `cast-merge:155` *(provisional)* | `409 { error: 'language_unset' }` |
| Streaming | `cast-design:768`, `single-design:304`, `qwen-voice:578` — all three **already** `send({type:'error', code:'unsupported_language'})` then `res.end()`; plus `generation:796` | `{ type: 'error', code: 'language_unset' }` in each route's **existing** envelope |
| Batch | `script-review:772`, `:843` | `itemFailureReason` inside the 200/207, per CLAUDE.md's five-batch-route rule. **A whole-request 409 is wrong here.** |
| Fail-closed value | `scan.ts:813` | emit `eligibleTtsEngines: []` when the language is null — **never throw**, or one unset book breaks the whole library scan |
| Pure resolver | `series-cast-scan.ts:96` | return `null`; `voice-match.ts:307,310` and `series-reuse-link.ts:259,305` treat null as "cannot prove same language → veto" |

- [ ] **`analysis.ts:3163` needs its own treatment — a naive swap is a no-op.** `resolveBookLanguageForManuscript` (`:3160-3167`) wraps the call in `try { … } catch { return 'en' }`, inside the *detached* analyzer loop where there is no `res`. Three moves: (a) put the gate in the **POST handler before the job detaches**, where a 409 is returnable; (b) **keep `'en'` for the `located === null` branch** — that is pre-confirm, no book on disk, and "Choose it in Book settings" is nonsense there; (c) if the in-loop path is kept, emit an SSE `error` with `code: 'language_unset'` via `classifyAnalysisFailure`. **A test that only asserts "the call site changed" passes on the no-op** — assert the observable outcome.
- [ ] **`cast-merge.ts:155` is provisional.** Verify what the language actually drives; if it only localises a synthesised bucket's display name, it moves to STAY. Do not swap it blind.
- [ ] **Do NOT change `voice-library.ts:1672`.** Its comment at `:1658-1670` records a deliberate decision against letting a language throw escape ("a NEW 500 on an existing, previously-working route", #1953/#1955); the value only computes a mismatch **warning**, and the site already catches. It is STAY.
- [ ] **Verify:** a test per tier for an unset book, **plus the control that matters** — a book *with* a language is unaffected at every site. `cd server && npm run test && npm run test:server-slow`.

---

## Task 7 — The static guard

**Files:** new `server/src/workspace/state-language.guard.test.ts`.

**Read the design's "The static guard" section first.** Build it in the `cast-lock.guard.test.ts` idiom, reusing `skipOpaqueToken` / `computeOpaqueRanges` / `isOpaque`.

- [ ] **G1 — seam exclusivity, FILE-scoped not adjacency-scoped.** In any file mentioning `stateJsonPath`, **every** `writeJsonAtomic(` occurrence is a finding unless the file is `state-migrate.ts`. Adjacency (`writeJsonAtomic(` next to `stateJsonPath(`) matches **none** of Task 1's nine — the extracted-path idiom is the dominant one here. Allowlist files that legitimately write other JSON alongside (e.g. `book-state.ts`'s `listenStatsJsonPath` at `:1778`) with a count and a reason.
- [ ] **G2 — no raw serialisation into the state path.** `planEntry`/`writeFile` with a `Buffer`/`JSON.stringify` against `stateJsonPath(`, **plus** hand-built `join(<any args>, 'state.json')` — a two-arg-only pattern misses `samples.ts`'s three-arg `join(src, '.audiobook', 'state.json')`.
- [ ] **G3 — fail closed on absent evidence.** Floors **≥35 occurrences / ≥19 files** (measured 2026-08-13: **43 across 22**), **plus a per-file expected-count map so aliasing any single file reddens.** A bare global floor is too slack to be breached by a realistic mutation — that is what M5 proves.
- [ ] Allowlist keyed on **file AND count**, asserted in **both directions**. After Tasks 1–5 the intended allowlist holds only the legitimate-other-JSON entries.
- [ ] Header declares the blind spots verbatim from the design: aliased writer/path imports; concatenated paths; **spread-of-`any`/`JSON.parse` — blind to *both* type and guard**; call-graph indirection; template-literal `${…}`; and **`scripts/*.mjs`/`*.mts` outside `server/src` — the live one, since `repair-missing-book-language.mts` writes state.json and this guard cannot see it.**
- [ ] **Neutralisation proof — each run individually, others reverted, and the red must NAME the mutated file:**

| # | Mutation | Must redden |
|---|---|---|
| M1 | Delete `language` from `import.ts`'s mint literal | `npm run typecheck` |
| M2 | `language: undefined` at **every site on the corrected list, one at a time** | `npm run typecheck` — **one row per site** |
| M3 | Add a bare `writeJsonAtomic(p, s)` to a `stateJsonPath`-mentioning file | G1 |
| M4 | Revert `scan-import-folder.ts` to stage the un-normalised buffer | G2 |
| M5 | Alias `stateJsonPath` in **one** file | G3's per-file map |
| M6 | Revert one of Task 1's nine to `writeJsonAtomic(statePath, …)` | G1 |

- [ ] **M2 is an all-sites table, not one row.** One site reddening is not all sites reddening — `f_one_instance_not_all`, already in this repo's memory index.
- [ ] **Negative control — must stay GREEN:** a prose comment quoting `writeJsonAtomic(stateJsonPath(` verbatim *and* a string literal containing `join(dir, 'state.json')`, no code change. A guard reddening here over-matches and will be reverted by the next person it blocks.
- [ ] `git diff` empty of mutations before commit; full log in the task report and the PR body.

---

## Task 8 — The wire signal

**Files:** `workspace/scan.ts`, `openapi.yaml`, `src/lib/api-types.ts` (generated), `src/lib/types.ts`.

- [ ] Add `languageSet: boolean` to `LibraryBook` (design **W-1**: additive, not a nullable `language`). `scan.ts:812` keeps emitting the display value; `scan.ts:813` emits `eligibleTtsEngines: []` when unset (Task 6).
- [ ] `openapi.yaml` §`LibraryBook` — the description must say plainly that `language` is a resolved display value and `languageSet` is the honest signal, so a future consumer cannot read `language` and be misled.
- [ ] **Regenerate `src/lib/api-types.ts` via `npm run openapi:types` in the same commit** — a stale generated artifact is a chore this change makes owed, not a follow-up.
- [ ] **Verify:** `npm run typecheck`; a `scan.ts` test asserting `languageSet` and the empty eligible set for an unset book, and both correct for a set one.

---

## Task 9 — Frontend B + C: settings row and the blocking prompt

**Files:** `routes/book-state.ts`, `openapi.yaml`, `src/views/book-library.tsx`, the book-settings surface, the modal, + tests.

- [ ] **Server first — `PUT /api/books/:bookId/state` does NOT accept `language` today.** Its `state` slice builds `next` from an explicit whitelist (`book-state.ts:816-847`) that never references `patch.language`; a `language` sent today is **silently dropped**. Add the whitelist entry **and its validation** (the import path gates via `isSupportedLanguage`; this path gates nothing), plus the `openapi.yaml` change. Paired test: a PATCH with `language` round-trips, and an unsupported one is rejected.
- [ ] Library card shows an "unset" affordance in place of the language badge when `languageSet === false`.
- [ ] Book settings gains a language row writing through that PATCH.
- [ ] Every Task 6 failure shape — `409`, the SSE `error` event, and the batch `itemFailureReason` — opens that row as a modal, prefilled with **nothing**, retrying on save. **Key on all three, not just the 409.**
- [ ] **Verify:** RTL tests per surface, **plus a Playwright e2e spec** — this crosses router/redux/layout seams, so CLAUDE.md requires one. Add a case to `e2e/responsive/coverage.spec.ts` if a new view surface lands.

---

## Task 10 — Frontend A: the import-time signal

**Files:** `src/views/confirm-metadata.tsx`, `src/views/confirm-metadata.test.tsx`.

> **Gated on D-1.**

`candidate.languageFallback` is **already on the wire and read by nothing** — `src/lib/types.ts:202`, `src/lib/api-types.ts:3791`, written at `routes/import.ts:149`.

- [ ] When `languageFallback === true`, render the selector with **no pre-selection** and an explicit "We couldn't tell — pick the language" note. Today `:37-38` seeds `candidate?.language ?? 'en'`, so a surrender is indistinguishable from a confident English detection.
- [ ] On the recommended D-1 answer, add **"Decide later"**, submitting no language (→ Task 3's `null`).
- [ ] **Verify:** RTL tests for both branches. **The control matters most:** a confident detection (`languageFallback: false`) must still pre-select exactly as today — the prompt fires on genuine ambiguity, not on every import, and this is the test that proves it.

---

## Task 11 — Ship

- [ ] `docs/release-notes-next.md` (technical, PR-refed) **and** the user-facing line in `RELEASE_NOTES.md`'s in-progress section.
- [ ] Spec `status:` → `stable` with Ship notes (date + SHA). **Add both documents to `docs/features/INDEX.md`** — it indexes `docs/superpowers/specs` entries (25 references today), so an unlisted spec is drift.
- [ ] **Re-confirm the inherited assumption**: that the seven backfilled values were verified by re-running the corpus measurement (#2246 acceptance item 1). This plan assumes it; nothing in it has re-checked it.
- [ ] **On-box acceptance row.** End-to-end behaviour on a real book — an unset book hitting the gate, the prompt resolving it, analysis then selecting the right conventions table — needs a live analyzer and (for the three design sites) a live sidecar. Add the row to `docs/testing/onbox-acceptance-register.md`, the run-sheet criteria, **and update the live view** per the register's four-step procedure (edit `onbox-acceptance-register-live-view.html`, run `npm run check:onbox-register -- --against-published <saved copy>`, publish to the URL already in the register header). **Recording blocks the merge; running does not.**
- [ ] `npm run verify:fast:branch`, then the PR with `Closes #2246`.
- [ ] `pr-review-gate` — **not** docs-only, so the gate applies. Effort `high` (multi-scope).
