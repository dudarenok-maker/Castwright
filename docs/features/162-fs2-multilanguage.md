---
status: active
shipped: null
owner: null
---

# 162 — Multi-language support (Russian first): the language half of fs-2

> Status: active — server invariant + analyzer + frontend UX landed; library
> En/Ru filter pill + cast-wide banner deferred (see Out of scope).
> Key files: `server/src/tts/language.ts`, `server/src/routes/qwen-voice.ts`,
> `server/src/routes/generation.ts`, `server/src/tts/synthesise-chapter.ts`,
> `server/src/workspace/scan.ts`, `server/src/analyzer/gemini.ts`,
> `server/src/analyzer/ollama.ts`, `server/src/routes/analysis.ts`,
> `src/lib/detect-language.ts`, `src/views/confirm-metadata.tsx`,
> `src/modals/profile-drawer.tsx`, `src/components/voice-engine-picker.tsx`,
> `src/components/listen/listen-header.tsx`
> URL surface: confirm-metadata (`ui.stage = 'confirm'`), `#/cast` profile
> drawer, `#/books/<id>/listen` header
> OpenAPI ops: `POST /api/books` (`ConfirmBookRequest.language`),
> `GET /api/library` (`LibraryBook.language`), `POST /api/books/{id}/generation`
> (server-authoritative never-cross-language gate), sidecar
> `POST /qwen/design-voice` (`language` threaded from the book)

## Benefit / Rationale

- **User:** a Russian manuscript produces Russian narration with Russian
  (designed Qwen) voices — never cross-language. Auto-detected on import,
  overridable at confirm; the cast view guides the user to design a Qwen voice
  for the narrator and every speaking character.
- **Technical:** the engine already supported language (Qwen bakes it into the
  voice manifest at design time, plan 108) — this wave makes the rest of the
  stack language-aware: a BCP-47 `language` field end-to-end, Cyrillic
  detection + token estimate, a language preamble for attribution, and a
  hard gate that refuses to read non-English text through English-only Kokoro.
- **Architectural:** `language` is an open BCP-47 string everywhere (not a
  closed enum), so adding Spanish / German later is a UI-list change, not a
  contract migration. The never-cross-language invariant is enforced
  server-side (authoritative), with the UI kept honest on top.

## Architectural impact

### New seams / extension points

- **`server/src/tts/language.ts`** — the single BCP-47 ↔ sidecar bridge:
  `normaliseBookLanguage` (missing/empty → `'en'`, primary subtag),
  `sidecarLanguageName` (`'ru'` → `'Russian'`, unknown → `'English'` + warn),
  `isNonEnglish`. Adding a language = one table entry; only `en`+`ru` wired in
  v1.
- **`BookStateJson.language`** (server `scan.ts` + frontend `types.ts`) with the
  `bookStateLanguage(state)` read-backfill resolver (mirrors
  `bookStateAudioFormat`). Surfaced on `LibraryBook.language` (wire always
  carries a value, padded to `'en'`).
- **`StageCall.language`** (`server/src/analyzer/index.ts`) — flows verbatim
  through every `runStage*` of every analyzer; drives the system-prompt
  preamble. No analyzer method signature changed.
- **`SynthesiseChapterOpts.forbidKokoroFallback` + `bookLanguage`** +
  `MissingDesignedVoiceError` — the Kokoro-fallback block for non-English books.
- **`src/lib/detect-language.ts`** — pure Cyrillic-ratio detector.
- **`VoiceEnginePicker.lockedToQwen`** — UI hard-lock for non-English books.

### Migration story

`language` is an **additive optional field** on `BookStateJson`. Per the plan-27
rename-vs-add policy, `CURRENT_STATE_SCHEMA` does **NOT** bump — a legacy
state.json (no `language`) reads back `'en'` at the `bookStateLanguage` seam, and
a `'ru'` value round-trips through migrate + stamp at schema 1. **Do not bump the
schema for this field** — a reviewer "fixing" that would gratuitously reject
older files. (If a future fs-2 follow-up makes `language` non-optional or changes
its semantics, _that_ change bumps the schema.)

### Reversibility

Each wave is its own commit and individually revertable. English books are
byte-identical to pre-fs-2 throughout: `forbidKokoroFallback` defaults false, the
analyzer preamble is empty for English, the token estimate is unchanged for
Latin text, and the Listen badge / cast Qwen-lock only fire for non-English
books.

## The never-cross-language invariant (two enforcement layers)

