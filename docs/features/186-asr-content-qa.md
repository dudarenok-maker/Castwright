---
status: active
shipped: null
owner: null
---

# 186 — ASR content verification for per-sentence audio QA (srv-31)

> Status: active
> Key files: `server/tts-sidecar/main.py` (`WhisperEngine`, `/transcribe`), `server/src/tts/transcribe-client.ts`, `server/src/tts/segment-asr-qa.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapter-qa-repair.ts`, `scripts/audit-audio-asr-drift.mts`
> URL surface: indirect — runs inside generation + the existing `POST /api/books/{id}/chapters/{ch}/audio-qa-repair`
> OpenAPI ops: none new (reuses `audioQaRepairChapter`)

## Benefit / Rationale

The plan-179 signal QA (`segment-qa.ts`) catches dead / silent / wrong-length
audio. It provably CANNOT catch the last defect class: a generation that is
fluent, correct length, correct loudness, but says the **wrong words** (a clone-
prompt slip, a hallucinated word, a digit read wrong). Only comparing *what was
said* to *what was meant* finds those — i.e. ASR.

- **User:** garbled-but-plausible sentences are caught and re-recorded instead of
  shipping; the back-catalog can be swept and repaired.
- **Technical:** a CPU-first (GPU-opt-in) Whisper transcribe + word-error-rate
  check, gated behind `SEG_ASR_ENABLED`, with the WER policy in TypeScript and
  the model in the sidecar.
- **Architectural:** ASR is a 4th sidecar engine (audio→text), deliberately
  outside the synth `ENGINES` map; it rides the existing weighted VRAM semaphore
  (cost `asr`) only on the GPU path so it can never tip the 8 GB card.

## Architectural impact

- **New seams:** `WhisperEngine` + `POST /transcribe` in the sidecar; `transcribe-client.ts` (server transport + conditional GPU token); `segment-asr-qa.ts` (`classifyTranscript` pure WER policy + `verifySegmentTranscript`); `SynthesiseChapterOpts.asr` pass; `ChapterSegment.asr` / `asrSuspect`; `asr:1` in `ENGINE_VRAM_COST`.
- **Invariants preserved:** OFF by default (`SEG_ASR_ENABLED` unset → byte-identical to today, like plan-179's `maxSegmentRerecords=0`). Per-character voice consistency preserved — persistent drift is flagged + shipped, **never** cross-engine-fallback. The one-poll `/health` invariant holds (asr fields fan out from the same response). CPU-default → zero VRAM, so the "every sentence" pass never contends with synth.
- **Migration:** none. The per-sentence ASR verdict persists on each `ChapterSegment` (segments.json) — no new on-disk artifact.
- **Reversibility:** unset `SEG_ASR_ENABLED`. The sidecar `faster-whisper` dep is dormant until then.

### VRAM-contention design (the crux)

On the 8 GB Windows card, GPU overflow does NOT OOM cleanly — it silently spills
to host RAM over PCIe and collapses synth RTF (`reserved_mb > total_mb` →
"VRAM SPILL" in `/health`, soft-recycle at 90%). Real generation footprint is
~6 GB reserved → ~1.2 GB headroom. A `tiny`/`base` int8 Whisper is ~150–400 MB,
so it FITS and runs at RTF ~0.02–0.03 — but management is defense-in-depth:
**CPU default** (zero VRAM); GPU path **rides the weighted semaphore** (`asr:1`)
so it serialises behind Coqui/analyzer; **transient idle-evict** (`ASR_IDLE_TTL`,
mirrors the Qwen VoiceDesign watchdog); ASR and Qwen VoiceDesign are **disjoint by
lifecycle** (design = cast-review, ASR = generation/repair). Cap GPU ASR at
`base` on an 8 GB card.

### Trustworthiness (why the gate stays on)

A gate that false-flags a good "Wren Sparrow" line gets switched off. So:
deterministic decode (temp 0, greedy, `condition_on_previous_text=False`, VAD);
hard normalization (case/punctuation/contractions/small-int spelling);
sub/del/ins decomposition with a deletion-run truncation check; Whisper intrinsic
signals (high `compression_ratio` → drift on the loop tell; low `avg_logprob` /
high `no_speech_prob` → **inconclusive**, never a re-record); per-book proper-noun
allowlist (cast names); short sentences not scored.

## Invariants to preserve

- `segment-qa.ts` `evaluateSegmentPcm` stays **synchronous + pure** — ASR is a
  separate async pass, never folded in (`segment-qa.ts:20` purity contract).
- ASR OFF unless `SEG_ASR_ENABLED` ∈ {1,true,yes,on} (`segment-asr-qa.ts:asrEnabled`).
- Persistent drift → `asrSuspect` + ship best take; no hard-fail, no cross-engine fallback (`synthesise-chapter.ts` ASR pass).
- GPU token only on `ASR_DEVICE=cuda` (`transcribe-client.ts:asrRunsOnGpu`); CPU path takes none.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_transcribe.py`) — deterministic decode params, intrinsic signals worst-case, 24k→16k resample, CPU default, idle-evict, `/transcribe` poison/drain fences, `/health` asr fields (15 cases).
- Vitest server (`server/src/tts/transcribe-client.test.ts`) — PCM body + headers, language normalization, GPU token only on cuda, 5xx→transient (7).
- Vitest server (`server/src/tts/segment-asr-qa.test.ts`) — normalization, ok/drift/inconclusive, deletion-run, compression-ratio drift, untrusted→inconclusive, name allowlist, short-skip (13).
- Vitest server (`server/src/tts/synthesise-chapter-asr.test.ts`) — drift re-records + keeps clean retake, persistent drift→asrSuspect, clean no-op, inconclusive no re-record, sampleEvery stride, absent=no-op (6).
- Vitest server (`server/src/routes/chapter-qa-repair-asr.test.ts`) — the repair scan flags a signal-clean but wrong-words segment via ASR (1).

### Manual acceptance walkthrough

Requires a real sidecar with Whisper (`pip install faster-whisper`), `SEG_ASR_ENABLED=1`.

1. **Garbled fixture** — synth a sentence whose audio is right-length/right-loudness but wrong words → flagged + re-recorded; a looped take → flagged via `compression_ratio`; a fantasy-name line → NOT flagged (allowlist); an all-correct chapter → no extra re-records. Confirm segments.json carries each `asr` verdict.
2. **Back-catalog audit** — `npx tsx scripts/audit-audio-asr-drift.mts` on a real book → per-chapter/per-engine drift counts, no writes.
3. **CPU VRAM = 0** — a chapter with `ASR_DEVICE=cpu` leaves `/health` `vram_reserved_mb` unchanged vs a no-ASR run.
4. **GPU headroom** — with Qwen resident, `ASR_DEVICE=cuda`, a chapter keeps `reserved_mb` below the 90% soft ceiling (no `recycle_pending`, no VRAM SPILL) and synth RTF doesn't collapse. *(The issue's acceptance bar — owed on the live box.)*

## Out of scope

- True overlap of the ASR pass with the next chapter's synth WITHIN one worker — the multi-worker queue already overlaps chapter N's CPU ASR with chapter N+1's GPU synth; a single-worker run does the ASR pass inline.
- UI surface for `asrSuspect` beyond the existing suspect plumbing (a follow-up if needed).
- Non-English WER tuning — the language hint is threaded (`bookLanguage` → base subtag); Russian/etc. accuracy is owed validation.

## Ship notes

(Filled in when status flips to `stable`: shipped date + commit SHA. Live-GPU
acceptance — garbled fixture + VRAM headroom with Qwen resident — owed before
flipping default on.)
