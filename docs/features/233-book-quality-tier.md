---
status: stable
shipped: 2026-06-25
owner: null
---

# fs-66 — Book-wide higher-quality (Qwen 1.7B) tier

> Status: stable
> Key files: `server/src/tts/resolve-instruct.ts`, `server/src/tts/voice-mapping.ts`,
> `server/src/tts/synthesise-chapter.ts`, `server/src/routes/generation.ts`,
> `server/src/routes/voices.ts`, `server/src/routes/cast-tier.ts`,
> `src/components/sentence-instruct-control.tsx`, `src/views/manuscript.tsx`,
> `src/views/generation.tsx`, `src/views/cast.tsx`, `openapi.yaml`
> URL surface: Cast view (Pin/Reset roster actions) + Regenerate modal (#229 Model picker)
> OpenAPI ops: `POST /api/books/{bookId}/cast/tier`
> Issue: [#1134](https://github.com/dudarenok-maker/Castwright/issues/1134)
> Spec: `docs/superpowers/specs/2026-06-25-book-level-higher-quality-tier-design.md`

## Benefit / Rationale

- **User:** render a whole book at the expressive **Qwen 1.7B** tier in one action
  (a cast-roster bulk pin, or by picking 1.7B in the existing Regenerate Model
  picker) instead of toggling every cast row. "1.7B" now uniformly means the
  expressive, emotionally-delivered rendering — one concept, one vocabulary.
- **Technical:** prosody is now a pure function of the resolved 1.7B model key
  (`is17b`); the separate per-book `liveInstruct` synth gate is gone. A dedicated
  series-tier endpoint keeps the quality tier orthogonal to the voice-identity
  override.
- **Architectural:** locks the invariant that **1.7B ⇒ prosody** at the synth
  resolver, so any path that routes a group to 1.7B (per-cast, regen override,
  bulk pin) gets expressive delivery without a second flag.

## Architectural impact

- **Removed seam:** the `synthesiseChapter` `liveInstruct` option and the
  generation-view "Live expressive delivery (1.7B)" toggle (#1100). `liveInstruct`
  survives in `book-meta-slice` only as the analysis-time "annotations were
  produced" signal (used by the deferred Phase 3 / fs-65), **not** as a synth gate.
- **New seam:** `POST /api/books/{bookId}/cast/tier` (`server/src/routes/cast-tier.ts`)
  + `applyTierToCastFiles` (`voices.ts`) + `api.setCastTier` — a series-scoped
  `ttsModelKey` write reusing `forEachMatchingCastCharacter`. Touches **only**
  `ttsModelKey`; never the `overrideTtsVoices`/`ttsEngine` identity axis.
- **Migration:** none required. On-disk audit found no cast.json pinning 1.7B and
  both persisted books had `liveInstruct:false`, so flipping the gate to `is17b`
  changes zero shipped renders.
- **Reversibility:** "Reset tier" clears `ttsModelKey` series-wide; the regen
  override is per-render. Re-introducing a separate prosody toggle would require
  re-adding the `liveInstruct` synth arg (deliberately removed).

## Invariants to preserve

- Prosody gate is `is17b` alone — `server/src/tts/resolve-instruct.ts:32`
  (`if (!is17b) return {}`). The book `liveInstruct` flag is NOT a synth gate.
- `is17b` is auto-derived from `route.modelKey === 'qwen3-tts-1.7b'`
  (`synthesise-chapter.ts` batch/packer/instructHash sites), never forced true for
  a non-Qwen route.
- Emotion-variant selection on 1.7B returns the **base** voice (emotion via
  instruct phrase, not `__emotion` suffix) — `voice-mapping.ts` `pickEmotionVariantVoice`.
- The series-tier write touches ONLY `ttsModelKey` — `voices.ts` `applyTierToCastFiles`
  (no `normaliseCastCharacter`, no override-map write).
- Manuscript instruct audibility = per-speaker `character?.ttsModelKey === 'qwen3-tts-1.7b'`
  — `src/components/sentence-instruct-control.tsx`.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/resolve-instruct.test.ts`) — gate returns the
  instruct phrase iff `is17b`, regardless of any book flag.
- Vitest server (`server/src/tts/voice-mapping.test.ts`) — `pickEmotionVariantVoice`
  returns base voice on 1.7B, `__emotion` on 0.6B, base for non-Qwen.
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — a 1.7B batch group
  gets an instruct phrase with no `liveInstruct` option; 0.6B gets none; a 1.7B
  group with a designed variant routes emotion via instruct, not the variant voice.
- Vitest server (`server/src/routes/voices.test.ts`) — `applyTierToCastFiles` pins
  across sibling books and clears with `null`.
- Vitest server (`server/src/routes/cast-tier.test.ts`) — `POST /cast/tier` pins
  the tier to **exactly 2** sibling books; 400 on bad voiceId/ttsModelKey; 404 on
  unknown book.
- Vitest frontend (`src/components/sentence-instruct-control.test.tsx`) — chip is
  audible / marks stale for a 1.7B-pinned speaker; muted for 0.6B.
- Vitest frontend (`src/views/generation.test.tsx`) — the prosody toggle is gone.
- Vitest frontend (`src/views/cast.test.tsx`) — Pin writes `ttsModelKey` on Qwen
  members only, dispatches `setCastTier` per distinct voiceId, shows the roster
  badge; Reset clears it (badge gone); errors surface via `pushToast`.
- Playwright e2e (`e2e/book-quality-tier.spec.ts`) — Regenerate → pick "Qwen3-TTS
  1.7B" → the queued entry's `modelKey === 'qwen3-tts-1.7b'`.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`).

1. **Cast view of a Qwen book** → a "Pin higher quality to all cast" action is
   visible (≥1 Qwen member). No per-row "1.7B" badges yet.
2. **Click Pin → confirm** (dialog states the cross-book reach) → every Qwen row
   shows a "1.7B" badge; non-Qwen rows do not.
3. **Open a chapter in the manuscript** → instruct chips on 1.7B-pinned speakers
   render audible (not greyed); editing one marks the chapter stale.
4. **Regenerate a chapter, pick "Qwen3-TTS 1.7B", confirm** → the queued render
   requests the 1.7B tier (prosody applied).
5. **Cast view → Reset tier → confirm** → badges disappear; rows back to default.
6. **Generation view** → there is no "Live expressive delivery" toggle.

## Ship notes

Shipped **2026-06-25** via PR [#1136](https://github.com/dudarenok-maker/Castwright/pull/1136),
merge commit `6e080bb7`, Closes [#1134](https://github.com/dudarenok-maker/Castwright/issues/1134).
Delivered as one integration PR (four logical units: gate collapse, manuscript reader
migration + #1100 toggle removal, series-tier endpoint, cast bulk pin). Built via SDD
(spec ×2 review rounds + plan ×2 review rounds + per-task reviews + opus whole-branch
review). Full `npm run verify` green before merge. Follow-up: [#1135](https://github.com/dudarenok-maker/Castwright/issues/1135)
(pre-existing clipped RegenerateModal footer, surfaced by the e2e).
