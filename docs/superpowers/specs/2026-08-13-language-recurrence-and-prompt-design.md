---
status: draft
date: 2026-08-13
issue: 2246
---

# Book language: closing the recurrence paths, and asking the user when detection cannot decide

Design of record for the **remaining half of #2246** — scope items **3** (close the
recurrence paths) and **4** (a way for the user to set or correct a book's language
when detection cannot decide).

> **This document was revised after an adversarial pass** that found four critical
> defects in its first draft, three of which would have shipped a guarantee covering
> roughly half the write sites it claimed. Every finding and its disposition is
> recorded in "Assumption-checker pass" at the end. Where a claim below is a
> *measured* number, the measurement command is stated with it — the first draft was
> wrong about four separate counts, one of them because a `grep` was piped through
> `head -40`.

> **Re-verified against current `main` on 2026-08-14**, after `feat/server-1984-wave1`
> merged (PR #2328). Every enumeration in Parts 1–3 was re-run with no output limit; the
> only drift was **line numbers in `routes/analysis.ts`** (see the corrected cells below)
> and the **G3 count (43/22 → 45/23)**. Neither changes a decision. Line numbers were
> current for `main` at the time of this refresh; re-run the plan's greps before any task
> binds to them.

## Already shipped — do not re-plan

| # | Scope item | State |
|---|---|---|
| 1 | `DetectionResult.fallback`, additive, set on both surrender branches | **Shipped, PR #2251.** `server/src/tts/detect-language.ts`; both surrender branches return `resultFor('en', true)`, as do `voteLanguage`'s three surrender exits. |
| 2 | Backfill for books with no `language` | **Shipped, and applied to the live workspace 2026-08-11**, writing 7 books. `scripts/repair-missing-book-language.mts`. |

`scripts/repair-missing-book-language.mts` is **out of scope** — its residual is #2256,
being implemented concurrently. Nothing here may touch that file.

**Unverified inheritance, stated as such:** the ticket's first acceptance bullet asks
that the seven written values be confirmed by re-running the corpus measurement. This
design assumes that run happened; it has not re-confirmed it. Everything below that
says "practical blast radius is near zero" rests on that assumption, and the plan's
acceptance section re-opens it rather than inheriting it silently.

## Problem

**A wrong language now costs more than a missing one.** After #2245, `language`
selects the quote tables that decide what counts as dialogue
(`conventionsFor(lang).quotePairs`), and a non-`'en'` language forces every character
onto a designed Qwen voice and blocks the Kokoro cross-language fallback — enforced at
`server/src/routes/generation.ts:796-815` and `server/src/routes/chapter-splice.ts:333-341`.
*(The `scan.ts:222-231` doc comment describes this; the enforcement is at those two
sites. Citing the comment as the mechanism is the repo's own
`f_guard_built_from_the_doc` shape and the first draft did it.)*

**The system cannot currently express "we don't know."** `state.language` is
`language?: string`. Absence and "English" are the same value to every reader, because
`bookStateLanguage` (`scan.ts:335`) delegates to `normaliseBookLanguage`
(`tts/language.ts:23`), which is `primary || DEFAULT_LANGUAGE`. Seven live books
holding 62.8% of the corpus were told "English" for a field nobody set.

Those two facts point the same way, and it is the governing principle of this document:

> **Prefer leaving a book unset and reporting it over writing a value you are not sure
> of.** An unset book that asks the user is recoverable. A book confidently stamped
> wrong is not, because nothing downstream will ever question it.

---

## Part 1 — Where the recurrence actually lives

### The finding that reshapes item 3

The ticket asks for "a build-failing guard on write sites that omit `language`." The
obvious reading — *every `BookStateJson` object literal must contain a `language:`
key* — **would be green today and would catch none of the five real recurrence
paths.** Stating that before the design, not after.

Every site in `server/src` that mints a `BookStateJson` object literal:

| Site | Shape | Omits `language`? |
|---|---|---|
| `routes/import.ts:302` | **true mint** (fresh literal) | **Yes — the only literal that can.** |
| `audio/finalize-chapter-write.ts:378` | `{ ...prev, … }` | No — spread carries it |
| `routes/analysis.ts:5773`, `:7255` | `{ ...prev, … }` | No |
| `routes/book-state.ts:224, 816, 1022, 1352, 1440` | `{ ...state, … }` | No |
| `routes/generation.ts:1438`, `:2221` | `{ ...prev, … }` | No |
| `workspace/scan.ts:1054` | `{ ...state, chapters: next }` | No |

**Eleven of twelve are read-modify-write spreads.** They cannot omit the key — but
they equally cannot *supply* it, so they propagate absence forward indefinitely. A
literal-shaped guard would find them all compliant and be correct to.

### The five paths absence actually enters

**R1 — `routes/import.ts:239, 302`.** `normaliseBookLanguage(body.language)`: an import
omitting `body.language` gets `'en'` stamped **as a decision**. The key is always
present, so a "must contain `language:`" guard passes. **The worst path** — it does not
leave the book unset, it writes a guess indistinguishable from a decision.

**R2 — `import/scan-import-folder.ts:253`.** Bundle import re-serialises a state.json
parsed from an uploaded ZIP via `planEntry(stateJsonPath(bookDir), Buffer.from(JSON.stringify(state, …)))`.
Validation above it checks `title`/`author`/`manuscriptFile` only. **A bundle exported
before fs-2 reinstates an unset book, today.** No literal, no `writeStateJsonAtomic`.

**R3 — `workspace/auto-backup.ts:215`.** `writeJsonAtomic(stateJsonPath(bookDir), value, …)`
where `value` is `unknown` from `JSON.parse`. Restoring a pre-fs-2 snapshot un-sets a
book the backfill just fixed. Also skips `stampStateSchema` — a pre-existing
schema-seam hole in the same line.

**R4 — nine extracted-path writers that bypass the seam.** *(Found by the adversarial
pass; the first draft asserted R3 was "the one" bypass and was wrong by nine.)* These
write state.json as `const p = stateJsonPath(dir); … writeJsonAtomic(p, stampStateSchema(x))`:

| Site |
|---|
| `audio/finalize-chapter-write.ts:398` |
| `cover/store.ts:97`, `:107` |
| `cover/upload.ts:111`, `:129` |
| `routes/analysis.ts:5806`, `:7283` |
| `routes/generation.ts:1453`, `:2239` |

**This is decisive, and it is why Task 1 of the plan exists.** `stampStateSchema` is
`<T extends BookStateJson>(state: T)` (`state-migrate.ts:98`) and `writeJsonAtomic`
takes `unknown`, so **a write-side type on `writeStateJsonAtomic` reddens none of these
nine.** A guard keyed on `writeJsonAtomic(` *adjacent to* `stateJsonPath(` matches none
of them either, because the path is an extracted local. The first draft listed
"extracted path variable" as a theoretical blind spot; it is in fact **the dominant
write idiom in this repo**.

**R5 — `routes/samples.ts:104-110`, a spread of `any`.** The sample-bundle installer
does `const bundleState = JSON.parse(await readFile(…))` → `const state = { ...bundleState, bookId, … }`
→ `writeStateJsonAtomic(stateJsonPath(bookDir), state)`. It **does** go through the
seam, and it is **still** invisible to the write type: spreading an `any` into a typed
parameter slot compiles clean under this repo's config (verified — see the probe table
in Part 3, case 6). R2's exact twin, reinstating a pre-fs-2 unset book from a parsed
bundle.

