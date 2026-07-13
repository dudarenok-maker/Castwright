# Design: localized folkloric narrator identity for every new book

- **Status:** design approved 2026-07-13
- **Area:** server / analyzer
- **Branch:** `feat/server-narrator-identity`

## Problem

The narrator is the same character in every book, but today its identity is
assembled ad hoc:

- **Name.** The analyzer model emits the narrator's display name as the English
  literal `"Narrator"` regardless of the book's language, so a German book shows
  an English `Narrator` in its cast. Making it read `Erzähler` / `Рассказчик`
  required hand-editing each book's `cast.json`.
- **Voice.** The narrator carries no `voiceStyle` by default and is skipped by
  the voice-style persona generator (`routes/voice-style.ts`), so it falls back
  to the plan-108 Kokoro narrator preset. Giving the Coalfall demo books a
  consistent, designed folkloric narrator meant copying one blessed persona
  string across every language's cast by hand.

Neither is durable: the next new book loses both corrections. We want the
localized name and the one consistent folkloric persona to be produced
deterministically, in code, for every newly analysed book — while remaining a
starting point the user can override.

## Goals

For every **newly analysed** book, deterministically seed the narrator with:

1. A **localized display name** for the book's language, keeping the id fixed at
   `'narrator'` and adding `"Narrator"` as an alias so English-keyed lookups and
   search still resolve. English is unchanged (`"Narrator"`, no alias needed).
   - `de → Erzähler`, `ru → Рассказчик`, `es → Narrador`, `fr → Narrateur`,
     `en → Narrator`.
2. **One fixed folkloric persona**, identical across all languages (the exact
   string already accepted for the Coalfall Russian narrator):
   > "A middle-aged voice, neutral in gender, with a medium pitch and steady,
   > mid-paced delivery; the timbre is rich, grounded, and resonant, carrying a
   > measured, folkloric warmth suitable for audiobook narration."
   with the fields that accompany it: `gender: neutral`, `ageRange: adult`,
   `tone { warmth: 40, pace: 50, authority: 60, emotion: 40 }`,
   `attributes [formal, observational, measured, rhythmic]`.
3. Because the narrator now carries a `voiceStyle`, it **receives a designed
   Qwen voice** from that persona instead of falling back to the Kokoro preset —
   i.e. it is no longer skipped for voice generation.

The persona is a **default starting point**, not a lock. The user can rename the
narrator and re-write its voice-design prompt per book; a re-analysis/reparse
must never overwrite that edit.

## Non-goals

- **No migration of existing books.** New books only. Books already on disk
  (including the hand-fixed Coalfall library and the shipped samples) are
  untouched.
- **No new engine routing.** The narrator already renders on the book's default
  engine (`getSynthEngine` = `character.ttsEngine ?? projectDefaultEngine`,
  Qwen on a Qwen-default book). "Kokoro preset" is only the *fallback when no
  voice is designed*; seeding a persona so the narrator gets designed is the
  entire mechanism — we do not add a per-character engine field or a new palette.
- **No prompt-driven naming.** The name and persona are code constants, not
  model output — determinism is the whole point (model output cannot be
  consistent across books).

## Design

### New module: `server/src/analyzer/narrator-identity.ts`

Pure, dependency-light, mirroring the existing `narrator-default.ts` shape.

- `FOLKLORIC_NARRATOR` — a frozen constant holding the persona string plus the
  `gender` / `ageRange` / `tone` / `attributes` above. Single source of truth
  for the seeded voice identity.
- `applyNarratorIdentity(characters, language)` — pure and **idempotent**:
  1. Find the character with `id === 'narrator'` (or `'char-narrator'`). If none,
     return the input array unchanged.
  2. **Name + alias (always applied, name-replace guarded).** Ensure
     `"Narrator"` is in `aliases` (idempotent, never duplicated). Replace `name`
     with the localized narrator name for `language` **only when the current
     name is still a default** — the English `"Narrator"` or the language's own
     localized default; any other name is a user rename and is left alone.
  3. **Voice identity (gated on `voiceStyle` presence).** The folkloric
     `voiceStyle`, `gender`, `ageRange`, `tone`, and `attributes` are seeded as
     a single unit **only when the narrator has no `voiceStyle` yet**.
     `voiceStyle` presence is the one unambiguous "has this narrator's voice
     been established?" signal (the model always emits some `tone`/`attributes`,
     so those cannot themselves distinguish default from customized).
  4. Preserve `id`, `color: 'narrator'`, `description`, evidence, lines, and all
     other fields. (The book-specific `description` the model writes is left as
     is — the fixed `voiceStyle` is what drives voice design, not the blurb.)
  Returns a new array; never mutates the input.

