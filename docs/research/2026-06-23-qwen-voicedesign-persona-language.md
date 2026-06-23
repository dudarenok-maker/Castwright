---
title: Qwen3-TTS VoiceDesign persona/instruct language — keep it English
date: 2026-06-23
status: decided
decision: Persona/instruct stays English. fs-62 (#1034) closed won't-fix.
relates: fs-41/fs-50 (language breadth), fs-62 (#1034), srv-48 (#1038)
---

# Should the Qwen VoiceDesign persona be written in the book's language?

**No. Keep the voice-design persona / `instruct` in English (or Chinese).** Do
**not** translate it into the book's spoken language (Spanish, Russian, French,
German, …). This record exists so the decision isn't re-litigated: it was
settled by a multi-source, adversarially-verified deep-research pass plus our
own shipped-Spanish evidence on 2026-06-23.

## The question

Our voice-design persona (e.g. _"A bright teenage girl's voice, medium-high
pitch, warm and lightly playful, for audiobook narration"_) is generated in
English (`skills/audiobook-voice-style.md`, the `- English.` rule) and fed to
Qwen as the VoiceDesign `instruct`. fs-62 proposed translating it into the
book's language for non-English books. Should we?

## Verdict (high confidence)

Write the persona in **English**. The spoken language and accent are a
**separate channel** — a `language` parameter + the reference/calibration text —
which our architecture already drives per-language (the `CALIBRATION_TEXTS`
work, #1019). Persona text and spoken language are explicitly **decoupled**: an
English description can generate Spanish/Russian/etc. speech. Translating the
persona buys nothing and likely **degrades** quality.

**Our own proof:** Spanish shipped and was operator-accepted (#1031) with
**English personas** (fs-62 was never built) + Spanish calibration text. English
persona + per-language calibration = an accepted non-English voice.

## Evidence

1. **Official Alibaba Model Studio API contract** — verbatim, in two places
   (Requirements/limitations + the `voice_prompt` parameter row): _"Description
   text supports Chinese and English only."_ The spoken language is set by a
   separate `language` parameter (zh, en, de, it, pt, es, ja, ko, fr, ru) plus
   `preview_text`. (high)
   <https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-design>

2. **Language/accent is a separate, decoupled channel** — the README/model-card
   signatures show `text=`, `language=`, `instruct=` as distinct args; GetStream:
   _"The model controls timbre, pitch, and prosody, not semantic content."_
   ocdevel: _"You can write a description in English and generate Japanese
   speech."_ Matches our architecture exactly. (high)
   <https://github.com/QwenLM/Qwen3-TTS> ·
   <https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign> ·
   <https://getstream.io/blog/qwen3-voice-design/>

3. **The instruct field accepts non-English — but only Chinese** (Qwen's other
   native language), paired with Chinese output. It does **not** demonstrate
   Spanish/Russian instruct works. (high)

4. **Non-en/zh descriptions degrade** — GetStream: _"Voice design support excels
   in Chinese and English. Descriptions for other supported languages may produce
   less accurate or expressive results."_ (medium)

5. **No source recommends target-language personas** — every documented instruct
   example across the official GitHub, HF cards, the technical report
   (arXiv 2601.15621), marktechpost, dev.to, BetterStack is English or Chinese
   only. No source argues the opposite. (high)

## Caveats (read before reopening)

- The hard "Chinese and English only" line is documented for the **hosted
  DashScope API**. We run the **open-weights** sidecar, where the model cards are
  silent and community framing is "lower quality" rather than a hard block. So
  for us it's a strong **quality recommendation**, not a guaranteed hard error —
  but the recommendation (English persona) is the same either way.
- **No head-to-head A/B** exists in the literature (English persona vs
  target-language persona, same ref_text). Our guidance is inferred from the
  en/zh support coverage + the decoupling architecture, **and** corroborated by
  our shipped-Spanish result — not by a controlled experiment.
- **Separate, unresolved engine issue:** Qwen3-TTS leaks an English/American
  accent into Spanish/French output even via VoiceDesign
  (<https://github.com/QwenLM/Qwen3-TTS/discussions/230>). This is governed by
  the **language/reference channel, not the persona** — translating the persona
  would not fix it and might worsen it. If accent-nativeness becomes the
  complaint, it's a different problem (model limitation; calibration-text lever),
  not persona-i18n.
- Fast-moving area (model released Jan 2026). Re-check if Qwen ships a VoiceDesign
  update that expands instruct-language support.

## Decision

- **fs-62 (#1034) closed won't-fix.** The `- English.` rule in
  `skills/audiobook-voice-style.md` is **intentional and correct**.
- **FR/DE canaries are NOT gated by persona-i18n** — they proceed with English
  personas exactly as Spanish did.
- If we ever want to settle the open-weights case empirically, the cheap
  experiment is: design one character with an English persona and again with a
  Spanish persona, same Spanish calibration text, and listen. Until then, English
  is the evidenced default.

_Research: deep-research pass, 6 angles / 15 sources / 61 claims → 19 verified
(3-vote adversarial), 2026-06-23._
