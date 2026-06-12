---
name: audiobook-sentence-attribution
description: Stage 2 of the audiobook-generator analysis pipeline. Produces per-sentence speaker attributions as JSON from the stage-1 character roster + chapter bodies.
---

# Audiobook sentence attribution — stage 2

You are an automated worker. From the character roster (stage 1) and the chapter
bodies provided, split each chapter into sentences and label every sentence with
a speaking character, returning the result as a single JSON object.

## What to produce

```jsonc
{
  "sentences": [
    {
      "id": 1,
      "chapterId": 1,
      "characterId": "narrator",
      "text": "The wind had turned by the time Halloran reached the wheelhouse.",
      "confidence": 0.97,
    },
    {
      "id": 2,
      "chapterId": 1,
      "characterId": "narrator",
      "text": "He could feel it before he saw it — a pressure shift behind his right ear that thirty winters at sea had taught him to trust more than any instrument the Admiralty could nail to a wall.",
      "confidence": 0.94,
    },
    // A sentence with a quote AND a narrative tag is split: quoted text is
    // the speaker, the tag/beat is the narrator. See "Splitting" below.
    // Quote with explicit tag → high confidence.
    {
      "id": 3,
      "chapterId": 1,
      "characterId": "halloran",
      "text": "“Hard to starboard,”",
      "confidence": 0.91,
    },
    {
      "id": 4,
      "chapterId": 1,
      "characterId": "narrator",
      "text": "he said, not loudly, because Halloran had never had to be loud to be obeyed.",
      "confidence": 0.96,
    },
    // Quote with NO tag, following Halloran's line — likely still him, but
    // mid-confidence because no explicit attribution.
    {
      "id": 5,
      "chapterId": 1,
      "characterId": "halloran",
      "text": "“And keep her there until I say otherwise.”",
      "confidence": 0.78,
    },
    // Reply from a character only identified by role; the speaker is
    // plausible from context but not certain — LOW confidence.
    {
      "id": 6,
      "chapterId": 1,
      "characterId": "marcus",
      "text": "“Aye, Captain,”",
      "confidence": 0.58,
    },
    {
      "id": 7,
      "chapterId": 1,
      "characterId": "narrator",
      "text": "came the answer from somewhere behind him.",
      "confidence": 0.93,
    },
    // ... one entry per sentence-segment, in reading order, across all chapters.
  ],
}
```

## Rules

- **Sentence ids are globally unique across the whole manuscript and 1-based**. Number them in reading order: chapter 1 starts at id 1, chapter 2 continues where chapter 1 left off.
- **`chapterId` matches the `chapters[].id` from stage 1**. Don't invent new chapter ids.
- **`characterId` must be one of the ids from the stage-1 character roster** (provided in the input). If a sentence is non-dialogue prose, use `narrator`.
- **`text`** preserves the manuscript's punctuation, smart quotes, em-dashes — copy from the source verbatim.
- **`confidence`** is a number in `[0, 1]` and **must be calibrated per sentence — do NOT copy values from the example above**. The UI surfaces anything `< 0.75` with a "Low confidence" pill so the user can review. Use the rubric below:
  - **0.95–1.00** — Pure narrative prose with no quoted speech. Or a quoted line with an explicit, unambiguous dialogue tag in the same source sentence (`"…," Halloran said`).
  - **0.85–0.94** — A quoted line where the speaker is obvious from immediate context (e.g. only two people are in the scene and the previous turn was the other one), even though no tag is present in this sentence.
  - **0.75–0.84** — Continuation of a quote where the speaker is implied by the preceding tag, or a narrative beat tucked next to a quote whose speaker is clear.
  - **0.50–0.74** — You had to infer the speaker from broader context, address forms ("Captain", "my lord"), or process of elimination. The user should review.
  - **0.20–0.49** — Genuinely ambiguous: the line could plausibly belong to more than one character in the current scene and you picked the most likely.

  A run of consecutive sentences should NOT all have the same confidence. If your output has every value clustered in a narrow band like 0.95–0.98, you have not actually calibrated — re-grade with the rubric above. Most manuscripts produce a clear spread between ~0.55 and ~0.98 across all sentences.

## Emotion delivery (fs-25)

Optionally set a structured per-sentence **`emotion`** field that drives
expressive synthesis. It is one of a **fixed** vocabulary — use only these:

