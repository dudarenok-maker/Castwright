---
status: active
shipped: null
owner: null
---

# 176 — Per-character re-record / splice (fs-26)

> Status: active
> Key files: `server/src/audio/splice-chapter.ts`, `server/src/audio/finalize-chapter-write.ts`, `server/src/routes/chapter-splice.ts`, `server/src/tts/{mp3,gain-pcm}.ts`, `src/modals/fix-character-audio.tsx`, `src/lib/api.ts`
> URL surface: `POST /api/books/{bookId}/chapters/{chapterId}/splice` (SSE); UI entry on the cast profile drawer
> OpenAPI ops: `POST /api/books/{bookId}/chapters/{chapterId}/splice`

## Benefit / Rationale

- **User:** fix ONE character across rendered chapters without regenerating whole chapters. The headline case: a too-quiet voice (e.g. "Castor") gets a loudness boost in seconds — no GPU, no full re-render. Re-record is there for wrong pronunciation/tone.
- **Technical:** a single byte-range splice engine serves both a no-GPU gain re-mix and a GPU re-record; reuses the existing encode/loudnorm/`.previous.*` machinery, so the A/B + rollback player works unchanged.
- **Architectural:** decode → substitute target segments → re-time → re-encode is a reusable primitive. `buildCharacterSnapshots` is now shared between generation and splice so drift snapshots can't diverge.

## Why loudness ≠ re-record (the core product insight)

Chapter audio is loudness-normalised to a fixed integrated target (−16 LUFS) over the whole chapter. Re-synthesising a character with the same voice reproduces the same *relative* quietness. The fix for "too quiet" is a **per-character gain** applied to that character's segments, then a whole-chapter loudnorm re-pass. Because loudnorm targets integrated loudness with essentially one program-wide gain, boosting a character changes their level **relative to the rest** while the chapter stays at −16 LUFS — exactly the desired outcome. (See `chapter-splice.ts` header + the gain test.)

## Architectural impact

- **New seams:** `spliceChapterSegments` (pure engine), `decodeAudioToPcm` (mp3.ts), `applyGainToPcm` (gain-pcm.ts), `finalizeChapterAudioWrite` (shared encode/persist tail), `buildCharacterSnapshots` (extracted), `chapter-job-coordination.ts` (mutual displacement), `api.streamSplice`.
- **Invariants preserved:** segments-file shape unchanged; `.previous.*` preservation reused verbatim (A/B + rollback); state.json duration/QA stamped identically to a regen; never-cross-language (re-record forces Qwen + forbids the Kokoro fallback on non-English books, like generation).
- **Reversibility:** every splice preserves the prior take as `.previous.*`; reject restores it. The endpoint is additive — no existing route changed behaviour.
- **Deliberate scope cut:** generation.ts still inlines its own encode/persist tail; converging it onto `finalizeChapterAudioWrite` is a follow-up (kept the hot generation path untouched in this PR). `buildCharacterSnapshots` IS already shared.

## Invariants to preserve

1. `secToByteOffset` MUST use `round` (not floor): synthesis stamped `endSec = bytes/(sr*2)`, so `round(sec*sr)*2` recovers the exact byte boundary — floor accumulates drift.
2. Everything outside a replaced segment's byte range is copied **verbatim** from the decoded PCM (head/lead-silence, inter-segment gaps, title beat, tail). The engine never special-cases the title silences.
3. Reassembly integrity: `runningBytes === reassembled pcm.length` (engine throws otherwise; pinned in `splice-chapter.test.ts`).
4. `decodeAudioToPcm` MUST force `-ar <segments.sampleRate>` so the decoded grid matches the timings the cut points are computed from.
5. Gain is sample-count-preserving (`applyGainToPcm`), so a remix never shifts downstream timings or changes duration.
6. A splice and a full regen of the same chapter mutually displace each other (`chapter-job-coordination.ts` + `abortInFlightChapterJob`) — they must never both write the chapter's files.

