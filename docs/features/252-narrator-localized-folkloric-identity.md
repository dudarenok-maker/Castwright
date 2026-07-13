---
status: active
shipped: null
owner: null
---

# Localized folkloric narrator identity

> Status: active
> Key files: `server/src/analyzer/narrator-identity.ts`, `server/src/tts/language-registry.ts`, `server/src/routes/analysis.ts`, `server/src/store/merge-analysis-cast.ts`
> URL surface: indirect — confirm screen (`#/books/<id>/confirm`) shows the seeded narrator name/voice; no dedicated route
> OpenAPI ops: none (no schema change — `CharacterOutput` fields used were already optional)

## Benefit / Rationale

- **User:** every newly analysed book's narrator now carries the display name for the book's own language (`Erzähler` / `Рассказчик` / `Narrador` / `Narrateur` / `Narrator`) instead of an English `"Narrator"` literal regardless of language, and starts from one consistent, designed folkloric voice instead of the anonymous Kokoro-preset fallback — with no hand-editing of `cast.json` required.
- **Technical:** the narrator's identity (name + voice persona) is now a deterministic code-seeded default rather than ad hoc per-book model output, applied uniformly by a single pure module reused at both analyzer job seams.
- **Architectural:** establishes the pattern of a per-language "default identity" for a structurally-special character (id-keyed, not name-keyed) that a user can still override, with the override's durability owned by the cast merge rather than the seeding function itself — a seam other structurally-special characters (e.g. a future narrator-like role) could reuse.

## Architectural impact

- **New seams / extension points:**
  - `LanguageEntry.narratorName?: string` on the existing per-language registry (`server/src/tts/language-registry.ts`), populated for `ru`/`es`/`fr`/`de`; `en` omits it (falls back to `"Narrator"` at the call site).
  - `isDefaultNarratorName(name)` (same file) — the single source of truth for "is this name a replaceable default," consumed by both the seed module and the cast merge.
  - `applyNarratorIdentity(characters, language)` (`server/src/analyzer/narrator-identity.ts`) — pure, idempotent, mirrors the existing `narrator-default.ts` shape. Exports `FOLKLORIC_NARRATOR` (the frozen persona constant) and `NARRATOR_DEFAULT_NAME`.
- **Invariants preserved:**
  - Narrator detection stays keyed on `id === 'narrator'` / `'char-narrator'` everywhere (`routes/voices.ts`, `routes/voice-style.ts`, `tts/voice-mapping.ts`, `analyzer/roster-coverage.ts`, `analyzer/dialogue-structure/name-matcher.ts`, frontend `lib/principal-cast.ts`, `modals/profile-drawer.tsx`) — changing the display name breaks none of these since the id is untouched.
  - `routes/voice-style.ts` keeps skipping the narrator in Gemini persona generation — the fixed folkloric string must never be overwritten by the persona generator now that it is pre-seeded.
  - Series-memory reuse (`series-reuse-link.ts`) matches by `voiceId ?? id`, not name, so localization cannot undercount it. Export narrator credit (`export/narrator-credit.ts`) uses `state.narratorCredit`, not the cast character name, so it is unaffected.
- **Migration story:** none — no schema/storage shape change (`CharacterOutput` fields used — `name`, `aliases`, `voiceStyle`, `gender`, `ageRange`, `tone`, `attributes` — were already optional/present). No migration of existing on-disk casts or shipped samples; the seed only runs on a fresh analyzer roster.
- **Reversibility:** removing the `applyNarratorIdentity` call sites in `routes/analysis.ts` reverts to prior behavior with no cleanup needed — no persisted flag or migrated data depends on it.

## Invariants to preserve

