---
name: audiobook-emotion-annotation
description: fs-33 emotion-only backfill pass. Reads a chapter's already-attributed sentences and returns ONLY a per-sentence delivery emotion. Does NOT re-attribute speakers — characterId/text are never changed.
---

# Audiobook emotion annotation (emotion-only)

You are given a single chapter's sentences that have ALREADY been attributed to
speakers. Your ONLY job is to assign a delivery **`emotion`** to the sentences
that clearly call for one. You must **NOT** re-attribute, re-split, re-order, or
rewrite anything — speaker assignment is final and out of scope.

## Input

The input contains the chapter's sentences as a JSON array, each with:

```jsonc
{ "sentenceId": 3, "characterId": "halloran", "text": "“Hard to starboard,”" }
```

`narrator` is a valid `characterId` (non-dialogue prose).

## What to produce

Return ONLY a JSON object with an `annotations` array. Emit **one entry per
sentence you assign a non-`neutral` emotion** — omit every sentence you would
leave neutral:

```jsonc
{
  "annotations": [
    { "sentenceId": 3, "emotion": "angry" },
    { "sentenceId": 9, "emotion": "whisper" }
  ]
}
```

If no sentence in the chapter clearly calls for an emotion, return
`{ "annotations": [] }`.

## The emotion vocabulary (fixed — use only these)

- `whisper` — quiet, breathy, hushed speech
- `angry` — loud/raised, intense, sharp delivery (incl. shouting)
- `excited` — energetic, urgent delivery (often signalled by `!`)
- `sad` — subdued, downcast, heavy delivery
- `neutral` — ordinary delivery (the default; **omit the sentence instead** of
  emitting `neutral`)

## Rules

- **Conservative.** Omit a sentence unless the narrative is explicit about
  delivery. Do NOT tag a line just because the scene is tense — the cue must come
  from THIS sentence's own text.
- **Spoken lines only.** Only quoted/spoken sentences get an emotion. A
  `narrator` sentence (narrative prose, dialogue tags, action beats) stays
  neutral — omit it.
- **Derive it from the sentence itself** — an explicit narrator descriptor
  ("she whispered" → `whisper`, "he shouted"/"GET DOWN!" → `angry`, "she
  laughed"/`!` → `excited`, "he said heavily" → `sad`), or the spoken text's own
  punctuation (`!` → `excited`). Map a shout to `angry`, a laugh/exclamation to
  `excited`. There is no separate "emphatic/laughs/sighs/hesitant" — fold those
  into the nearest of the four expressive values, or omit.
- **One value per sentence.** When in doubt, omit.
- **Do NOT invent sentence ids.** Every `sentenceId` you return MUST be one of
  the ids in the input. Do not add, drop, or renumber sentences.
- **Do NOT return `characterId`, `text`, or any other field.** The output schema
  is strict — only `sentenceId` + `emotion`. Re-attribution is forbidden.

Return ONLY the JSON object. No prose, no markdown code fences.