Kokoro is hard-filtered to English (`ENGLISH_VOICE_PREFIXES` in the sidecar) and
the narrator defaults to Kokoro. So for a non-English book, **every** speaker —
including the narrator — must render in a designed Qwen voice, or the audio is
cross-language garbage (e.g. Russian text through `af_heart`). Enforced at two
layers:

- **Layer A (authoring / UI, `voice-engine-picker.tsx` + `profile-drawer.tsx`):**
  for a non-English book the per-character engine picker is hard-locked to Qwen
  (Kokoro/Coqui disabled) and defaults to Qwen regardless of stale/reused
  on-disk `ttsEngine`. Keeps the UI honest.
- **Layer B (generation route, server-authoritative, `generation.ts`):** after
  cast hydration, force `ttsEngine = 'qwen'` on every character; pass
  `forbidKokoroFallback`/`bookLanguage` into `synthesiseChapter` so an undesigned
  Qwen voice throws `MissingDesignedVoiceError` (chapter fails loudly) instead of
  silently rendering in Kokoro; and an unavailable Qwen engine is **fatal**
  (run aborted) rather than a silent downgrade. Cross-language reuse guard: a
  designed voice whose on-disk manifest `language` ≠ the book language is treated
  as undesigned, forcing a re-design (user-confirmed policy).

Two layers because Layer A keeps the picker honest while Layer B guarantees the
invariant even against a stale/hand-edited/reused cast.json or a stale URL — the
server never emits cross-language audio.

### Persona language — deliberately NOT threaded

The Qwen persona/`instruct` describes vocal qualities; the sidecar's design-time
`language` param (threaded from the book in `qwen-voice.ts`) is what drives the
audio language. So `generateVoiceStyle` / `designQwenVoice` / the voice-sample
APIs stay language-free (CLAUDE.md simplicity-first). Do not re-add a persona
language param.

### Non-English narrator-default heuristic (plan 221 Wave A)

