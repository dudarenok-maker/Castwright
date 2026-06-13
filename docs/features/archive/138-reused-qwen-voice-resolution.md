---
name: 138-reused-qwen-voice-resolution
status: stable
title: Reused Qwen voice resolution (no silent Kokoro fallback for reused characters)
---

# Plan 138 — Reused Qwen voice resolution

## Problem

A reused Qwen character (one matched/linked to a prior book in the series)
rendered chapters in the generic **Kokoro fallback voice** instead of its
**designed Qwen voice**, silently. The cast view compounded it: the Status pill
read **"Designed"** while the voice sub-line read **"Qwen · No voice designed
yet"** — two contradictory readouts on the same row (observed on Wraythe,
Rayni, Lord Vane; verified against `C:\AudiobookWorkspace`).

## Root cause

A reused character carries only `voiceId` + `matchedFrom` on disk — the reuse
write paths (`voice-match.ts`, `cast-link-prior.ts`) propagate the identity key
but **not** `ttsEngine` / `overrideTtsVoices`. The bespoke Qwen voice lives on
the **source book's** character that designed it (`overrideTtsVoices.qwen.name`,
e.g. `qwen-garrow`; the on-disk weights are `voices/qwen/qwen-<voiceId>.pt`).

At synthesis, `pickVoiceForEngine('qwen', voice)`
(`server/src/tts/voice-mapping.ts`) reads **only** `overrideTtsVoices.qwen.name`
— it never consults `voiceId`. For a reused character that slot is empty, so it
returns `''`; `resolveCharacterEngine` still routes the character to Qwen (the
project default), and `applyQwenFallback`
(`server/src/tts/synthesise-chapter.ts`) sees the empty voice name and renders
the chapter in Kokoro. No source-book hydration existed anywhere in the synth
path.

The frontend mirrored the same gap: `resolveDisplayTtsVoice` read only the
character's own override, and `resolveLifecyclePill` counted a character as
"Designed" whenever the matched Voice merely resolved to the `qwen` *provider*,
ignoring whether it carried an actual name.

## Fix (four layers)

1. **Frontend pill honesty** (`src/lib/voice-status.ts`): `resolveLifecyclePill`
   now requires a non-empty designed name —
   `provider === 'qwen' && !!ttsVoice.name` — else **"Needs voice"**. A
   provider-only match with an empty name no longer mislabels as "Designed".

2. **Frontend row display** (`src/lib/tts-voice-mapping.ts`,
   `resolveDisplayTtsVoice`, moved out of `cast.tsx` to be pure/testable): for a
   reused Qwen character with an empty own override, fall back to the matched
   library Voice's `ttsVoice` when it is itself a named qwen voice.

3. **Server runtime hydration** (`server/src/tts/hydrate-reused-voice.ts` +
   `hydrate-reused-voice-workspace.ts`): a pure resolver follows the
   `matchedFrom` chain back to the source book holding the override and folds its
   `ttsEngine` + `overrideTtsVoices` onto the character. Wired into **generation**
   (cast hydrated once after load, before engine detection + `synthesiseChapter`
   + drift snapshots) and the **voices API** aggregation (so the cast view's
   `ttsVoice` reflects the designed voice). No-op for non-reused or
   already-designed characters; runtime never probes the on-disk `.pt` files.

4. **Denormalise on write** (`server/src/routes/cast-link-prior.ts`): a manual
   continuity link now copies the target's designed `ttsEngine` +
   `overrideTtsVoices` onto the source at link time, so the record is
   self-complete (never clobbers an explicit source override). The auto-match
   path is the same idea — tracked as BACKLOG `srv-14`.

## Data recovery

`scripts/repair-reused-qwen-overrides.mjs` is a one-time migration that writes
the resolved override back onto every reused cast character: (1) via the
`matchedFrom` source chain, or (2) **recovery-only** — when no book in the chain
carries an override but the deterministic `voices/qwen/qwen-<voiceId>.pt` exists
on disk — reconstruct `{ qwen: { name: qwen-<voiceId> } }`. The on-disk fallback
is the *only* way to recover a voice whose override was lost in every book (Lord
Vane); the runtime path deliberately omits it. Dry-run by default; `--apply`
writes after a `.bak`; `BASE` / `AUDIOBOOK_WORKSPACE` override the root.

Applied to the live workspace 2026-05-29: 4 cast files written; 21 reused
characters fixed via source chain, 10 recovered from disk (incl. Lord Vane),
16 left unresolved (genuinely never-designed — correctly stay on Kokoro).

## Tests

- `src/lib/voice-status.test.ts` — empty-name matched qwen Voice ⇒ "Needs
  voice"; named ⇒ "Designed".
- `src/lib/resolve-display-tts-voice.test.ts` — reused fallback to matched qwen
  Voice; empty stub; never borrows a non-qwen preset.
- `server/src/tts/hydrate-reused-voice.test.ts` — source-chain hydration,
  multi-hop chain, cycle guard, missing source, and the "override lost in every
  book" case (correctly returns null → migration-only recovery).
- `server/src/routes/cast-link-prior.test.ts` — denormalises the designed qwen
  voice onto the source at link time.

## Ship notes

Shipped 2026-05-29 on branch `fix/qwen-reused-voice`. Commits: frontend pill+row
(6d3549d), server runtime hydration (5f3ae5f), migration script (78989a9),
denormalise-on-write (a585a17). Follow-up: BACKLOG `srv-14` (auto-match
denormalisation). Related: `108-qwen-coexistence`,
`archive/117-qwen-voice-presentation`, `archive/123-reused-voice-drawer-parity`,
`135-qwen-loud-fallback`.
