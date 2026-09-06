# Step 1 — A11 audition + A18 item 2 (Castwright#2994)

Ran on-box in `wt-human-checkpoint-batch` (branch `docs/docs-human-checkpoint-batch`),
against a real local Qwen (`qwen3-tts-0.6b`) engine and the real sidecar's ECAPA
`/embed`, no mocks. Dev stack: frontend `127.0.0.1:5363`, API `127.0.0.1:8270`,
TTS sidecar `127.0.0.1:9190`.

## A11 · A/B "current vs proposed" voice audition (plan 161)

Drove the redesign flow directly through its REST surface (the same calls
`RedesignLibraryVoiceModal` makes): `POST /api/voice-library/:uuid/redesign`,
`/redesign/discard` (Cancel), `/redesign/promote` (Approve), against a real
cast voice created for this check — `A11 Audition Test Voice`
(`voiceUuid: d0nnbNL9Qe2QULJ4JeLSZ`), Qwen persona "A calm, warm female
narrator voice with a slight British accent, mid-30s, speaking at a measured
pace."

### Cancel leaves the live `.pt` untouched — confirmed via hash

| Step | Live `.pt` SHA-256 |
|---|---|
| Before redesign | `2870c22ac740b2437c7a512fc1ed115bcfddcbcd90d2dfb24ed5f4238f901a94` |
| After `POST /redesign` (preview staged, persona: "A sharper, energetic male narrator voice, younger, faster pace, slightly theatrical delivery.") | `2870c22ac740b2437c7a512fc1ed115bcfddcbcd90d2dfb24ed5f4238f901a94` (unchanged) |
| After `POST /redesign/discard` (Cancel) | `2870c22ac740b2437c7a512fc1ed115bcfddcbcd90d2dfb24ed5f4238f901a94` (unchanged) |

Staged preview artifacts (`qwen-d0nnbNL9Qe2QULJ4JeLSZ-preview.pt/.json/__master.wav`)
existed on disk after `/redesign` and were confirmed removed after `/redesign/discard`.
The live `.pt`'s hash is byte-identical across all three checkpoints — Cancel is
non-destructive to the live voice, as the row requires.

**Asymmetry check (not required by the row, but confirms the mechanism):** a
second `/redesign` with the same proposed persona followed by
`POST /redesign/promote` (Approve) *did* change the live `.pt`'s hash to
`6870566e81f5bfc2ae0b5894052d5965e08f0329a13328ad05ae308613dd6c02` — proving the
hash-stability above is a real Cancel-path property and not just an inert
storage key.

### Audible delta on approve — staged for human judgment

Rendered both sides from the same redesign call (before the promote above):

- Current: `docs/testing/onbox-human-checkpoint-results/a11-current.mp3` — the
  original "calm, warm female narrator" persona.
- Proposed: `docs/testing/onbox-human-checkpoint-results/a11-proposed.mp3` — the
  "sharper, energetic male narrator" persona.

**Supporting number, not a substitute for the ear check:** cosine similarity
between the two clips' real sidecar `/embed` (ECAPA-TDNN, 192-d) speaker
embeddings is **0.246** (16 kHz mono PCM decoded from each mp3 via ffmpeg,
posted to the live sidecar's `POST /embed`). This is a genuinely different
speaker signature, consistent with the deliberately distinct personas, but the
row's own framing is right that the audible A/B delta — does the proposed take
actually sound like a deliberate, coherent redesign rather than noise — is a
human-ear judgment this evidence stages rather than forces.

**Remaining human checkpoint:** listen to both clips and judge whether the
audible delta reads as a *deliberate* redesign delta (matches the persona
change) versus an arbitrary regeneration artifact.

## A18 item 2 · Cloned-voice derive latent equivalence (torchcodec precondition)

Checked the precondition live, not assumed from the row text's date:

```
$ /c/Claude/Projects/wt-human-checkpoint-batch/server/tts-sidecar/.venv/Scripts/python.exe -c "import torchcodec"
...
OSError: Could not load this library: ...\torchcodec\libtorchcodec_core5.dll
...
OSError: Could not load this library: ...\torchcodec\libtorchcodec_core4.dll
[end of libtorchcodec loading traceback]
```

`import torchcodec` **fails** exactly as item 1's discharge note describes —
this box is still genuinely static-FFmpeg (reverted 2026-07-31), not a
shared-FFmpeg box.

**BLOCKED-ACQUISITION:** item 2's own precondition — "a box with a genuinely
shared FFmpeg" — is absent here. Per the ticket's own instruction, this run did
**not** attempt to reconfigure this shared box's FFmpeg/torchcodec install to
manufacture that precondition — doing so would risk every other row/lane that
depends on the current static-FFmpeg state (including A18 item 1's own
discharge). No faked work, no staged evidence pretending the precondition is
met. Item 2 needs a genuinely shared-FFmpeg box to proceed; this dev box is not
one.

## Scope note

Did not touch A18 items 1, 3 (already discharged) or item 4 (belongs to
#2950). Did not edit the acceptance register (that's step 8 / #2985). No PR
opened, per the ticket's scope.
