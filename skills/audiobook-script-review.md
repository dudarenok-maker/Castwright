---
name: audiobook-script-review
description: fs-58 per-chapter script review pass. Reads a chapter's attributed sentences + cast and returns a list of edit ops across six classes (strip_tag, split, extract_dialogue, merge, fix_emotion, validate_instruct). Does NOT re-attribute from scratch — only targeted surgical corrections.
---

# Audiobook script review

You are given a single chapter's attributed sentences and the book's cast. Your
job is to identify and return a list of targeted edit ops that would improve the
script for text-to-speech performance. You must NOT re-write the whole chapter —
only flag the specific sentences that need correction.

## Input

The input contains:
1. The chapter's sentences as a JSON array, each with:
   ```jsonc
   { "sentenceId": 3, "characterId": "halloran", "text": ""Hard to starboard,"",
     "instruct": "clipped, urgent",        // OPTIONAL, English — present only when the sentence has one
     "vocalization": true }                // OPTIONAL — present only when text carries a machine-prepended sound
   ```
   `instruct` is an English delivery direction; `vocalization: true` marks a
   sentence whose `text` was given a machine-prepended non-verbal sound.
2. The book's cast (id → name mapping) so you can reference character ids.

## Op classes

Return ONLY a JSON object `{ "ops": [...] }`. Each op has:

- `id` — the `sentenceId` of the target sentence, copied exactly from the input
  (NOT a new sequential counter starting from 1)
- `op` — one of the six classes below
- `rationale` — one-line explanation (required for every op)
- `confidence` — optional float 0–1

### `strip_tag`

Remove a speech-attribution tag that was incorrectly left in the text (e.g. `"he
said"`, `"she whispered softly"`). Supply `anchor` (verbatim substring to locate
the sentence) and `newText` (the sentence with the tag stripped).

**Vocalization protection:** NEVER strip intentional non-verbal vocalizations
such as "Ah!", "Haah…", "Mmm" — these are spoken content, not attribution tags.
Only strip true speech-attribution tags ("he said", "she whispered").
Otherwise, leave intentional vocalizations to `validate_instruct`.

### `split`

Split a sentence that spans two speakers. Supply:
- `anchor` — copied verbatim from the sentence (enough to locate it uniquely)
- `pieceCharacterIds` — array of character ids, one per piece after the split

### `extract_dialogue`

A narration sentence contains embedded dialogue that should become its own
sentence attributed to the speaker. Supply:
- `anchor` — start of the dialogue span (verbatim)
- `anchorEnd` — end of the dialogue span (verbatim)
- `pieceCharacterIds` — exactly 3 elements: [narrator_id, speaker_id, narrator_id]

### `merge`

Merge two or more adjacent same-speaker narrator sentences into one. Supply:
- `mergeIds` — array of sentence ids to merge (must be adjacent, same speaker)

### `fix_emotion`

Override the delivery emotion only when the current emotion is clearly wrong for
the sentence. Supply:
- `anchor` — verbatim substring to locate the sentence
- `emotion` — one of: `neutral` | `whisper` | `angry` | `excited` | `sad`

### `validate_instruct`

Review the per-line `instruct` (always **English**) and any vocalization. The line
may be in any language (en/ru/es/fr/de); the instruct is always English.

- **Strip** an instruct that contradicts the line, is malformed, leaks content meant
  to be spoken, or is written in the book's language instead of English — supply
  `newInstruct: ""`.
- **Repair** such an instruct to a corrected English phrase — supply a non-empty
  `newInstruct`. Only repair a sentence that ALREADY has an instruct; never author one.
- **Repair/strip a vocalization** that is a non-pronounceable stage-direction or in the
  wrong language — supply `newVocalizationText` (the corrected `text`, in the book's
  language) and `vocalization` (`true` to keep the sound flag, `false` to drop it).

Do NOT police "duplicates spoken content" — you cannot see the pre-prepend text.
Abstain when in doubt.

## Rules

- Only flag sentences that clearly need correction. When in doubt, omit.
- Every `anchor` must be copied **verbatim** from the sentence text — do not
  paraphrase or summarise.
- Every `id` in `mergeIds` must be a real sentenceId from the input.
- Every character id in `pieceCharacterIds` must be a real cast id from the
  input.
- Return `{ "ops": [] }` if the chapter needs no corrections.
- Output JSON only. No prose, no markdown code fences.
