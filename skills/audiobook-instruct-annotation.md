---
name: audiobook-instruct-annotation
description: fs-57 Stage-3 instruct/vocalization pass. Reads a chapter's already-attributed, already-emotion-tagged sentences and adds (a) an open-ended TTS delivery instruct and/or (b) a pronounceable non-verbal vocalization for sentences where the narrative explicitly signals one. Does NOT re-attribute, re-split, re-order, or rewrite dialogue — speaker assignment and emotion tags are final and out of scope.
---

# Audiobook instruct + vocalization annotation (Stage 3)

You are given a single chapter's sentences that have ALREADY been attributed to
speakers and (optionally) tagged with delivery emotions. Your ONLY job is to:

1. Add a free-form **`instruct`** field to sentences where the narrative gives
   explicit delivery guidance beyond a simple emotion tag (e.g. "slurred",
   "through tears", "barely above a whisper, cracking on the last word").
2. Write a pronounceable **vocalization** into the `text` field — and set
   `"vocalization": true` — for sentences where the narrative explicitly
   describes a non-verbal sound (a gasp, sigh, laugh, hesitation sound) that
   is NOT already present as printed speech in that sentence's text.

You must **NOT** re-attribute, re-split, re-order, or rewrite anything — speaker
assignment is final and out of scope.

---

## Input

The input is a JSON array of sentences, each with at minimum:

```jsonc
{
  "sentenceId": 14,
  "characterId": "elara",
  "text": "She gasped, stepping back from the door."
}
```

`narrator` is a valid `characterId` for narrative prose sentences.

---

## What to produce

Return **ONLY** a JSON object with an `"annotations"` array. Each entry targets
one sentence by its `"sentenceId"`. All three content fields are optional; omit
any field you have nothing meaningful to add:

```jsonc
{
  "annotations": [
    {
      "sentenceId": 14,
      "text": "Hah— ",
      "vocalization": true,
      "instruct": "a sharp, startled inhale — cut off mid-breath"
    },
    {
      "sentenceId": 22,
      "instruct": "barely above a whisper, voice cracking on the last word"
    }
  ]
}
```

If no sentence in the chapter calls for either field, return
`{ "annotations": [] }`.

---

## The `sentenceId` contract

The `"sentenceId"` value in every entry MUST be copied exactly from the input sentence — it is NOT a new 1-based counter, NOT a sequential index you generate. Every id you emit must correspond to an id that existed in the input. Do not add, drop, or renumber sentences.

This constraint is strict: a wrong id silently misroutes the annotation to the
wrong sentence in the TTS pipeline.

---

## The two output fields

### `instruct` (delivery instruction — **English**)

A short, open-ended phrase describing a nuanced vocal quality the TTS engine
should produce. Always written in **English**, regardless of the manuscript's
language. Examples:

- `"a long, tired sigh"`
- `"clipped, impatient — nearly cutting off the next speaker"`
- `"soft and distant, as if talking to herself"`
- `"voice drops to almost nothing on the last syllable"`

Only add `instruct` when the narrative gives delivery detail richer than what
the emotion tag alone covers. Do not paraphrase the emotion tag.

### `text` + `vocalization: true` (non-verbal sound — **manuscript's language**)

When the narrative explicitly describes a non-verbal vocal reaction (a gasp,
sigh, laugh, groan, hesitation), write the pronounceable representation of that
sound **in the book's / manuscript's language** (e.g. "Ах!" in Russian, "¡Ay!"
in Spanish, "Haah…" in English) and set `"vocalization": true`.

**Edit the existing sentence's `text` — never insert a new sentence.** Prepend
or edit the sentence's text so the vocalization sound appears as part of that
sentence's spoken output. The `text` field in your annotation replaces the
stored sentence text for TTS purposes. When the vocalization makes a narrative
description of that same sound redundant (e.g. the sound replaces "she sighed"),
you MAY drop only that now-redundant sound-description — but do NOT remove,
reorder, or rewrite any OTHER words of the sentence. Prepending without removing
anything is always safe; trimming is allowed ONLY for the sound-description the
vocalization replaces.

Vocalization text style guide (open-ended — not a fixed list):
- Sounds should be pronounceable and natural in the manuscript's language.
- Use the orthographic conventions of that language (e.g. Russian uses "Ах",
  "Хм", "О…"; Spanish uses "¡Ay!", "Uf…", "Ah"; English uses "Ah!", "Haah…",
  "Hmm").
- A real Unicode ellipsis (…) is preferred over three ASCII dots for trailing
  sounds or hesitations.

---

## Rules

- **Conservative.** Omit unless the narrative makes the reaction explicit in
  that specific sentence. Do NOT infer from scene mood. One vocalization per
  sentence at most.
- **Never insert a new sentence.** Do not add entries with ids not present in
  the input. Vocalizations go into the existing sentence's `text` only.
- **`instruct` is in English.** Always. Even when the manuscript is in Spanish,
  Russian, French, or any other language.
- **Vocalization `text` is in the manuscript's language.** Match the
  orthographic and phonetic conventions of that language.
- **Do NOT return `characterId`, `emotion`, or any other field** not listed in
  the schema above. The output schema is strict.
- **One entry per sentence.** If a sentence warrants both `instruct` and a
  vocalization, combine them in a single entry.
- **Do NOT invent sentence ids.** Every `sentenceId` you return must be copied exactly from the input — not a new 1-based counter.

---

## Worked examples

### English

Input sentence:
```jsonc
{ "sentenceId": 7, "characterId": "mira", "text": "She sighed and closed her eyes." }
```

Output:
```jsonc
{
  "annotations": [
    {
      "sentenceId": 7,
      "text": "Hhhh… She closed her eyes.",
      "vocalization": true,
      "instruct": "a long, slow exhale — heavy and resigned"
    }
  ]
}
```

### Spanish

Input sentence:
```jsonc
{ "sentenceId": 3, "characterId": "berrin", "text": "Berrin dejó escapar un grito ahogado al ver la puerta abierta." }
```

Output:
```jsonc
{
  "annotations": [
    {
      "sentenceId": 3,
      "text": "¡Ah! Berrin dejó escapar un grito ahogado al ver la puerta abierta.",
      "vocalization": true,
      "instruct": "a sharp, shocked intake of breath"
    }
  ]
}
```

### Russian

Input sentence:
```jsonc
{ "sentenceId": 11, "characterId": "ivo", "text": "Иво устало выдохнул и опустился на стул." }
```

Output:
```jsonc
{
  "annotations": [
    {
      "sentenceId": 11,
      "text": "Ах… Иво устало выдохнул и опустился на стул.",
      "vocalization": true,
      "instruct": "a tired, defeated exhale"
    }
  ]
}
```

---

Return ONLY the JSON object. No prose, no markdown code fences.
