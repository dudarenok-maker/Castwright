---
status: active
shipped: null
owner: null
---

# 150 — Denormalise Qwen persona (`voiceStyle`) at the auto-match write site

> Status: active (live acceptance pending → stable)
> Key files: `server/src/tts/hydrate-reused-voice.ts`, `server/src/routes/cast-link-prior.ts`, `server/src/workspace/series-reuse-link.ts`, `server/src/routes/book-state.ts`
> URL surface: indirect — Profile Drawer "Voice persona" textarea (cast/confirm views); on-disk `cast.json`
> OpenAPI ops: none (write-time denormalisation on existing routes; no contract change)

## Benefit / Rationale

- **User:** n/a directly — the persona was already visible via plan 149's read-time drawer fallback. This makes the on-disk data match what the user sees, so a fresh reuse is correct without waiting for a backfill run.
- **Technical:** closes the last write-time gap from plan 149 — a freshly designed-then-reused Qwen character now carries its `voiceStyle` on disk the moment it is auto-matched/linked, with no reliance on the periodic backfill or read-time fallback.
- **Architectural:** completes the plan-138 "read-time resolve **+** denormalise-on-write" doctrine for the persona. Plan 138 did it for the voice *link* (`overrideTtsVoices`, follow-up `srv-14`); plan 149 did read-time + heal-once for the *persona*; this is the persona's denormalise-on-write half — the direct sibling of `srv-14`.

## Context

A reused Qwen character carries `voiceId` + `matchedFrom` but its bespoke voice (`ttsEngine` + `overrideTtsVoices`) and persona (`voiceStyle`) live on the SOURCE book's character. Plan 138 added denormalise-on-write for the voice link at three reuse write sites; plan 149 added read-time + backfill for the persona but deliberately deferred the write-time copy (filed as `srv-18`). Until that copy exists, a fresh reuse lands without a denormalised `voiceStyle` on disk — masked by the drawer's read-time fallback, but the on-disk `cast.json` is not self-consistent until the next `scripts/backfill-qwen-voicestyle.mjs` run. This plan makes the three write sites copy `voiceStyle` alongside the voice they already denormalise.

## Architectural impact

- **Shared resolver carries the field:** `ReuseHydratable` and `ResolvedReusedVoice` (`server/src/tts/hydrate-reused-voice.ts`) gain `voiceStyle?: string`. `resolveReusedVoiceFields` returns `source.voiceStyle` when it finds the source that owns the bespoke voice; `hydrateCharacterVoice` widens its return `Pick<…>` to include `voiceStyle` and merges it `character.voiceStyle ?? resolved.voiceStyle` (own value wins — never clobbers). This single change carries the field through the two sites that funnel the resolver:
  - `series-reuse-link.ts` (analysis-time series auto-match) — adds `c.voiceStyle = c.voiceStyle ?? resolved.voiceStyle` next to the existing engine/override assignments.
  - `book-state.ts` (generic `PUT /state` cast funnel via `hydrateCastReusedVoices`) — no code edit; flows through the widened helper return.
- **Inline site patched directly:** `cast-link-prior.ts` (manual continuity link) has its own inline denormalise block; it gains `mergedSource.voiceStyle = source.voiceStyle ?? target.voiceStyle` inside the existing `shouldDenormaliseVoice` guard.
- **Same gate as the voice override:** persona denormalisation rides on the SAME condition as the voice-override denormalisation — it fires only for a reused character that lacks its own bespoke qwen voice (the resolver early-returns `null` when the character already owns one). The narrow residual case (a char with its own override but no persona) stays covered by plan 149's read-time drawer fallback. This is intentional — it matches the shipped sibling rather than widening the gate.
- **Reversibility:** purely additive. When a `voiceStyle` already exists, or no source persona resolves, behaviour is unchanged.

## Invariants to preserve

- `resolveReusedVoiceFields` early-returns `null` when `hasOwnQwenVoice(character)` (`server/src/tts/hydrate-reused-voice.ts:63`) — persona denormalisation must NOT fire independently of the voice denormalisation.
- `hydrateCharacterVoice` merges own-over-source for every field (`overrideTtsVoices` slots, `ttsEngine`, and now `voiceStyle`) — the character's own value always wins (`server/src/tts/hydrate-reused-voice.ts`).
- `cast-link-prior.ts` only writes inside `if (voiceIdChanged || shouldDenormaliseVoice)`, and the persona copy stays inside the `shouldDenormaliseVoice` branch — a pure voiceId unification (no qwen voice) must not stamp a persona.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/hydrate-reused-voice.test.ts`) — resolver carries `source.voiceStyle`; `hydrateCharacterVoice` copies the source persona onto a reused char that lacks one, and keeps the char's own persona (never clobbers).
- Vitest server (`server/src/routes/cast-link-prior.test.ts`) — the link denormalise copies the target's `voiceStyle` onto the source; a source with its own persona is left untouched.
- Vitest server (`server/src/workspace/series-reuse-link.test.ts`) — analysis-time series link denormalises `voiceStyle` from the source book.
- Vitest server (`server/src/routes/book-state-reuse-denormalise.test.ts`) — the `PUT /state` cast funnel stamps `voiceStyle` onto a reused character at write time.

All four files green: `cd server && npm run test -- hydrate-reused-voice cast-link-prior book-state-reuse-denormalise series-reuse-link` (38 tests).

### Manual acceptance walkthrough (real backend)

1. In book A, design a Qwen voice for a character (persona persisted to the sidecar `instruct` + `character.voiceStyle`).
2. Auto-match that same character into a fresh book B (re-run analysis on B, or use the manual continuity link), WITHOUT running `scripts/backfill-qwen-voicestyle.mjs`.
3. Read B's `cast.json` (`C:\AudiobookWorkspace\books\<Author>\<Series>\<Title>\.audiobook\cast.json`) → the reused character now carries `voiceStyle` populated from the source, plus `ttsEngine` + `overrideTtsVoices.qwen`.
4. No-clobber: give the reused character a hand-edited `voiceStyle` first, then trigger the write path → the hand-edited persona is preserved.

## Out of scope

- The read-time fallback + one-shot backfill — shipped in [plan 149](149-qwen-persona-display-backfill.md). This plan does not change either; it removes the *need* to re-run the backfill for new reuses.
- Widening the gate to copy a persona onto a character that already owns its own qwen voice but lacks a persona — covered by the read-time drawer fallback; intentionally not added here to match the `srv-14` sibling's behaviour.

## Ship notes

(Filled when status flips to `stable`: shipped date + commit SHA.)