### Measured seam coverage

`writeStateJsonAtomic` has **13 call sites**; there are **24 state.json writers** in
`server/src`. So **11 bypass the seam** (R2, R3, and R4's nine).

```
grep -rn "writeStateJsonAtomic(" --include=*.ts server/src | grep -v "\.test\.ts" | grep -v "export async function"   # 13
grep -rn "writeJsonAtomic(statePath\|writeJsonAtomic(path\|writeJsonAtomic(stateJsonPath" --include=*.ts server/src   # R3 + R4
```

The 13 seam calls: `book-state.ts:230, 249, 941, 951, 1029, 1357, 1445` (**seven**),
`chapters-restructure.ts:171`, `import.ts:324`, `library-sync-manifest.ts:58`,
`samples.ts:110`, `scan.ts:711`, `scan.ts:1056`.

**The seam is not a seam yet.** The first draft's load-bearing sentence — *"the guard
enforces that nothing writes state.json outside the sanctioned seam, which is what
makes the type check total"* — was asserted, not achieved. **Making it true is
prerequisite work, not a side effect**, which is why the plan opens with migrating
R4's nine onto `writeStateJsonAtomic` before the type or the guard claims anything.

### The read side has no choke point either

`migrateStateJson` is the migration seam, yet **24 sites across 14 files** read
state.json with a bare `readJson<BookStateJson>(…)` that never touches it —
`routes/voices.ts` ×3, `routes/analysis.ts` ×2, `routes/generation.ts` ×2,
`routes/book-state.ts` ×2, `cover/store.ts` ×2, `cover/upload.ts` ×2,
`workspace/scan.ts` ×2, `workspace/series-cast-scan.ts` ×2, plus
`audio/finalize-chapter-write.ts`, `audio/render-integrity/aggregate.ts`,
`workspace/active-analyses.ts`, `workspace/library-cast-scan.ts`,
`workspace/series-full-cast-scan.ts`, `workspace/series-reuse-link.ts`,
`workspace/voice-library-usage.ts`.

**Any design making `language` required on the *read* type asserts a lie about disk at
all 24.** A type that lies is worse than an optional one — it disables the `?.`/`??`
the reader would otherwise have written. Decisive for **T-1** below.

Routing all 24 through the migration seam would make a single required type sound, but
that is far larger than #2246 asks, and it is a *pre-existing* gap this work surfaced
rather than created. Named as a residual and deliberately not attempted; the split-type
design is sound **without** depending on a read-path invariant that does not hold.

---

## Part 2 — The caller enumeration and the change/no-change split

`bookStateLanguage` has **19 production call sites across 15 files**, via
`grep -rn "bookStateLanguage(" server/src src` **with no output limit**.

> **Method note, because it changed the answer twice.** The first pass was piped
> through `head -40` and silently lost the tail, missing `series-cast-scan.ts:96`. The
> adversarial pass then moved two more sites across the line. An enumeration a later
> task binds to must be produced without a row limit and its total stated. **Re-run the
> ungated grep before the reader task** — `feat/server-1984-wave1` will move these line
> numbers.

The split test: **does a wrong answer here change what the user gets, or only what a
label says?**

### CHANGE — 13 sites

| # | Site | What the language decides |
|---|---|---|
| 1 | `routes/analysis.ts:3163` | Analyzer language; post-#2245 the dialogue conventions table. **The 25,063-line path.** See the special handling below — this one is not a simple swap. |
| 2 | `routes/generation.ts:796` | `resolveEligibleEngines` + non-English Qwen forcing |
| 3 | `routes/chapter-splice.ts:333` | Same engine routing at splice time |
| 4 | `routes/chapter-qa-repair.ts:158` | ASR language hint. **Weakest of the set** — `isNonEnglish(x) ? x : undefined`, and unread unless `SEG_ASR_ENABLED`. Changes QA verdicts (hence repairs) when on. |
| 5 | `routes/chapter-qa-repair.ts:311` | Repair-time book language (re-synth) |
| 6 | `routes/cast-design.ts:768` | `sidecarLanguageName` → Qwen design word |
| 7 | `routes/qwen-voice.ts:578` | Same |
| 8 | `routes/single-design.ts:304` | Same |
| 9 | `routes/cast-merge.ts:155` | **Provisional.** Verify at implementation: if it only localises a synthesised bucket's *display name*, it moves to STAY. Do not swap it blind. |
| 10 | `routes/script-review.ts:772` | Script-review language |
| 11 | `routes/script-review.ts:843` | Script-review language (per-item) |
| 12 | `workspace/series-cast-scan.ts:96` | **`resolveBookLanguageForBookId` — the cross-language voice-reuse veto.** A Qwen voice bakes its design language into the on-disk `.pt`; reuse across a language boundary produces garbled audio (fs-61). Consumers: `routes/voice-match.ts:307,310`, `workspace/series-reuse-link.ts:259,305`. Two `'en'`-defaulted books match each other and the veto silently passes. |
| 13 | `workspace/scan.ts:813` | **`resolveEligibleEngines` for the wire's `eligibleTtsEngines`.** Not advisory — see below. |

**Site 12's `'en'` is doubly wrong.** Its doc comment (lines 88–93) calls the default
"conservative", which it is for the *unresolvable-bookId* case it was written for. For
a book that exists and never stated a language, `'en'` is an assertion that *unlocks* a
reuse the veto exists to block. Keep `'en'` for the unresolvable branch; the
resolved-but-unset branch changes.

**Site 13 is client-authoritative, not display.** `eligibleTtsEngines` gates real
controls: `selectHasNoFallbackEngine` (`src/store/voice-readiness-selectors.ts:90-101`)
**removes the "Proceed anyway" button** in `src/modals/voice-readiness-gate.tsx:42`;
`lockedToQwen` (`src/modals/profile-drawer.tsx:320`) forces the per-character engine
default; `pickerEngines` (`:323-325`) filters which engine options render. An unset book
resolves to `'en'` and gets the **most permissive** eligible set. **Treatment differs
from the other twelve:** rather than throwing, emit `eligibleTtsEngines: []` when the
language is null, so all three consumers fail *closed*. Throwing here would break the
whole library scan for one unset book.

**Site 1 is not a simple swap, and treating it as one is a no-op.**
`resolveBookLanguageForManuscript` (`routes/analysis.ts:3160-3167`) is:

```ts
try {
  const located = await findBookByManuscriptId(manuscriptId);
  return located ? bookStateLanguage(located.state) : 'en';
} catch { return 'en'; }
```

Three distinct problems:
1. **The existing `catch` swallows the new throw.** Substituting `requireBookStateLanguage`
   without touching the catch produces *exactly zero* behaviour change — the repo's own
   `f_success_reported_while_doing_nothing` shape, and it would pass any test asserting
   only "the call site changed."
2. **There is no `res` here.** The function runs in the detached analyzer loop
   (header, lines 3080–3089); the HTTP response is long gone. A `409` is not returnable.
3. **The `: 'en'` branch is a different defect.** Its comment says analysis can run
   pre-confirm — *no book on disk yet*. Hard-failing that with "Choose it in Book
   settings" is nonsense; there is no book to open settings on.

**Correct handling:** the gate belongs in the **POST handler before the job detaches**,
where a `409` is returnable; the `located === null` branch keeps `'en'`; and the
in-loop path emits an SSE `error` with `code: 'language_unset'` via
`classifyAnalysisFailure`, per the lock-timeout precedent CLAUDE.md documents.

Sites 6–8 pass into `sidecarLanguageName`, which **already throws** for an unregistered
language. It does not throw for an absent *book* language, because
`normaliseBookLanguage` turns that into `'en'` — a registry hit. Today's fail-loud net
is disarmed by the very defaulting this removes.

### STAY — 6 sites

| # | Site | Why |
|---|---|---|
| 14 | `workspace/scan.ts:812` | `LibraryBook.language` — the badge/filter display value. Changes no attribution. Gains an additive honest sibling — see **W-1**. |
| 15 | `routes/voice-library.ts:1672` | **Moved here by the adversarial pass.** The comment at `:1658-1670` records a deliberate decision *against* exactly this: letting a language throw escape "would be a NEW 500 on an existing, previously-working route" (#1953/#1955). The value only computes `expectedSidecarLang` for a mismatch **warning**, and the site already `catch`es `sidecarLanguageName`'s throw. A label, by this document's own test. |
| 16 | `export/build-mp3-folder.ts:157` | ID3/M4B language tag on an already-rendered book. Cosmetic. |
| 17 | `audio/render-integrity/aggregate.ts:291` | **Already honest** — returns `undefined` with no state, and its header (285–291) already separates "no state" from "state with no `language`". The model the thirteen move toward. |
| 18 | `analyzer/attribution-eval/capture-cli.ts:33` | Dev capture CLI; stamps a fixture *filename*. |
| 19 | `analyzer/attribution-eval/capture-cli.ts:83` | Same. |

**Honest residual on 18/19:** an unset book yields a fixture named `…en…` that is not
known to be English — a mislabelled dev artifact, not a behaviour change, in a
non-request-serving tool. If attribution-eval fixtures ever become authoritative for a
measurement, this becomes a real defect and moves to CHANGE.

**Site 15's disposition is coupled to D-2.** If the owner picks the uniform hard-fail,
site 15 stays STAY anyway (it is a warning either way). If the owner ever wants it to
fail, the #1953 comment must be overturned **by name and with a reason** — not
silently, which is what the first draft's "uniform and unarguable" framing would have
done.

### The eight downstream callers are unchanged — with one correction

`normaliseBookLanguage`'s other callers — `descriptor-grammar.ts:86`,
`fold-minor-cast.ts:126`, `gemini.ts:221`, `roster-coverage.ts:198,339`,
`tag-grammar.ts:101`, `synthesise-chapter.ts:1362`, `voice-library.ts:1180` — all
receive an **already-resolved language as a parameter**, not a `BookStateJson`. They are
downstream and unchanged. *(The first draft also listed `import.ts:239` here while
elsewhere calling it R1 and "the highest-value line in the change" — it cannot be both.
It is R1; it changes.)*

`normaliseBookLanguage` keeps its signature and its default. **The defaulting is not
deleted; it is moved off the thirteen paths where absence changes behaviour** — exactly
the ticket's wording, and why this is a 13-site change and not a 19-site one.

### How the thirteen change

```ts
/** Honest resolved language: the stated value, or null when never set. */
export function bookStateLanguageOrNull(state: BookStateJson): string | null {
  const raw = state.language;
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  return normaliseBookLanguage(raw);
}

/** Throws for a book whose language was never decided. Use where the language
 *  selects a conventions table, grammar, engine, or sidecar language word. */
export function requireBookStateLanguage(state: BookStateJson): string {
  const lang = bookStateLanguageOrNull(state);
  if (lang === null) throw new BookLanguageUnsetError();
  return lang;
}
```

`BookLanguageUnsetError` carries **no path and no workspace-derived string** — the
`requestFailureMessage` rule in `workspace/file-lock.ts`; the app is served over LAN
HTTPS. Fixed sentence: *"This book's language has not been set. Choose it in Book
settings before continuing."*

**Failure shape is per-route-shape, not uniform.** A `409` is unreachable at several of
the thirteen, so they split into three tiers:

| Tier | Sites | Shape |
|---|---|---|
| **Pre-flight** — can answer before any stream opens | `chapter-splice`, `chapter-qa-repair` ×2, `cast-merge`(provisional) | `409 { error: 'language_unset' }` |
| **Streaming** — headers already flushed | `cast-design:768`, `single-design:304`, `qwen-voice:578` (all three already `send({type:'error', code:'unsupported_language'})` then `res.end()`), `generation:796`, `analysis:3163` (gate in the POST handler pre-detach; in-loop → SSE `error` via `classifyAnalysisFailure`) | `{ type: 'error', code: 'language_unset' }` in each route's **existing** error envelope |
| **Batch** — per-item failure inside a 200/207 | `script-review:772`, `:843` | `itemFailureReason`, per CLAUDE.md's five-batch-route rule. **A whole-request 409 is wrong here.** |
| **Fail-closed value** | `scan.ts:813` | emit `eligibleTtsEngines: []`; never throw |
| **Pure resolver** | `series-cast-scan.ts:96` | return `null`; callers (`voice-match`, `series-reuse-link`) treat null as "veto — cannot prove same language" |

Item 4's client work must key on **all** of these, not just the 409.

---

## Part 3 — Making `language` required, and the guard

### T-1 (resolved here, not an owner decision) — split the read and write types

**Rejected: required on `BookStateJson` itself.** Sound only if every read normalises
absent → `null`; the 24 bare `readJson<BookStateJson>` sites do not. The type would lie
at all 24.

**Rejected: a runtime throw inside `writeStateJsonAtomic`.** Not build-failing, which
the ticket requires; and it turns every legacy book's next write into a 500.

**Chosen: a distinct write-side type**, in `workspace/state-migrate.ts`:

```ts
/** The shape writeStateJsonAtomic accepts. Identical to BookStateJson except
 *  `language` is REQUIRED and explicitly nullable: a writer must state the
 *  language or state that there isn't one. `undefined` — "I didn't think about
 *  it" — is not expressible, which is the whole point. BookStateJson keeps
 *  `language?: string` because that is the truth about disk. */
export type BookStateJsonWrite = Omit<BookStateJson, 'language'> & { language: string | null };

export async function writeStateJsonAtomic(path: string, state: BookStateJsonWrite): Promise<void>
```

**Verified against this repo's own compiler, not assumed** — TypeScript **6.0.3**,
`strict: true` (`tsconfig.json:8`, `server/tsconfig.json:9`),
`exactOptionalPropertyTypes` **not** set (the mechanism does not depend on it):

| Case | Code | Result |
|---|---|---|
| 1 | pass a `BookStateJson`-annotated spread to the parameter | **`TS2345`** — `'string \| undefined' is not assignable to 'string \| null'` |
| 2 | annotate a spread as `BookStateJsonWrite`, omit `language` | **`TS2322`** |
| 3 | `{ ...prev, language: prev.language ?? null }` | **clean** |
| 4 | true mint omitting `language` | **`TS2322`** — *"Property 'language' is missing … but required"* |
| 5 | true mint with explicit `language: null` | **clean** |
| 6 | **spread of an `any`** (`{ ...JSON.parse(s), bookId }`) | **clean — NOT caught** |

Cases 1, 2, 4 are the regression shapes; each reddens naming `language`. Cases 3 and 5
are the legitimate shapes and neither is obstructed, so the change cannot be satisfied
by a no-op nor block correct code.

**Case 6 is a stated blind spot of the mechanism, not an oversight.** It is exactly R5
(`samples.ts:110`). A type cannot catch a spread of `any`; that path is closed by
Task 4's explicit normalisation and by a paired test, not by the compiler.

### What the type does and does not cover

| Path | Closed by |
|---|---|
| R1 `import.ts` true mint | type (case 4) + explicit rewrite |
| The 11 spread sites | type (cases 1–2) |
| **R4's nine bypass writers** | **migrating them onto the seam first** — the type is blind to them until then |
| R2 bundle import | runtime normalisation + guard G2 |
| R3 backup restore | routing through the seam + guard G1 |
| R5 spread-of-`any` | explicit normalisation + test (case 6 shows the type cannot) |

### Two mechanical-fix hazards the plan must not paper over

**`scan.ts:1054-1064` does not take a `?? null` mechanically.**
`backfillAudioModelKeysFromSegments` returns `Promise<{ state: BookStateJson; … }>`, and
`upgraded` is both written (`:1056`) and **returned twice** (`:1057`, `:1064`).
Retyping it to `BookStateJsonWrite` reddens both returns; adding `language:` to a
`BookStateJson`-annotated literal is itself an error. It needs two objects or a widened
return type. The same read-modify-**return** shape applies at `book-state.ts:230` and
`chapters-restructure.ts:171`.

**Four seam calls pass a bare `state` variable, not a literal** — `book-state.ts:249`,
`library-sync-manifest.ts:58`, `scan.ts:711`, and `samples.ts:110`. The
`language: prev.language ?? null` recipe does not apply; they need
`{ ...state, language: state.language ?? null }`, **which changes object identity** for
callers relying on mutation-in-place (`ensureChapterUuids(state)` at `book-state.ts:248`,
and the equivalents at `library-sync-manifest.ts:56`, `scan.ts:710`).

### The static guard — `server/src/workspace/state-language.guard.test.ts`

Types close R1, the spreads, and every future mint. They cannot close R2, R3, R4 or R5.
**The guard's job is the complement**: enforce that nothing writes state.json outside
the sanctioned seam — the property that makes the type check total, and which is
**false today** until R4's nine are migrated.

Built in the `cast-lock.guard.test.ts` idiom: brace/paren-depth scan over raw source
under `server/src`, reusing `skipOpaqueToken` / `computeOpaqueRanges` / `isOpaque` so a
comment or string quoting a pattern is never a site.

- **G1 — seam exclusivity, file-scoped (not adjacency-scoped).** The first draft keyed
  on `writeJsonAtomic(` *textually adjacent to* `stateJsonPath(`, which matches **none**
  of R4's nine. Instead: in any file that mentions `stateJsonPath`, **every**
  `writeJsonAtomic(` occurrence is a finding unless the file is `state-migrate.ts`.
  Coarser and deliberately so — it catches the extracted-path idiom, which adjacency
  cannot. Files that legitimately write *other* JSON alongside state.json (e.g.
  `book-state.ts`'s `listenStatsJsonPath` write at `:1778`) go on the allowlist with a
  count and a reason.
- **G2 — no raw serialisation into the state path.** `planEntry`/`writeFile` with a
  `Buffer`/`JSON.stringify` against `stateJsonPath(`, **plus** the hand-built form
  `join(<any args>, 'state.json')` — the first draft's two-arg-only pattern missed
  `samples.ts`'s three-arg `join(src, '.audiobook', 'state.json')`.
- **G3 — fail closed on absent evidence.** Floors of **35 occurrences across 19 files**.
  Measured 2026-08-13: **43 across 22**; **re-measured against current `main` 2026-08-14
  (post-#1984): 45 across 23** (`grep -rn "stateJsonPath(" --include=*.ts server/src | grep -v "\.test\.ts"`).
  The two additions are the new `store/attribution-health-io.ts` read pair (:46/:104) and
  a second `series-cast-scan.ts` occurrence (:59 was already counted; :136 is new). The
  per-file expected-count map below is the binding constraint and must be regenerated
  from current main at implementation time, not assumed from these floors.
  **Plus a per-file expected-count map**, so aliasing *any single* file reddens — the
  first draft's 15/12 floors were so slack that the neutralisation mutation designed to
  breach them could not (see M1 in the findings). The per-file map is what
  `cast-lock.guard.test.ts`'s file-AND-count allowlist actually achieves and what this
  guard claims to copy.

Allowlist keyed on **file AND count**, asserted in **both directions**, exactly as
`cast-lock.guard.test.ts` does.

**Declared blind spots** (file header, cast-lock house style):

- aliased writer/path imports — the scan matches names, not bindings;
- a path built by concatenation rather than `join(…, 'state.json')`;
- **spread-of-`any` / `JSON.parse` results — the type's blind spot, and the guard's
  too**, since the call looks correct at both layers (R5's shape);
- call-graph indirection — deliberately syntactic and call-graph blind, as cast-lock is;
- template-literal `${…}`, skipped whole as opaque;
- **`scripts/*.mjs` / `*.mts` writers, outside `server/src` entirely. The live one:
  `repair-missing-book-language.mts` writes state.json and this guard cannot see it**
  (out of scope, #2256).

### Neutralisation proof

The repo's lesson is *mutate every entry point, not one*, and three instruments were
found on 2026-08-13 to pass under every mutation of what they claimed to pin. Each
mutation is run **individually with the others reverted**, and **the red must name the
mutated file** — a guard reddening for the wrong reason has proved nothing.

| # | Mutation | Must redden | Must name |
|---|---|---|---|
| M1 | Delete `language` from `import.ts`'s mint literal | `npm run typecheck` | `import.ts` |
| M2 | Set `language: undefined` at **every site on the corrected list, one at a time** | `npm run typecheck` | each file, one row per site |
| M3 | Add a bare `writeJsonAtomic(p, s)` to a `stateJsonPath`-mentioning file | G1 | that file |
| M4 | Revert `scan-import-folder.ts` to stage the un-normalised buffer | G2 | `scan-import-folder.ts` |
| M5 | Alias `stateJsonPath` in **one** file | G3's per-file map | that file |
| M6 | Revert one of R4's nine to the bare `writeJsonAtomic(statePath, …)` form | G1 | that file |

**M2 is an all-sites table, not one row.** With R4 unmigrated, five of the twelve
listed spreads do not redden at all; an implementer who mutates one `book-state.ts`
site, sees red, and records "M2 proved" would ship a guarantee covering half the
writers. That is `f_one_instance_not_all`, already in this repo's memory index.

**Negative control (must stay GREEN):** a prose comment quoting
`writeJsonAtomic(stateJsonPath(` verbatim, and a string literal containing
`join(dir, 'state.json')`, with no code change. A guard reddening here over-matches and
will be reverted by the next person it blocks.

`git diff` empty of mutations before the file is finalised; the log goes in the task
report and the PR body.

---

## Part 4 — Item 4: asking the user when detection cannot decide

### What counts as "genuine ambiguity"

A single condition: **`bookStateLanguageOrNull(state) === null`**, true in exactly three
cases — import surrendered and the user did not override; a legacy book the backfill
declined or that predates it; a bundle import, sample install, or restore carrying no
language.

**The first draft claimed the prompt "cannot fire on a confident detection by
construction." That is false, and the correction matters.** Detection runs in the
**staging** handler (`routes/import.ts:130`, wired out at `:147-149`). The **confirm**
handler reads only `body.language` (`:195`, `:239`) and **has no access to `detected`**.
So R1's rule — "absent `body.language` → `null`" — cannot distinguish "detection
surrendered and the user chose Decide later" from "this client never sent the field."

Today's web client always sends it (`confirm-metadata.tsx:37-38` pre-selects, `:133`
submits unconditionally), so the guarantee holds **for that client only** — a
client-side property, not a construction-level one. Any direct API call, replayed body,
or non-web client (the Android companion) writes `null` on a confidently-detected book
and earns a spurious prompt.

**Therefore: carry `fallback` through to confirm** — on the staging entry, or by
re-running `detectManuscriptLanguageFromChapters` server-side — and key the `null` write
on `detected.fallback === true && body.language absent`. Then the guarantee is real. An
absent `body.language` with `fallback: false` writes the **detected** language, not
`null`.

### Options, priced

**A — import-time only.** On `languageFallback: true`, stop pre-selecting; require a
choice. *Cost:* smallest; the field is already on the wire. *Gap:* nothing for books
already on disk (R2/R3/R5, and whatever #2256 declines) — the population that motivated
the ticket. **Insufficient alone.**

**B — library badge + Book settings row.** *Cost:* **higher than the first draft
priced it.** `PUT /api/books/:bookId/state`'s `state` slice builds `next` from an
explicit whitelist (`book-state.ts:816-847`: `title`, `author`, `series`,
`seriesPosition`, `isStandalone`, `narratorCredit`, `genre`, `publicationDate`,
`description`, `notes`, `audioFormat`, `tags`, `prosodyEnabled`, `prosodyAnnotated`,
`castConfirmed`, `chapters`). **`patch.language` is never referenced — a `language` sent
today is silently dropped.** So B needs a new whitelist entry *plus* its validation (the
import path gates via `isSupportedLanguage`; the PATCH path gates nothing) *plus* an
`openapi.yaml` change. "Silently drops the field" is the worst possible failure mode for
a correction affordance. *Gap:* passive on its own.

**C — blocking gate at analysis/generation.** The thirteen sites fail per their tier;
the frontend turns that into a modal that sets the language and retries. *Cost:* a new
error path per tier and one modal. *Risk:* alone, it fires at the least convenient
moment.

**D — proceed as English and mark the book.** *Rejected on the governing principle.*
Today's behaviour with a label bolted on; for the seven measured books it would have
produced a green run over 25,063 lines classified against the wrong conventions table. A
flag nobody reads is not consent.

### Recommendation — A + B + C, layered, only C blocking

1. **Import (A)** — on `languageFallback: true`, no pre-selection, an explicit "We
   couldn't tell" note, and (per D-1) a "Decide later" option. `languageFallback` is
   already on the wire (`src/lib/types.ts:202`, `api-types.ts:3791`, written at
   `import.ts:149`) and **read by nothing today**.
2. **Library + settings (B)** — `LibraryBook.languageSet`, an "unset" affordance, a
   settings row, **and the server-side whitelist + validation work above**.
3. **Blocking gate (C)** — each tier's failure opens that same row as a modal, prefilled
   with nothing, retrying on save.

(A) stops new unset books cheaply, (B) makes existing ones fixable before they bite, (C)
guarantees none is silently processed. Each alone leaves a hole the others cover.

### W-1 (resolved here, not an owner decision) — additive `languageSet`

`LibraryBook.language` is non-optional (`scan.ts:381`) and feeds the badge and filter
pill. Making it nullable ripples through filter logic for no behavioural gain. **Add
`languageSet: boolean` alongside**; `language` keeps its display value. `openapi.yaml`
§`LibraryBook` and a regenerated `src/lib/api-types.ts` move in the same commit.

*(Citation correction: the first draft placed both consumers in
`src/views/book-library.tsx:113-348`, which holds filter **state** only. The language
badge is `src/components/listen/listen-header.tsx:257-260`; the filter pill's markup is
`src/components/library/library-chrome.tsx:204-225`. The argument survives; the
citation was wrong.)*

Residual: a new frontend consumer could read `language` and be misled. Mitigated by the
OpenAPI description saying so, and bounded because no attribution path runs client-side.

---

## Acceptance and coverage

*(Absent from the first draft entirely — an implementer briefed from it would have had
no test plan and no register row.)*

- **Automated, per changed site:** a test that an unset book produces that site's
  correct failure *shape* (409 / SSE `error` / `itemFailureReason` / `[]` / `null`), and
  — the control that matters — that a book **with** a language is unaffected.
- **Guard:** the six-mutation table plus the negative control, each observed
  individually, logged in the PR body.
- **e2e (Playwright):** the confirm-screen no-pre-selection branch, and the 409 → modal
  → retry loop. Crosses router/redux/layout seams, so CLAUDE.md requires one.
- **`openapi.yaml`:** `languageSet` **and** the new error responses on the changed
  routes; regenerate `src/lib/api-types.ts` in the same commit.
- **On-box acceptance (a merge gate):** end-to-end behaviour on a real book — an unset
  book hitting the gate, the prompt resolving it, analysis then selecting the right
  conventions table — needs a live analyzer and (for sites 6–8) a live sidecar. Add the
  register row, the run-sheet criteria, and the **live-view** update per the register's
  four-step procedure. Recording blocks the merge; running does not.
- **Release notes:** both files, per CLAUDE.md step 5.
- **Re-confirm the inherited assumption** at the top of this document: that the seven
  backfilled values were verified by re-running the corpus measurement.

---

## Owner decisions

> ### ✅ ANSWERED by the repo owner, 2026-08-13 — both as recommended
>
> - **D-1 — "Decide later" ships.** The confirm screen may offer it when detection
>   surrendered. It writes `null`, and the gate stops the book later rather than
>   forcing a guess at import time.
> - **D-2 — uniform hard-fail.** No warn-only carve-out for the three voice-design
>   sites; every site in the CHANGE set treats an absent language the same way.
>
> **D-2 carries a consequence the design already identified — apply it, do not
> re-derive it: site 15's disposition is coupled to this answer** (see the note above
> §T-1). Under the uniform hard-fail, site 15 follows the same rule as the rest, and
> the first draft's "uniform and unarguable" framing — which would have let a book
> proceed silently — is explicitly rejected.
>
> **This does not soften the per-route-shape finding.** *Failure shape* stays
> per-route: a `409` is unreachable at several sites, most importantly the detached
> SSE job holding the 25,063-line case, where the assumption-checker found the
> originally prescribed swap was a literal no-op. Uniform severity means every site
> refuses; it does not mean every site refuses with the same status code. An
> implementer that reads D-2 as "return 409 everywhere" has reintroduced that Critical.

**Label key.** **T-1** and **W-1** above are *resolved in this document* — they weigh
two implementations of one agreed behaviour, which is not a design pass. Only **D-1**
and **D-2** are genuine owner decisions, and both are now answered above.

**D-1 — May the confirm screen offer "Decide later"?**

- **Yes (recommended).** A surrendered detection means the system doesn't know; the user
  importing a file someone sent them may not either. Forcing a choice there is how you
  get a shrugged "English" — the exact bad write this ticket exists to stop, now with
  the user's fingerprints on it. "Decide later" writes `null`; the gate stops the book at
  analysis, by which point the user has it open and is far better placed to answer than
  at the file picker.
- **No.** Forces the answer while the source file is in front of the user. Simpler state
  machine. **Cost:** re-creates the guess-under-pressure path, and cannot help
  R2/R3/R5 books, so `null` handling is needed regardless — this buys a smaller
  surface, not a simpler system.

**D-2 — Uniform hard-fail across the CHANGE list, or per-site severity?**

- **Uniform hard-fail, within each route's own failure shape (recommended).** Every
  remaining site selects a conventions table, grammar, engine, or sidecar language word;
  there is no honest value to proceed with. Note this is *already* not uniform in
  mechanism — the tier table in Part 2 is the shape, and `scan.ts:813` and
  `series-cast-scan.ts:96` fail closed by value rather than throwing.
- **Warn on the three voice-design sites (6–8)**, since a wrong language word yields an
  audibly wrong voice rather than silently wrong data. A real position; the
  "self-evident to the user" claim is unmeasured, and it costs two severities to reason
  about.
- **What changed from the first draft:** it proposed a uniform `409` for twelve sites.
  That was wrong three ways — a `409` is unreachable at the streaming and batch routes,
  `voice-library.ts:1672` has a recorded decision against it, and `chapter-qa-repair.ts:158`
  feeds a hint that is unread unless `SEG_ASR_ENABLED`. **The decision is now about
  severity only; the mechanism is fixed by route shape.**

---

## Assumption-checker pass

Adversarial pass run 2026-08-13 (Premium tier, fresh non-fork subagent, read-only).
**Four CRITICAL, ten MAJOR, seven MINOR.** Every CRITICAL and MAJOR was independently
re-verified against source before folding — the repo's `f_agent_citation_unverified`
lesson. Dispositions:

| # | Finding | Disposition |
|---|---|---|
| C1 | Five listed "spread sites" never call `writeStateJsonAtomic`; nine writers total use an extracted path and are invisible to both type and guard. "15 of 17 use the seam" and "auto-backup is the one bypass" both false | **ACCEPTED — verified.** Now **R4**; seam coverage restated as **13 of 24**; migrating the nine is prerequisite work; **G1 reshaped to file-scoped** |
| C2 | `samples.ts:110` spreads a `JSON.parse` (`any`) through the seam and compiles clean | **ACCEPTED — verified.** Now **R5**; probe **case 6** added; declared a blind spot of *both* type and guard |
| C3 | Site 1 sits in a `catch → 'en'` inside a detached SSE job; the swap is a no-op, `409` unreturnable, and the `:'en'` branch is a different case | **ACCEPTED — verified.** Site 1 given its own three-point treatment |
| C4 | `eligibleTtsEngines` gates "Proceed anyway", `lockedToQwen`, and the engine picker — not advisory | **ACCEPTED — verified.** `scan.ts:813` moved to **CHANGE**, with a *fail-closed `[]`* treatment rather than a throw |
| M1 | G3 floors (15/12) far too slack; mutation M5 could not redden | **ACCEPTED.** Floors **35/19** plus a **per-file expected-count map**; M5 restated as single-file |
| M2 | 19th site `series-cast-scan.ts:96` missing, CHANGE-class | **ACCEPTED** — independently found before the pass landed; already folded |
| M3 | `409` unreachable at ≥5 sites; house pattern is an SSE `error` event | **ACCEPTED.** Part 2 now carries the **tier table** |
| M4 | `voice-library.ts:1672` has a recorded decision against escaping throws; `chapter-qa-repair.ts:158` feeds an unread hint | **ACCEPTED — verified.** Site moved to **STAY**; `:158` kept but flagged weakest |
| M5 | `PUT …/state` does not accept `language`; Option B needs server work | **ACCEPTED — verified.** Option B repriced |
| M6 | "cannot fire on a confident detection by construction" false — confirm has no `detected` | **ACCEPTED — verified.** Corrected; `fallback` must be carried to confirm |
| M7 | `scan.ts:1054` is returned twice; `?? null` breaks the return type | **ACCEPTED.** Named as a mechanical-fix hazard |
| M8 | Seam-call list wrong (seven in `book-state.ts`, five files omitted); four pass a bare `state` variable | **ACCEPTED.** Full list restated; identity hazard named |
| M9 | M2 mutation is one-instance-not-all | **ACCEPTED.** M2 is now an all-sites table |
| M10 | No acceptance, e2e, on-box, or release-notes surface | **ACCEPTED.** New "Acceptance and coverage" section |
| MINOR ×7 | `readJson` count (24 not 8); `scan.ts:222-231` is a doc comment not the mechanism; `book-library.tsx` badge mis-citation; line drift; `D-2` naming two decisions; `cast-merge.ts:155` may be a label; `import.ts:239` listed as both unchanged and changed | **ALL ACCEPTED** and corrected in place. `cast-merge.ts:155` marked **provisional — verify at implementation** rather than reclassified unverified |

**Not accepted:** none. The pass found nothing that argued against the core shape — a
write-side type plus a seam guard remains the right pair, and the empirical TS probe
confirms the mechanism reddens `BookStateJson`-typed spreads exactly as claimed. Every
defect was in the *enumeration the mechanism was pointed at*, the guard's match patterns
versus this repo's actual write idiom, and the assumption that a `409` is returnable
from a streaming job.