**Where the guards actually bite (important — corrects a naive reading).**
`applyNarratorIdentity` runs on the **fresh** analyzer roster, which the model
always emits with the English default `name: "Narrator"` and **no**
`voiceStyle`. So on the fresh roster both guards are effectively defensive: the
name is always re-localized and the voice is always seeded from the constant.
The thing that actually preserves a user's override across a reparse is the
**cast merge** (next subsection), not the in-function guard. The guards still
matter for pure idempotency and for the (rare) caller that hands the function an
already-seeded roster; they never fight the merge.

### Preserving user overrides across reparse: the cast merge

Two of the three fields are **already durable** in
`server/src/store/merge-analysis-cast.ts`:

- `voiceStyle` is in `PRESERVED_VOICE_FIELDS`, so a user's re-designed narrator
  voice already survives reparse (`mergeAnalysisResultWithExistingCast` overlays
  it onto the fresh roster). No change needed.
- `aliases` are already **unioned** (old ∪ fresh), so the `"Narrator"` alias,
  once added, survives reparse. No change needed.

Only `name` is dropped: the merge deliberately recomputes `name` from the fresh
roster for every character (correct for real characters, whose names a
re-analysis legitimately re-derives). Because `applyNarratorIdentity` runs on the
fresh roster *before* the merge, the fresh narrator name is already the localized
default (e.g. `Erzähler`) — but a user who renamed the narrator to e.g.
"The Bard" would still lose it, since the merge takes the fresh name.

**Change:** extend the merge so that **for the narrator only**
(`id === 'narrator'`/`'char-narrator'`) it carries forward the prior `name`
**when that prior name is a user rename** — i.e. not any language's default and
not `"Narrator"`. A shared `isDefaultNarratorName(name)` helper (exported from
`narrator-identity.ts`, checking membership in the set of registry
`narratorName` values ∪ `"Narrator"`) decides. This gives all three outcomes:
a user rename survives; a never-renamed narrator takes the fresh localized name
(so a later *language change* re-localizes it correctly); and an untouched
reparse is idempotent. Real-character name-recompute is untouched.

### Registry: `narratorName` on `LanguageEntry`

`server/src/tts/language-registry.ts` is the existing single source of
per-language data. Add an optional field:

```ts
/** Localized narrator display name for this language. Absent on `en`
    (defaults to "Narrator"). */
narratorName?: string;
```

Populate `ru: 'Рассказчик'`, `es: 'Narrador'`, `fr: 'Narrateur'`,
`de: 'Erzähler'`. `en` omits it. `applyNarratorIdentity` reads the name via
`getLanguageEntry(language)?.narratorName ?? 'Narrator'`, so an unknown or
unsupported language safely falls back to `"Narrator"`.

### Wiring into the analyzer

There are **two** analyzer job functions in `routes/analysis.ts`, each with its
own final post-processing seam (next to `assignPaletteColors`) and its own
`cast.json` persist, and both must apply the identity:

- `runMainAnalyzerJob` — full analysis (the common path).
- `runSubsetAnalyzerJob` — the reparse-subset path.

In each, call `applyNarratorIdentity(roster, bookLanguage)` on the fresh roster
**before** it is (a) streamed to the confirm screen as `response.characters` and
(b) merged→persisted, threading the `bookLanguage` already resolved there
(`resolveBookLanguageForManuscript`, default `'en'`). Applying before the stream
means the confirm screen shows the localized name immediately; applying before
the merge means the persisted `cast.json` is localized, and the merge then layers
the preserved override fields on top (`voiceStyle` and the unioned `aliases`
already; a narrator user-rename per the merge change above).

**Interim live-preview previews are intentionally left alone.** The mid-run
`cast-update` SSE snapshots (`previewFoldForLiveView`) and running-snapshot
writes show the model's English `"Narrator"` until the run completes, then flip
to the localized name in the final roster. This transient flicker is cosmetic
and matches the existing pattern where a character's `voiceId`/design state also
only settles at completion — not worth threading the identity through every
interim path. (An interrupted run that is later resumed re-runs the final seam,
so the persisted result still ends up localized.)

