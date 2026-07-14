---
status: active
shipped: null
owner: null
---

# 254 — fs-59 W5: zh/ja `supported:true` flip (CJK language support)

> Status: KNOWN: operational dependency — the registry flip + text pipeline are
> code-complete and tested; the fs-61 per-language demo-book coverage guard
> (`language-sample-coverage.test.ts`, from #1568) is red for zh/ja pending a
> GPU-backed sample capture, tracked separately as `fs-61` [#1600](https://github.com/dudarenok-maker/Castwright/issues/1600).
> Key files: `server/src/tts/language-registry.ts`, `server/src/tts/language-registry.test.ts`,
> `server/src/tts/detect-language.ts`, `server/src/tts/detect-language.test.ts`,
> `server/src/tts/language.test.ts`, `server/src/routes/import.test.ts`,
> `server/src/__fixtures__/the-coalfall-commission.{zh,ja}.md`
> URL surface: confirm-metadata language selector (built from `supportedLanguages()`); the rest is the standard analyze→generate→export pipeline.
> OpenAPI ops: `POST /api/import`, `POST /api/manuscripts/{id}/analysis`, `PUT /api/books/{bookId}/state`, `POST /api/books/{bookId}/cast/design`, `POST /api/books/{bookId}/generation`, `POST /api/books/{bookId}/exports`

This plan covers **fs-59 Wave 5** ([#1004](https://github.com/dudarenok-maker/Castwright/issues/1004)):
flipping **Chinese (`zh`)** and **Japanese (`ja`)** from registered-but-unsupported
to `supported:true`, so CJK books are no longer blocked at the confirm screen.
It follows the same per-language-operator-gate discipline plan
[229](archive/229-fs50-fr-de-language-packs.md) established for fr/de: the
registry/detection/text-pipeline seams already existed (fs-59 W1–W4, all merged
— #1572/#1577/#1582/#1585/#1597), and this wave is the flip itself plus the
tests that pin "zh/ja not yet supported" moving to "supported".

## Where fs-59 stands

| Wave | What | State |
|---|---|---|
| W1–W2 | Registry entries, script detection, CJK-aware word count, heading/front-matter lexicons | ✅ merged |
| W3 | In-language few-shot prompt examples for roster/attribution | ✅ merged |
| W4/W4b | Coqui XTTS eligibility for zh/ja (`zh`→`zh-cn` language-code map) | ✅ merged (#1585) |
| W2 follow-up | CJK standalone-heading `\b` gap fix, unified CJK regexes | ✅ merged (#1597) |
| **W5** | **`supported:true` flip** | **this plan** |
| — | fs-61 zh/ja demo-book sample capture (coverage guard) | ⏸️ follow-up, [#1600](https://github.com/dudarenok-maker/Castwright/issues/1600) |
| — | CJK-aware id reconciliation (title-fusion orphan-demotion) | 🔧 in progress, parallel PR `fix/server-cjk-id-reconciliation` |
| — | fs-70: XTTS languages beyond Qwen's five | ⏸️ deferred, [#1303](https://github.com/dudarenok-maker/Castwright/issues/1303) |

## Benefit / Rationale

- **User:** Chinese and Japanese books become first-class — detectable on
  ingest, selectable on the confirm screen, castable and generatable through
  the standard pipeline. The two highest-population languages not yet covered.
- **Strategic:** extends the "rivals show 1,158 languages" comparison surface
  past the Latin/Cyrillic tranche (en/ru/es/fr/de) into CJK, the hardest
  script family the pipeline supports today.
- **Architectural:** re-confirms the per-language operator gate (`supported`
  flips only after on-box validation) generalizes past Latin scripts — CJK
  needed real script-specific work (word count, heading circumfix parsing,
  quote handling) but the *gating mechanism* itself needed no changes.

## On-box validation (what was checked before this flip)

Both TTS engines render CJK acceptably:

- **Coqui XTTS v2** — `zh-cn` and `ja` render via the W4b language-code map
  (`zh` → `zh-cn` for Coqui specifically; XTTS's own code, not the registry's
  BCP-47 `zh`).
- **Qwen** — renders both `zh` and `ja` natively (same design/synth path as
  the Latin tranche, English personas per the fs-62 won't-fix precedent).

**CJK attribution quality is analyzer-model-dependent** — there is no
per-language analyzer auto-routing (the analyzer model is a per-phase user
setting, `analyzerPhase0Model`/`analyzerPhase1Model`; see fs-44/settings
docs), so this is an **operator recommendation**, not an enforced default:

| Analyzer model | Recall | Coverage | Precision |
|---|---|---|---|
| Local Qwen (recommended for CJK) | ~62% | ~72% | 100% |
| General lite default | weaker, unstable | — | — |

**Operator recommendation:** select a local Qwen analyzer model
(`analyzerPhase0Model`/`analyzerPhase1Model`) for CJK books. The general lite
default is measurably weaker and less stable on CJK attribution — precision
stays perfect (no false character assignments) but recall/coverage suffer, and
the demotion gate (below) can trip more often as a result.

## Demotion-gate interaction

The existing attribution-drift/demotion safety net (srv-36 Phase 1/2) is
**unchanged by this flip** and is treated as a correct, working gate — a weak
analyzer model on a CJK book may trip it (surfacing as retry-required rather
than a silent bad attribution), which is the intended, acceptable behavior.
One specific interaction was identified during CJK validation: title-fusion
causing an id mismatch (e.g. `奥杜万师傅` vs `奥杜万`) can read as orphan
demotion. That is **not** fixed by this flip — a parallel PR
(`fix/server-cjk-id-reconciliation`) addresses CJK-aware id reconciliation
directly; this plan does not duplicate that work.

## Architectural impact

- **No new seams.** The registry, CJK script detection, CJK-aware word count
  (`server/src/routes/import.ts`), circumfix chapter-heading regex
  (`CJK_HEADING_ALT`, `server/src/parsers/text.ts`, landed #1576/#1597), and
  the Coqui `zh`→`zh-cn` language-code map (W4b) all already existed and
  already carried zh/ja data. This plan flips two booleans and re-points the
  tests that assert "zh/ja are not yet supported."
- **Invariants preserved:**
  - **Never-cross-language within a book** — generation force-routes every
    character incl. narrator to the book's language; unaffected by this flip.
  - **Per-language gate** — `isSupportedLanguage()` reads `.supported`;
    flipping is the *only* way a language becomes selectable/generatable.
  - **CJK read-through, not a hardcoded literal** — `detectManuscriptLanguage`'s
    CJK branch calls through to the registry (`getLanguageEntry(code)?.supported`)
    rather than returning a literal `{ supported: false }`; this was an
    independent-review CRITICAL finding fixed in fs-59 W2 and is pinned by a
    dedicated stub-based test in `detect-language.test.ts` that is
    intentionally independent of the registry's current real value.
- **Migration story:** none — `language` is an additive BCP-47 field already
  in the schema since fs-2.
- **Reversibility:** the flip is two booleans + their tests. To pull a
  language back, set `supported:false` and revert the test edits.

## Invariants to preserve

1. `language-registry.ts` `ENTRIES` — `zh`/`ja` keep their `detect`,
   `headingLexicon`, `frontMatterKeywords`, `narratorName`, and
   `promptExamples`; only `supported` changes.
2. `supportedLanguages()` is the **single source** for the confirm-screen
   selector — flipping `supported` is what makes the language appear there;
   no hardcoded language list anywhere.
3. `fs-61`'s sample-coverage guard (`language-sample-coverage.test.ts`,
   #1568) requires every `supported:true` registry language to ship a
   runnable Coalfall demo book under `samples/`. This flip trips that guard
   for zh/ja — tracked as a follow-up, not fixed here (see below).

## CJK demo books (fixtures)

Full two-chapter zh/ja translations of *The Coalfall Commission* are committed
alongside the existing English/Russian/Spanish/French/German fixtures, for the
language-detection and future eval fixtures:

- `server/src/__fixtures__/the-coalfall-commission.zh.md`
- `server/src/__fixtures__/the-coalfall-commission.ja.md`

These are source-text fixtures only (mirroring `the-coalfall-commission.ru.md`),
**not** the `samples/the-coalfall-commission-<lang>/` demo-book directories
that ship with cast.json + designed voices (the `-de`/`-es`/`-fr`/`-ru`
pattern) — capturing those real demo books requires the analyzer + Qwen
VoiceDesign pipeline on a GPU box and is out of scope for this flip. See
[#1600](https://github.com/dudarenok-maker/Castwright/issues/1600).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/language-registry.test.ts`) — pins the
  registry `supported` matrix (now includes zh/ja as `true`),
  `supportedLanguages()` ordering (en/ru/es/fr/de/zh/ja), and the
  present-vs-absent `isSupportedLanguage` distinction (re-pointed at an
  absent code since no registry entry is present-but-`false` anymore).
- Vitest server (`server/src/tts/detect-language.test.ts`) — CJK
  `detectManuscriptLanguage` results now read `supported: true` through the
  registry; the stub-based read-through proof test is independent of the
  registry's real value by design and needed no logic change, only comment
  updates.
- Vitest server (`server/src/tts/language.test.ts`) — `sidecarLanguageName`
  resolution and `resolveEligibleEngines` (qwen + coqui) for zh/ja; comments
  updated to reflect `supported:true`.
- Vitest server (`server/src/routes/import.test.ts`) — `POST /api/import`
  candidate `supportedLanguages` list now includes zh/ja.
- **Known red, tracked separately:** `server/src/tts/language-sample-coverage.test.ts`
  — 2 failing assertions (zh, ja) until the fs-61 demo-book capture
  ([#1600](https://github.com/dudarenok-maker/Castwright/issues/1600)) lands.
  This is a deliberate coverage guard, not a flake — do not skip it.
- **No new e2e** — the confirm selector is already covered by the fs-2
  language e2e; flipping a flag adds an option, not a new seam.

### Manual acceptance walkthrough

On-box validation (Coqui XTTS zh-cn/ja render, Qwen zh/ja render, CJK
attribution measurement) was already performed prior to this flip per the
fs-59 W1–W4 waves; this plan documents the flip itself. A full canary
walkthrough (import → confirm → analyze → design → generate → listen),
mirroring plan 229's runbook, is the natural on-box acceptance step once this
PR merges — using the committed zh/ja Coalfall fixtures as the source text and
a local Qwen analyzer model per the operator recommendation above.

## Out of scope

- **fs-61 zh/ja demo-book capture** (full `samples/the-coalfall-commission-{zh,ja}/`
  with designed per-character voices) — [#1600](https://github.com/dudarenok-maker/Castwright/issues/1600).
- **CJK-aware id reconciliation** (title-fusion orphan-demotion) — addressed in
  a parallel PR (`fix/server-cjk-id-reconciliation`), not this plan.
- **fs-70** (XTTS languages beyond Qwen's five, e.g. Korean/Arabic/Hindi) —
  [#1303](https://github.com/dudarenok-maker/Castwright/issues/1303). This flip
  only opens zh/ja; fs-70 is the broader XTTS-only-language-set follow-up.
- **Per-language analyzer auto-routing** — deliberately not built. The Qwen
  recommendation for CJK stays a documented operator choice
  (`analyzerPhase0Model`/`analyzerPhase1Model`), not an enforced default.
- **Kokoro CJK support** — Kokoro's voice catalog stays English-only
  (fs-69, [#1302](https://github.com/dudarenok-maker/Castwright/issues/1302));
  unaffected by this flip.

## Ship notes

(Filled in once this PR merges and status flips to `stable`.)
