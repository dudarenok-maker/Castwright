# A `preparing-voice` phase for the cloned/designed voice resolver pre-pass

**Date:** 2026-07-26
**Issue:** #1813
**Branch:** `feat/server-preparing-voice-phase` (cut after `fix/frontend-audition-engine-tier` merges)
**Status:** design approved, plan pending

## Context

fs-38 Wave 3b2 added a per-chapter resolver pre-pass
(`server/src/tts/clone-voice-resolver.ts`) that can re-derive a Repairable cloned
voice, or self-heal a missing designed-voice `.pt`, before any synth call fires.
Both paths call `deps.reportProgress?.('Preparing voice "<name>"…')`, but
production wires `reportProgress: undefined`
(`server/src/tts/synthesise-chapter.ts:950` and `:1030`) because there is no
free-text progress channel on `SynthesiseChapterOpts` — only typed per-group and
per-title ticks.

Effect: a multi-second sidecar clone-distil round trip shows no UI signal. The
generation view simply appears idle before synth resumes. Logged as known-limitation
KL-f in `docs/testing/fs38-wave3-onbox-acceptance.md`.

## Design

A typed phase tick, mirroring `chapter_recovering` (Wave 3, C2) end to end. That
precedent exists for exactly this shape of problem — a real, healthy, multi-second
wait that reads as a stall — and it already threads openapi → slice → caption.

The alternative of a free-text `note` on the progress tick was rejected: the SSE
contract has so far deliberately kept captions typed and frontend-owned, and one
free-text field invites more.

### Chain

1. `ClonedVoiceRequest` (`clone-voice-resolver.ts:181`) and `DesignedVoiceRequest`
   (`:399`) gain `characterId`. Both request lists are already built from
   `CastCharacter` (`synthesise-chapter.ts:1233`, `:1262`), so this is `c.id`.
2. Both deps interfaces swap `reportProgress?(msg: string)` for
   `onVoicePrepare?(e: { characterId: string; characterName: string })` — a typed
   payload, with no caption string built server-side.
3. New `SynthesiseChapterOpts.onVoicePrepare`, threaded through
   `buildDefaultCloneResolverDeps` and `buildDefaultDesignedResolverDeps` (which
   take only `signal` today), retiring both `reportProgress: undefined` placeholders.
4. `server/src/routes/generation.ts` broadcasts
   `{ type: 'chapter_preparing_voice', chapterId, characterId, progress, currentLine, totalLines }`
   and calls `bumpProgress()`.
5. `openapi.yaml:4358` — add `chapter_preparing_voice` to the `GenerationTick.type`
   enum plus a description paragraph alongside the `chapter_recovering` one; then
   `npm run openapi:types`.
6. `src/lib/types.ts` — the chapter `phase` union gains `'preparing-voice'`;
   `src/store/chapters-slice.ts` gets a branch beside the `chapter_recovering` one
   at `:500` (hold the row `in_progress`, carry progress, set the phase).
7. `src/views/generation.tsx` — a caption beside the `recovering` one at `:1631`,
   resolving the display name through the same `findChar` the live "Synthesising
   …" caption already uses: `Preparing voice — Lord Vane…`.

### Heartbeat

Each pre-pass is wrapped so the last `onVoicePrepare` payload re-fires on the
existing `groupHeartbeatMs` cadence (10 s), reusing the `withHeartbeat` helper at
`synthesise-chapter.ts:1498`.

A derive can pull the VoiceDesign model in cold (~4–5 GB), which can exceed the
client's 30 s `STALL_THRESHOLD_MS`. Without the re-fire, the fix for a silent
pause could itself trip a false "Worker has gone quiet" banner — the same failure
`chapter_recovering` documents on its own 10 s heartbeat.

## Testing

- **Resolver:** `onVoicePrepare` fires with the right payload for a Repairable
  voice, and does not fire for a healthy one.
- **Wiring (placebo trap):** `synthesiseChapter` actually delivers `opts.onVoicePrepare`
  into *both* resolvers' deps. This is the specific bug being fixed — the callback
  is `undefined` in production today — so a test that never exercises the real
  builders would pass without proving anything. Assert against
  `buildDefaultCloneResolverDeps` / `buildDefaultDesignedResolverDeps`, not a
  hand-built deps object.
- **Heartbeat:** the payload re-fires on the interval while a derive is pending.
- **Slice:** mirror the existing `chapter_recovering` describe
  (`chapters-slice.test.ts:401`) — phase set, row held `in_progress`, progress carried.
- **View:** the caption renders for a chapter in the new phase.

No e2e. The mock SSE would have to be taught to emit a tick that only fires behind
a real sidecar derive, and this does not cross a router/redux/layout seam — the
bar Vitest+jsdom can lie about.

## Ship notes

Clears KL-f in `docs/testing/fs38-wave3-onbox-acceptance.md` and owed item (f) in
`docs/features/268-fs38-wave3b2-resolver.md:376`; both should be updated in the
same PR.