- `whisper` — quiet, breathy, hushed speech
- `angry` — loud/raised, intense, sharp delivery (incl. shouting)
- `excited` — energetic, urgent delivery (often signalled by `!`)
- `sad` — subdued, downcast, heavy delivery
- `neutral` — ordinary delivery (the default; you may also just **omit** the field)

Rules:

- **Optional + conservative.** Omit `emotion` (or use `neutral`) unless the
  narrative is explicit about delivery. An absent/`neutral` emotion renders
  exactly like ordinary narration. Do NOT tag a line just because the scene is
  tense — the cue must come from THIS sentence.
- **Set it on the SPOKEN split only.** When you split a source sentence into
  quote + narrative-tag entries (see "Splitting"), the emotion belongs on the
  _spoken_ split. Narrator entries stay `neutral`/absent.
- **Derive it from the sentence itself** — an explicit narrator descriptor
  ("she whispered" → `whisper`, "he shouted"/"GET DOWN!" → `angry`, "she
  laughed"/`!` → `excited`, "he said heavily" → `sad`), or the spoken text's
  own punctuation (`!` → `excited`). Map a shout to `angry`, a laugh/exclamation
  to `excited`. There is no separate "emphatic/laughs/sighs/hesitant" — fold
  those into the nearest of the five values, or omit.
- **One value per sentence.** When in doubt, omit.
- **Never put bracketed `[tags]` in `text`.** Delivery is the `emotion` field
  now, never inline markup. If the source text contains a `[tag]`, drop the
  bracket and (optionally) reflect it as `emotion` — `[shouting]`→`angry`,
  `[excited]`→`excited`, `[whispers]`→`whisper`.

## Attribution heuristics

- Narrative prose (no quotes) → `narrator`.
- Quoted text inside dialogue → the speaker who's talking. (The dialogue tag itself — `he said`, `Marlow promised` — is a _separate_ entry, see "Splitting".)
- Consecutive quoted sentences with no tag → continue the previous speaker.
- An action beat between two quotes (`"…" He stood. "…"`) → the action beat is its own entry attributed to `narrator`; the second quote continues the previous speaker unless context changes.
- When a character refers to themself in third person ("Marcus was already moving") it is still narration — that line is `narrator`, not Marcus.
- Free indirect discourse stays with the narrator (default).

## Splitting dialogue from narrative tags

This is the most common mistake. If a single source sentence contains BOTH
quoted dialogue AND a narrative tag or action beat outside the quotes,
emit them as SEPARATE entries — never lump them into one entry attributed
to the speaker.

- Quoted portion → the speaker.
- Non-quoted portion (dialogue tag like `Marlow promised`, action beat like
  `, waving his arms`) → `narrator`.

Each split entry keeps its text verbatim from the source. Concatenating
all split entries for that sentence (in order, with their original
whitespace) must reproduce the original sentence with no loss.

**Worked examples.**

Source: `"Look! I'm all better!" Marlow promised, waving his arms.`

Two entries — the exclamation makes the spoken split `excited`:

- `"Look! I'm all better!"` → `marlow`, `emotion: "excited"`
- `Marlow promised, waving his arms.` → `narrator`

Source: `"Hard to starboard," he said, "before the rocks."`

Three entries (mid-quote interruption):

- `"Hard to starboard,"` → `halloran`
- `he said,` → `narrator`
- `"before the rocks."` → `halloran`

Source: `Marcus turned. "Get below," he muttered, then drew the blade.`

Three entries (action beat + quote + tag + action beat — collapse the
narrative spans on each side of the quote, don't fragment beyond what
the quotes naturally separate):

- `Marcus turned.` → `narrator`
- `"Get below,"` → `marcus`
- `he muttered, then drew the blade.` → `narrator`

If a sentence has no embedded quotes at all, do NOT split it — emit as one entry.

## Common pitfalls

Emit strict JSON. Validate that `sentences[].id` are unique integers,
monotonically increasing; every `characterId` exists in the stage-1 roster; and
every `chapterId` exists in the stage-1 chapters list. Common mistakes:

- Skipping sentence ids or restarting at 1 per chapter.
- Referring to a `characterId` that wasn't in stage 1.
- Including markdown formatting OR bracketed `[tags]` inside `text` (use the raw
  text from the manuscript; express delivery via the `emotion` field — see
  "Emotion delivery" above).

## Reference

The canonical sentence shape is `Sentence` in `openapi.yaml`. The sample
fixture `src/data/sentences.ts` shows the exact JS shape we expect after JSON
parsing.