1. Narrator ids stay exactly `'narrator'` / `'char-narrator'` — `narrator-identity.ts:NARRATOR_IDS` (`server/src/analyzer/narrator-identity.ts`) keys on both; every other narrator check in the codebase keys on id first, never on display name.
2. `applyNarratorIdentity` name-replace is guarded: it only overwrites `name` when the current value is a default (`isDefaultNarratorName`, `server/src/tts/language-registry.ts`) — a user rename is never touched by the seed function itself.
3. `applyNarratorIdentity` voice-identity seed (`voiceStyle`/`gender`/`ageRange`/`tone`/`attributes`) is gated as a single unit on "no `voiceStyle` yet" — an already-customized narrator voice is left fully untouched, even if `name` still localizes.
4. The seed runs at both analyzer job seams in `server/src/routes/analysis.ts` — `runMainAnalyzerJob` (full analysis) and `runSubsetAnalyzerJob` (reparse-subset) — before the roster is streamed to the confirm screen and before it is merged/persisted.
5. `mergeAnalysisResultWithExistingCast` (`server/src/store/merge-analysis-cast.ts`) carries the prior `name` forward for the narrator only, and only when that prior name is **not** a default (`isDefaultNarratorName`) — i.e. a genuine user rename survives reparse, while an untouched default re-localizes on a language change. Real-character name recompute-from-fresh is unchanged.
6. `voiceStyle` and `aliases` were already durable across reparse before this feature (`PRESERVED_VOICE_FIELDS` overlay; aliases unioned old ∪ fresh) — no change needed there, and this plan must not regress that.
7. `FOLKLORIC_NARRATOR`'s persona string is fixed and identical across every language — it is not model output and is not re-generated by `routes/voice-style.ts` (narrator skip unchanged).
8. No migration: `applyNarratorIdentity` only ever runs on a freshly-analysed/reparsed roster. Existing on-disk `cast.json` files and the shipped sample books are never touched by this feature.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/language-registry.test.ts`) — `narratorName` present for `de`/`ru`/`es`/`fr`, absent on `en`; `isDefaultNarratorName` true for the English default and every localized default (case-insensitive, trimmed), false for a user rename and for empty/nullish.
- Vitest server (`server/src/analyzer/narrator-identity.test.ts`) — localizes the name per language (`en` stays `Narrator`); adds the `"Narrator"` alias exactly once (idempotent on a second apply); seeds the folkloric voice identity as a unit when no `voiceStyle` exists; preserves `id`/`color`/`description`/other characters untouched; does **not** clobber a user rename (still adds the alias); does **not** clobber an existing `voiceStyle` or its companion fields (name localization still applies); is idempotent end-to-end; no-ops with no narrator in the roster and falls back to `Narrator` for an unrecognised language code; never mutates its input.
- Vitest server (`server/src/routes/analysis.test.ts`) — the existing `analysisProvenance` persistence tests for both `runMainAnalyzerJob` and `runSubsetAnalyzerJob` assert the persisted `cast.json`'s narrator carries the `"Narrator"` alias and a `voiceStyle` containing `"folkloric warmth"` — proving the wiring ran on the actual persist path in both jobs (language resolves to `en` in that harness; per-language localization is unit-covered above).
- Vitest server (`server/src/store/merge-analysis-cast.test.ts`) — a reparse where the prior narrator name was a **user rename** ("The Bard") keeps that name (and its prior `voiceStyle`) on the merged roster; a reparse where the prior name was a **language default** ("Erzähler") takes the fresh roster's (re-localized) name; a real (non-narrator) character's name is still recomputed from the fresh roster, unaffected by the narrator-only carry-forward.

### Manual acceptance walkthrough

Run against the real server + analyzer (not mock mode — this is server-side analyzer behavior with no frontend code change).

1. **Analyse a German-language manuscript** (`cd server && npm run dev`, upload/analyse a `de` book through the normal flow) → expected: the confirm screen's cast list shows the narrator character named **`Erzähler`**, not `Narrator`.
2. **Open the narrator's Voice Profile on the confirm/cast screen** → expected: the narrator shows a **designed Qwen voice** (or is eligible for one, on a Qwen-default book) rather than the anonymous Kokoro-preset fallback — its persona reads the fixed folkloric string ("A middle-aged voice, neutral in gender, with a medium pitch and steady, mid-paced delivery…").
3. **Rename the narrator** (e.g. to "Der Erzähler") and confirm the cast.
4. **Trigger a reparse** of the same book (edit the manuscript slightly, or use the per-chapter Reanalyse action) → expected: after the reparse completes, the narrator's name is still **"Der Erzähler"** — the rename survived — while its `voiceStyle` (if separately re-designed) also survives via the existing `PRESERVED_VOICE_FIELDS` overlay.
5. **Analyse an English-language manuscript** → expected: narrator name is unchanged (`Narrator`), confirming English behavior is byte-identical to before this feature.

## Out of scope

- **Migration of existing books.** Books already on disk (including the hand-fixed Coalfall library and the shipped samples across all five languages) are untouched — those casts were hand-authored and stay as-is.
- **New engine routing.** The narrator still renders on the book's default engine (`getSynthEngine`); seeding a `voiceStyle` is the entire mechanism for getting it a designed voice — no new per-character engine field or palette. See plan [108 — Qwen3-TTS coexistence](108-qwen-coexistence.md).
- **Prompt-driven naming.** The localized name and persona are code constants, not model output — see the spec's "Non-goals" for the determinism rationale.
- **UI changes.** No new component, route, or OpenAPI surface — the confirm/cast screens already render whatever `name`/`voiceStyle` the cast carries.

Full design: `docs/superpowers/specs/2026-07-13-narrator-localized-folkloric-identity-design.md`. Implementation plan: `docs/superpowers/plans/2026-07-13-narrator-localized-folkloric-identity.md`.

## Ship notes

(Filled in when status flips to `stable`.)