The per-sentence attribution model — especially on non-Latin scripts —
mislabels third-person NARRATION as the named character (e.g. "Егор засунул
руки в карманы" → `egor`), which would read narration in that character's
voice. Because the spoken-vs-narration distinction is mechanical, non-English
stage-2 attribution decides it in code instead of trusting the model: after
`runStage2ChapterChunked` returns, `applyNonEnglishNarratorDefault`
(`server/src/analyzer/narrator-default.ts`) forces every NON-spoken sentence's
`characterId` to `narrator`. A "spoken line" begins with a dialogue dash
(—/–/-, including the named HTML entities `&mdash;`/`&ndash;`) or an opening
quote («/"/“), or contains a quoted span; everything else is narration. The
helper is wired inside the shared `attributeChapterStage2`
(`server/src/routes/analysis.ts`) gated on `isNonEnglish(language)`, so both the
main and subset analysis routes get it and the English path is byte-identical
(same-array no-op). It runs AFTER coverage, which keys on sentence text not
`characterId`, so the coverage verdict is unchanged.

The one class the heuristic deliberately leaves to the model is the dashed
narrative TAG ("— сказал юноша."), which looks spoken — the Russian branch of
`languagePreamble` (`server/src/analyzer/gemini.ts`) appends a guard telling the
model that a dashed line describing who spoke or what they did is the narrator,
not the speaker.

**Evidence (`server/repro-heuristic.mts`, against a local non-committed Russian
EPUB):** the model's narration-block correctness was 0–1/6 per run; the
heuristic deterministically produced 6/6 every run while leaving every dialogue
line untouched (`spoken-lines-kept-named` unchanged across 3 runs).

**Known limitation:** a genuine spoken line that lacks BOTH a leading
dash/quote AND any quoted span would be wrongly forced to `narrator`. This
depends on the model preserving the dialogue marker; empirically gemma-e4b
preserved the dash on every dialogue line, but it is a model-preservation
dependency, not a guarantee.

## Test plan

### Automated coverage

- Server `server/src/tts/language.test.ts` — BCP-47 mapping / normalisation /
  unknown-fallback-with-warn / `isNonEnglish`.
- Server `server/src/workspace/book-state-language.test.ts` +
  `state-migrate.test.ts` — resolver default + language survives migration at
  schema 1 (no bump).
- Server `server/src/routes/import.test.ts` — confirm with `'ru'` persists,
  omitted → `'en'`.
- Server `server/src/routes/qwen-voice.test.ts` — design proxy sends
  `'Russian'` for a `ru` book, `'English'` for legacy/default.
- Server `server/src/tts/synthesise-chapter.test.ts` — `forbidKokoroFallback`
  throws `MissingDesignedVoiceError` for an undesigned / Qwen-down character
  (incl. the title beat); designed voice still renders; default-false keeps the
  graceful fallback byte-identical.
- Server `server/src/routes/generation-fallback-gate.test.ts` — force-Qwen +
  opts threaded; cross-language (English-manifest) reused voice treated as
  undesigned; Qwen-down on a Russian book is fatal (no synth, no park).
- Server `server/src/analyzer/gemini.test.ts` — preamble injected for `'ru'` /
  omitted for `'en'`/absent; `languagePreamble` + `buildSystemInstruction`
  units; `estimateInputTokens` Latin=1250 pin / Cyrillic=1400 / mixed-between.
- Server `server/src/analyzer/ollama.test.ts` — preamble parity.
- Server `server/src/routes/analysis-language.test.ts` —
  `resolveBookLanguageForManuscript` found / absent / missing / throws.
- Frontend `src/lib/detect-language.test.ts` — Cyrillic-ratio classification.
- Frontend `src/views/confirm-metadata.test.tsx` — selector seeds from
  detection, chip + Qwen note, clears chip on override.
- Frontend `src/components/voice-engine-picker.test.tsx` — Qwen-lock + note when
  `lockedToQwen`; full list otherwise.
- Frontend `src/components/listen/listen-header.test.tsx` — badge for `ru`,
  hidden for `en`/absent.
- **Playwright** `e2e/language-detection.spec.ts` — drop a Cyrillic manuscript →
  confirm view auto-selects Russian + shows the chip; English manuscript stays
  English (no Russian chrome).

### Manual acceptance walkthrough

Run the synthesis paths against the real backend + sidecar (this feature is
sidecar-bound). Canonical English fixture:
`server/src/__fixtures__/the-coalfall-commission.md` (committed, owned). Russian
uses the committed owned translation of Chapter One,
`server/src/__fixtures__/the-coalfall-commission.ru.md` — the same passage the
`e2e/language-detection.spec.ts` Cyrillic case pastes.

1. **English regression** — import the Coalfall fixture → confirm shows English (no
   Russian chrome) → cast picker behaves as today (Kokoro narrator, no Qwen
   lock) → generate → audio is English. Nothing changes for English books.
2. **Russian happy path** — import the Russian fixture → confirm-metadata
   auto-selects Russian with the "Auto-detected Russian — verify" chip → cast
   view hard-locks each character (incl. narrator) to Qwen → design a Qwen voice
   per character (the persona auto-fills; the preview pangram is Russian) →
   generate → audio is Russian with zero English bleed, no
   `qwen_unavailable_kokoro_fallback` warnings.
3. **Undesigned-voice gate** — try to generate a Russian book with an undesigned
   character → the chapter fails loudly (`MissingDesignedVoiceError`), no Kokoro
   audio is written.
4. **Qwen-down fatal** — stop/unload Qwen, generate a Russian book → the run
   aborts with a "requires Qwen" message, not a silent Kokoro downgrade.
5. **Token estimate** — run a long Russian chapter through the Gemini analyzer →
   `estimateInputTokens` within ~10% of `usageMetadata.promptTokenCount`; no
   spurious 429s.
6. **Listen badge** — open the Russian book's Listen view → a "Russian" badge
   shows in the stats row; the English book shows none.

## Out of scope (deferred — tracked on the backlog)

- **Library En/Ru filter pill** (`library-chrome.tsx` + `library-slice.ts`
  `filterBooks`) — discovery polish; ANDs with the existing tag filter. Filed as
  a backlog follow-up.
- **Cast-wide "design your Russian voices" banner** on `#/cast` — the
  per-character picker note already communicates the requirement; a cast-level
  banner + Qwen auto-load on cast-view entry is a follow-up.
- **Russian UI strings** (interface localization) — a separate epic (react-i18next),
  filed as backlog `fs-14`. fs-2's `language` is per-BOOK content; the UI switch
  is a per-USER interface preference — distinct axes.
- **Per-sentence / mixed-script language**, XTTS-Russian (CPML), Kokoro-Russian
  (no weights), non-Cyrillic/non-Latin auto-detect.

## Ship notes

(Filled when status flips to `stable`. Branch `feat/server-fs2-language-model`,
waves W1 / W2A / W2B / W2C committed; e2e + docs in W3.)