`routes/voice-style.ts` is **unchanged**: it deliberately skips the narrator in
persona generation, which is exactly what we want now that the persona is
pre-seeded — the Gemini generator must not overwrite the fixed folkloric string.
The narrator then flows through `routes/cast-design.ts` (which has no narrator
skip; the client sends it in the design request because a narrator with a
`voiceStyle` but no designed Qwen voice resolves to "Needs voice") and gets a
designed Qwen voice. Note this only produces a designed narrator on
**Qwen-default books**; a Kokoro-default book keeps the narrator on its preset,
which is the intended behavior.

### Detection safety

Every narrator check in the codebase keys on the stable `id === 'narrator'`
first (`routes/voices.ts:isNarratorId`, `routes/voice-style.ts:isNarrator`,
`tts/voice-mapping.ts:inferProfile`, `analyzer/roster-coverage.ts`,
`analyzer/dialogue-structure/name-matcher.ts`, and the frontend
`lib/principal-cast.ts`, `modals/profile-drawer.tsx` `NARRATOR_ID`,
`lib/tts-voice-mapping.ts`). The name-based fallbacks are secondary and only
matter when the id is *not* `'narrator'`. Since the id is preserved, changing
the display name breaks nothing. The `"Narrator"` alias additionally keeps any
English text/search lookups resolving.

Two confirmed non-issues from review: **series-memory reuse** matches the
narrator by stable key (`voiceId ?? id`, `series-reuse-link.ts`), not by name,
so a localized name cannot undercount it; and the **export narrator credit**
(`export/narrator-credit.ts`) uses the `state.narratorCredit` book field
(author/"Castwright"), not the cast character name, so it is unaffected.

One intended, minor behavior change: **captions** (`export/build-captions.ts`
maps `speakerNames[c.id] = c.name`) will label narration cues with the localized
name ("Erzähler"/"Рассказчик"/…) for new non-English books. This is desirable
(the cue matches the book's language) and, per "no migration", does not touch
existing books or the shipped English-cast samples.

## Testing

New `server/src/analyzer/narrator-identity.test.ts`:

- Localizes the name per language (`de`→`Erzähler`, `ru`→`Рассказчик`,
  `es`→`Narrador`, `fr`→`Narrateur`); `en` stays `Narrator`.
- Adds `"Narrator"` to `aliases` exactly once (idempotent; no duplicate on a
  second apply).
- Preserves `id`, `color: 'narrator'`, and unrelated fields.
- Seeds the folkloric `voiceStyle` / `gender` / `ageRange` / `tone` /
  `attributes` as a unit when the narrator has no `voiceStyle`.
- **No-clobber name:** a narrator the user renamed (non-default name) keeps its
  name but still gains the `"Narrator"` alias.
- **No-clobber voice:** a narrator that already has any `voiceStyle` keeps all
  five voice-identity fields untouched (name localization still applies).
- **Idempotent:** applying twice equals applying once.
- **No-op** when the roster has no narrator, and for an unknown/unsupported
  language code (falls back to `Narrator`).

Registry: extend the existing registry expectations to cover `narratorName` for
the four non-English supported languages.

Cast merge (`merge-analysis-cast.test.ts`): a reparse where the prior narrator
had a **user rename** ("The Bard") keeps that name on the merged roster; a
reparse where the prior narrator name was a **language default** ("Erzähler")
takes the fresh roster's name (so a language change re-localizes); the designed
`voiceStyle` survives in both; and a **real character's** name is still
recomputed from the fresh roster (guard against over-preserving). Plus a unit
test for `isDefaultNarratorName` across the registry defaults + `"Narrator"`.

Analyzer pipeline: one assertion that a de (and ru) analysis yields the
localized name with the folkloric persona seeded, in **both** `runMainAnalyzerJob`
and `runSubsetAnalyzerJob`, proving the wiring.

## Rollout

Ships behind no flag — it is a deterministic default applied at analysis time.
Existing books are unaffected (no migration). A user who wants a different
narrator name or voice re-designs it in the UI as today; a re-designed voice
(`voiceStyle`) and unioned `aliases` already survive reparse, and the merge's
new narrator-`name` carry-forward protects a rename too.
