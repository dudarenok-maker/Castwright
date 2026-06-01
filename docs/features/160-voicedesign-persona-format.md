---
status: active
shipped: null
owner: null
---

# Align the Qwen voice-design persona prompt with the official VoiceDesign format

> Status: active — code shipped, GPU audition validation owed to the user
> Key files: `server/src/analyzer/voice-style.ts` (`buildVoiceStylePrompt`)
> URL surface: indirect — Profile drawer "Regenerate voice style" / `POST /api/books/{bookId}/cast/{characterId}/voice-style/generate`
> OpenAPI ops: none changed

## Benefit / Rationale

Every Qwen cast voice is *designed* from a natural-language persona string. That
string is produced by a single `gemini-3.1-flash-lite` call in
`buildVoiceStylePrompt` and fed verbatim as the `instruct` argument to
`Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`
(`server/tts-sidecar/main.py` `generate_voice_design(text, language, instruct)`).
We checked our persona draft against Qwen's official VoiceDesign guidance
(Alibaba Cloud Model Studio docs + the HF model card) and found it sub-optimal on
two of the three axes that drive design quality — **structure** and
**inclusions**:

| Axis | Official recommendation | Ours before | Verdict |
|---|---|---|---|
| **Length** | ≤2048 chars; sweet spot **15–40 words, 1–3 sentences** | "one clause, ~30 words" | OK but tight |
| **Structure** | full sentence ending in a **purpose/scenario clause** (*"…ideal for audiobook narration."*) | bare comma fragment, no purpose | **Miss** |
| **Inclusions** | gender, age, **pitch**, pace, emotion, timbre, **purpose** | timbre/age/gender/pace/temperament/emotion — no pitch, no purpose | **Miss** |
| Objectivity | physical/perceptual voice qualities, not feelings/plot | drifted into psychology ("a hint of anxiety") | Partial |

Qwen's five official principles for a good description: **specificity,
multidimensionality, objectivity** (describe how the voice sounds, not the
speaker's feelings/backstory), **originality** (no celebrity mimicry),
**conciseness**.

- **User:** newly-generated / re-generated personas describe pitch and a use-case
  the model was trained to anchor on, so designed voices should sit closer to the
  intended register.
- **Technical:** the persona now matches the format the VoiceDesign model's own
  docs exemplify — fewer "off" designs from an under-specified instruct.
- **Architectural:** n/a — one prompt-builder rewrite; no new seam, no contract
  change, no data migration.

Sources:
[Alibaba Cloud — Qwen voice design API reference](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-design),
[Qwen3-TTS-12Hz-1.7B-VoiceDesign (HF card)](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign),
[QwenLM/Qwen3-TTS (GitHub)](https://github.com/QwenLM/Qwen3-TTS).

## Architectural impact

- **What changed:** only the instruction text, rules, word band, and worked
  example inside `buildVoiceStylePrompt`. The character profile block and the
  dialogue-evidence quotes that feed the prompt — the strongest signal — are
  unchanged. `describeTone`, `cleanPersona`, and `generateVoiceStylePersona` are
  untouched (`cleanPersona` already collapses a multi-sentence answer to one
  clean `instruct` line).
- **No migration.** The change applies to personas generated *from now on*.
  Existing books keep their current `voiceStyle` strings and their
  already-designed `voices/qwen/<id>.pt` embeddings until a user re-generates the
  persona AND re-designs the voice. No hand-edited persona is clobbered.
- **Reversibility:** revert the single file; no persisted state depends on the
  new wording.

## Invariants to preserve

- `buildVoiceStylePrompt` still ends with `Character profile:\n<block>` followed
  by the trailing `Voice-design persona:` cue, and still instructs `Output ONLY`
  the persona (so `cleanPersona` + the empty-response guard stay valid).
- Still ONE Gemini call per character (no batching — persona can't be
  contaminated by a neighbour), pinned to `gemini-3.1-flash-lite`
  (`VOICE_STYLE_MODEL`-overridable). See plan 108 Wave 4.
- `instruct` stays English (Qwen VoiceDesign supports Chinese/English only).

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/voice-style.test.ts`):
  - existing `buildVoiceStylePrompt` cases (profile fields, evidence quotes,
    6-quote cap, `Output ONLY`) stay green;
  - **new** case "requests the official Qwen VoiceDesign format" asserts the
    prompt instructs for **pitch**, for a **purpose clause** (`/audiobook
    narration|character dialogue/`), for **objective qualities not feelings**
    (`/NOT the character's feelings/`), and for the **15–40-word** band.

### Manual acceptance walkthrough (real backend + sidecar, GPU)

1. Open a Qwen character's Profile drawer → **Regenerate voice style** (or
   `POST /api/books/:bookId/cast/:characterId/voice-style/generate`). Expect a
   full-sentence persona, ~15–40 words, including a pitch word and ending in a
   purpose clause.
2. **Design voice** → audition. Compare against a character still on an
   old-format persona. Confirm the new `instruct` is what got cached:
   `voices/qwen/<voiceId>.json` `instruct` field.
3. Confirm an un-regenerated character still plays its existing designed voice
   (no silent change to existing books).

## Out of scope

- Re-generating all personas + re-designing all cached voices for existing books
  (deferred — would cost Gemini quota + significant GPU time and overwrite
  hand-edited personas). Tracked as a backlog follow-up.
- Per-quote emotion/intonation at synth time (still deferred — Qwen ignores
  per-utterance `instruct` on cloned voices; see `108-qwen-coexistence.md`).

## Ship notes

(Filled in when status flips to `stable` after the GPU audition confirms the
quality delta. Append shipped date + commit SHA, then move to
`docs/features/archive/`.)

Related: [108-qwen-coexistence.md](108-qwen-coexistence.md) (voice-design origin),
[149-qwen-persona-display-backfill.md](149-qwen-persona-display-backfill.md) and
[150-srv18-voicestyle-denormalise-write.md](150-srv18-voicestyle-denormalise-write.md)
(persona persistence/display).