## Test plan

Automated:
- `server/src/audio/splice-chapter.test.ts` — timing/duration integrity, gap reconstruction, downstream shift, drift round-trip, invariant, validation.
- `server/src/tts/gain-pcm.test.ts`, `decode-audio-to-pcm.test.ts` — real-ffmpeg gain math + decode round-trip.
- `server/src/audio/{character-snapshots,build-synth-replacement}.test.ts` — shared snapshot shape + re-record replacement wiring.
- `server/src/routes/chapter-splice.test.ts` — remix route end-to-end (target region louder, `.previous.*` preserved, duration unchanged) + validation + graceful re-record failure paths.
- `src/modals/fix-character-audio.test.tsx` — candidate filtering, one splice per chapter, pending revisions, remix vs re-record args.
- e2e: `e2e/character-splice.spec.ts` (mock mode) — open cast profile → Fix audio → Loudness → apply → completion.

Manual (owed — live GPU + sidecar):
- Rendered book → Castor profile → Fix audio → +3 dB → all chapters → confirm. Verify each chapter's Castor segments get louder, duration unchanged (gain), `.previous.*` written, A/B audition works, chapter loudness stays ≈−16 LUFS (`ffprobe`/lufs sidecar). Then re-record one chapter's Castor lines: verify timing integrity (downstream shift, no seam, no doubled title). Canonical manuscript per CLAUDE.md.

## Ship notes

Merged to `main` 2026-06-03 via **PR #500** (merge commit `25bf3aa`). `Refs #480` — fs-26's substantive capability (per-character remix + rerecord engine, route, cast-drawer UI) shipped; the literal line-level Listen-view per-sentence entry stays open under #480. Status remains `active` (not `stable`) until the owed **live-GPU re-record acceptance** runs (remix/gain validated with real ffmpeg in CI; the GPU synth path needs a sidecar run on the canonical manuscript). Follow-up `srv-29` (#501) tracks converging generation.ts onto `finalizeChapterAudioWrite`.

**Polish round 2026-06-03 (post-merge follow-ups):** (1) **bug** — re-record now skips the title beat (`kind:'title'`, empty `sentenceIds`) so picking the narrator can't splice silence over the chapter title (`isRerecordableSegment`). (2) the Listen row refreshes immediately on splice — `chaptersActions.markChapterAudioUpdated` bumps duration + an `audioRenderedAt` stamp, and the mini-player cache-busts the audio URL with it (so a gain remix, which keeps the same URL + duration, still reloads fresh bytes). (3) the per-chapter batch moved out of the modal into `splice-runner-middleware` + a `splice` slice, so it survives the modal closing and surfaces a global progress toast; the modal is now a dispatcher that tracks its batch by id. (4) the modal warns the gain is relative to the current audio (stacks on re-apply) and nudges try-one-chapter-first. (5) a full-run mock e2e (`cc`/Eliza) clicks apply→completion. Remaining: live-GPU acceptance, `srv-29`, and the line-level Listen entry (#480).

**Follow-up round 2026-06-05 (this closes #480):** the line-level Listen-view per-sentence entry shipped — a re-record marker on the Listen MarkersPanel now carries a "Fix this line" action that resolves the marker's timestamp → the chapter segment (`lib/resolve-segment-for-sec.ts`) → `{characterId, segmentIndex}` and opens `FixCharacterAudioModal` pre-scoped to that single segment in rerecord mode (`segmentIndices` threaded through `splice-slice`/`splice-runner-middleware` → `api.streamSplice`); a kind toggle on the panel lets a note become a re-record marker. `srv-29` (#501) also landed (generation.ts converged onto `finalizeChapterAudioWrite` via an `onEncoded` callback), so fs-26's substantive scope is now fully delivered. **Still owed: live-GPU re-record acceptance** — `status` stays `active` until that runs.
