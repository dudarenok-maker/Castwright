---
status: stable
shipped: 2026-06-25
owner: null
---

# 229 — fs-50 language packs: French + German canary + flip (Latin Qwen tranche)

> Status: KNOWN: operational dependency — code is complete; `fr`/`de` flip to
> `supported:true` is gated on an on-box operator listen + attribution-eval pass.
> Key files: `server/src/tts/language-registry.ts`, `server/src/tts/language-registry.test.ts`,
> `scripts/eval-attribution.mjs`, `scripts/lib/coalfall-ground-truth.json`,
> `samples/the-coalfall-commission/manuscript.{fr,de}.md`
> URL surface: confirm-metadata language selector (built from `supportedLanguages()`); the rest is the standard analyze→generate→export pipeline.
> OpenAPI ops: `POST /api/import`, `POST /api/manuscripts/{id}/analysis`, `PUT /api/books/{bookId}/state`, `POST /api/books/{bookId}/cast/design`, `POST /api/books/{bookId}/generation`, `POST /api/books/{bookId}/exports`

This plan covers the **final step of fs-50 ([#974](https://github.com/dudarenok-maker/Castwright/issues/974))**:
flipping **French** and **German** from detected-but-unsupported to supported.
It is the per-language operator gate, not new architecture — the whole
analyze/synthesis stack for Latin-script Qwen languages shipped across the
fs-41/fs-50 seams (spec `docs/superpowers/specs/2026-06-22-fs41-fs50-language-aware-ingest-and-breadth-design.md`)
and `es` proved it end-to-end ([#1031](https://github.com/dudarenok-maker/Castwright/issues/1031)).

## Where fs-50 stands

| Lang | State | How |
|---|---|---|
| `en` | ✅ supported | baseline |
| `ru` | ✅ supported | grandfathered from fs-2 (plan 162) |
| `es` | ✅ supported | canary-validated + operator-accepted 2026-06-23 (#1031) |
| **`fr`** | 🟡 code-complete, `supported:false` | **this plan** — awaits French canary + listen |
| **`de`** | 🟡 code-complete, `supported:false` | **this plan** — awaits German canary + listen |
| `zh` / `ja` | ⏸️ deferred | fs-59 ([#1004](https://github.com/dudarenok-maker/Castwright/issues/1004)) — needs a word segmenter, CJK quotes, CJK token divisor |
| Kokoro/XTTS non-English | ⏸️ deferred | fs-60 ([#1005](https://github.com/dudarenok-maker/Castwright/issues/1005)) — engine-eligibility relaxation |

`fs-62`/[#1034](https://github.com/dudarenok-maker/Castwright/issues/1034) (persona
i18n) is **closed won't-fix**: research proved the Qwen voice-design `instruct`
stays English regardless of book language (accent rides the separate calibration
channel, `main.py` `CALIBRATION_TEXTS`). FR/DE are **not** gated on it — proceed
with English personas, exactly as `es` shipped.

## Benefit / Rationale

- **User:** French and German books become first-class — detectable on ingest,
  the language selectable on the confirm screen, voices designed in-language, a
  full analyze→generate→export. Two of the most-requested European languages.
- **Strategic:** fs-50 is the headline perception gap (rivals advertise 1,000+
  languages). Each Latin language we honestly validate widens the comparison
  surface. ES+FR+DE+RU is a credible European tranche.
- **Architectural:** locks the **per-language operator gate** as the discipline
  for claiming a language — `supported:true` lands *only after* an operator hears
  a real render and the attribution eval clears recall. No language ships on code
  review alone.

## Architectural impact

- **No new seams.** The registry, detection, language-agnostic chapter splitting,
  attribution localization (`tag-grammar.ts`/`descriptor-grammar.ts`), per-language
  calibration text, and the never-cross-language guard all already exist and
  already carry `fr`/`de` data. This plan flips two booleans and re-points the
  tests that assert "fr/de are not yet supported."
- **Invariants preserved:**
  - **Never-cross-language within a book** (plan 162) — generation force-routes
    every character incl. narrator to Qwen for non-English books; a
    cross-language-reused voice is treated as undesigned; unavailable Qwen is
    fatal. Flipping `fr`/`de` does not touch this path.
  - **Per-language gate** — `isSupportedLanguage()` reads `.supported`; flipping
    is the *only* way a language becomes selectable/generatable.
- **Migration story:** none — `language` is an additive BCP-47 field already in
  the schema since fs-2.
- **Reversibility:** the flip is two booleans + their tests. To pull a language
  back, set `supported:false` and revert its test edits. Per-language: rejecting
  French alone reverts only the `fr` line + the `fr` test rows.

## Invariants to preserve

1. `language-registry.ts` `ENTRIES` — `fr`/`de` keep their `detect`,
   `headingLexicon`, and `frontMatterKeywords`; only `supported` changes.
2. `supportedLanguages()` (`language-registry.ts:102`) is the **single source**
   for the confirm-screen selector — flipping `supported` is what makes the
   language appear there; no hardcoded language list anywhere.
3. The attribution-eval recall gate is **≥ 0.85** (`eval-attribution.mjs`
   `DEFAULT_MIN_RECALL`); a canary that scores below it does not flip.
4. The Coalfall ground truth (`scripts/lib/coalfall-ground-truth.json`) is the
   one scoring fixture for every language — its aliases now carry the FR/DE
   names (`le dragon`/`der Drache`, `Veuve`/`Witwe Casper`, `Père`/`Vater Lessom`,
   Wren's nickname `Moineau`/`Spatz`). Matching is exact normalised full-name.

## The canary runbook

A canary = a full pipeline run against the committed line-for-line translation,
on the GPU box, driven via the API. Lessons baked in from the `es` canary
(`project_spanish_canary_results`): run **one** app/sidecar stack, keep the
SEG_SPK drift gate **off** (its ECAPA post-step stalls on the 8 GB card,
[#1029](https://github.com/dudarenok-maker/Castwright/issues/1029)), and put ASR
on **CPU** so it never competes with Qwen synth for VRAM.

Fixtures (committed): `samples/the-coalfall-commission/manuscript.fr.md` and
`manuscript.de.md`.

**Step 0 — flip the flag LOCALLY (uncommitted) so the language is selectable.**
A language must be `supported:true` to appear in the confirm selector and pass
the generation gate — the `es` canary did the same. In
`server/src/tts/language-registry.ts`, set the target entry's `supported: true`.
Do **not** commit yet — the commit is step 6, after acceptance.

**Step 1 — one clean stack.** Kill stray node/python, then start a single stack
with the canary-friendly env:

```
SEG_SPK_ENABLED=0  SEG_ASR_ENABLED=1  ASR_DEVICE=cpu  npm start
```

(SEG_SPK off avoids the assembly stall; ASR on CPU keeps the content-QA round-trip
without VRAM contention.)

**Step 2 — import + detect.** `POST /api/import` with the fixture. Confirm the
response carries `language: "fr"` (or `"de"`) and `languageSupported: true`
(true now that step 0 flipped it).

**Step 3 — confirm language, then cast.** `PUT /api/books/{bookId}/state` to set
the selected language and `castConfirmed: true` (the `es` miss: without
`castConfirmed`, `applyOverrideToCastFiles` never writes the designed voice
overrides). Then `POST /api/manuscripts/{id}/analysis` (SSE) — verify the final
event is `{kind:'result',…}`, the chapter split found both `Chapitre`/`Kapitel`
headings, and the cast roles/descriptions are written in-language.

**Step 4 — design + generate.** `POST /api/books/{bookId}/cast/design` (SSE) to
design the in-language Qwen voices, then `POST /api/books/{bookId}/generation`
(SSE) for at least one full chapter. Expect a completed chapter MP3 and clean
ASR content-QA (0 flagged segments is the `es` bar).

**Step 5 — score + LISTEN.** Run the attribution eval against the produced cast:

```
node scripts/eval-attribution.mjs <workspace>/<bookId>/cast.json
```

Expect **recall ≥ 0.85** (PASS, exit 0). Then **listen to the chapter MP3** —
this is the gate the eval cannot replace. Accept only if the synthesis is
intelligible, correctly-accented French/German.

**Step 6 — flip + commit (only on acceptance).** See the next section.

## The flip (exact diff)

Per accepted language, two edits. **`server/src/tts/language-registry.ts`:**

```ts
// for fr:
{ code: 'fr', sidecarName: 'French',  supported: true, detect: { ... }, ... },
// for de:
{ code: 'de', sidecarName: 'German',  supported: true, detect: { ... }, ... },
```

**`server/src/tts/language-registry.test.ts`** — the assertions that currently
pin "fr/de not yet supported" must move to "supported". The lines to update:

- `isSupportedLanguage` (`:52-60`) — `expect(isSupportedLanguage('de')).toBe(false)`
  → `true` (and add `fr`).
- `fr/de exist, are Latin, and are NOT yet supported` (`:74-80`) — flip the
  `expect(e?.supported).toBe(false)` to `true` for the accepted language(s), or
  retitle to "…and ARE supported".
- `isSupportedLanguage with a present-but-unsupported entry` (`:83-88`) — this
  test demonstrates the present-but-`false` path using `fr`. **Once both fr and
  de flip, no present-but-unsupported real entry remains** (en/ru/es/fr/de all
  true; zh/ja are absent, not present). Re-point this test at an **absent** code
  (e.g. `getLanguageEntry('zh')` is `undefined` → `isSupportedLanguage('zh')` is
  `false`) and add a comment that the present-but-`false` distinction is
  re-covered when fs-59 adds `zh`/`ja` as `supported:false`. If you flip only one
  language this round, keep this test pointed at the still-gated one.
- `supportedLanguages` (`:90-98`) — add `{ code: 'fr', label: 'French' }` /
  `{ code: 'de', label: 'German' }` to the expected list (registry order:
  en, ru, es, fr, de).

Then `npm run verify` (or at minimum `npm run test:server`) green, and commit as
`feat(server): flip <lang> to supported after canary (#974)`.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/language-registry.test.ts`) — pins the registry
  `supported` matrix and `supportedLanguages()` ordering; updated as part of the
  flip so the new supported state is locked.
- Node (`scripts/tests/eval-attribution.test.mjs`) — `scoreAttribution()`
  recall/precision/entity-split logic (8 tests, green). The FR/DE aliases added
  to the real ground truth are additive (a French run never contains `Drache`),
  so this suite is unaffected; the inline test fixture is independent of the file.
- **No new e2e** — the confirm selector is already covered by the fs-2 language
  e2e (plan 165); flipping a flag adds an option, not a new seam. If a future
  language adds UI behaviour, append a case to the responsive coverage spec.

### Manual acceptance walkthrough

The canary runbook above **is** the manual acceptance walkthrough — it runs
against the real backend + sidecar (not mock mode), because the gate is audio.
A language is "done" when steps 2–5 pass and the operator accepts the MP3.

## Ship notes

**Shipped 2026-06-25 (fr + de together).** Both flipped to `supported:true` in
`language-registry.ts` on branch `chore/fs50-fr-de-canary-prep` (PR #1078).

- **Gate cleared:** operator **audio** acceptance. Four designed Coalfall samples
  — FR narrator + FR Oduvan, DE narrator + DE Oduvan — synthesised via the real
  Qwen design path (voices designed against the production French/German
  calibration pangrams `main.py` `CALIBRATION_TEXTS`; the audition speaks the
  verbatim fixture line). Operator confirmed intelligible, correctly-accented
  French/German with distinct voices → "we are good to go."
- **Attribution-eval recall** was offered but **deferred** at operator request
  (flip on audio alone). The FR/DE aliases are already in
  `coalfall-ground-truth.json`, so a recall pass can be run any time from a real
  analysis without further setup.
- **Tests re-pointed:** `language-registry.test.ts` (supported matrix +
  `supportedLanguages` ordering + the absent-vs-present test), `detect-language.test.ts`
  (fr/de → `supported:true`), `import.test.ts` (supported-list).
- ZH/JA remain fs-59 (#1004); Kokoro/XTTS engine relaxation remains fs-60 (#1005).
  With ES+FR+DE+RU live, the **fs-50 Latin Qwen tranche is complete** → closes #974.
