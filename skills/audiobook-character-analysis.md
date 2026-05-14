---
name: audiobook-character-analysis
description: Stage 1 of the audiobook-generator cowork pipeline. Reads a manuscript handoff file and produces a character roster + chapter list, saving the result as JSON to the matching outbox path.
---

# Audiobook character analysis — stage 1

You are the human-in-the-loop analyst for the audiobook generator's character
detection step. The local server has written a handoff prompt to
`server/handoff/inbox/{manuscriptId}-stage1.md`. Your job is to read it, do the
analysis described below, and write a JSON file to
`server/handoff/outbox/{manuscriptId}-stage1.json`.

## What to produce

A JSON object with exactly these two top-level fields:

```jsonc
{
  "characters": [
    {
      "id": "narrator",            // kebab-case, unique within the book
      "name": "Narrator",
      "role": "Third-person observer",
      "color": "narrator",          // one of: narrator, halloran, eliza, marcus,
                                    // OR a fresh kebab token tied to this character.
                                    // The frontend maps unknown colors to a fallback.
      "attributes": ["restrained", "long subordinate clauses", "wry"],
      "gender": "male",             // "male" | "female" | "neutral". Required for non-narrator
                                    // characters when the manuscript gives any signal (pronouns,
                                    // honorifics, gendered relationships). Use "neutral" only when
                                    // the manuscript is genuinely ambiguous. Drives the TTS voice
                                    // picker — getting this right is critical for the audiobook.
      "ageRange": "adult",          // "child" | "teen" | "adult" | "elderly". A boy of ~15 is "teen",
                                    // an elder ship captain is "elderly", etc. Optional but
                                    // strongly recommended — coarse age controls vocal register.
      "tone": {                     // each on 0–100, leave any field out if uncertain
        "warmth": 55,
        "pace": 40,
        "authority": 70,
        "emotion": 35
      },
      "description": "A measured, period-appropriate narrator. Uses sea-trade vocabulary; rarely interjects opinion.",
      "evidence": [
        { "quote": "He could feel it before he saw it — a pressure shift behind his right ear that thirty winters at sea had taught him to trust more than any instrument the Admiralty could nail to a wall.", "note": "Long-form: drives the voice-cloning sample. Sentence rhythm, restrained register, period vocabulary." },
        { "quote": "thirty winters at sea had taught him to trust", "note": "Anchors register + age." },
        { "quote": "She said it under her breath, which is how she said most of the things she meant.", "note": "Dry, observational; understated humour." }
      ]
    }
    // ... one per speaking character. Always include "narrator".
  ],
  "chapters": [
    { "id": 1, "title": "The Berth at Liverpool" },
    { "id": 2, "title": "A Manifest Two Names Short" }
    // chapter ids are 1-based and contiguous; match the order from the inbox file
  ]
}
```

## Rules

- **Always include `narrator`** as a character even if there's no first-person voice — narrative prose still needs a voice in the audiobook.
- `id` must be **kebab-case**, stable across re-runs, and unique. Use last names or descriptive nicknames (`halloran`, `eliza-gray`, `cook-marcus`).
- `color`: when uncertain, reuse one of `narrator`, `halloran`, `eliza`, `marcus` (these have hand-tuned palettes). Otherwise emit a fresh kebab token; the UI falls back gracefully.
- `attributes`: 2–5 short tags. Adjectives or noun phrases describing speech behaviour, not appearance.
- `gender`: emit for every non-narrator character when the manuscript gives any signal — pronouns ("he"/"she"), honorifics ("Mr."/"Mrs."), gendered relationships ("son"/"daughter"). Use `"neutral"` only when the manuscript is truly ambiguous (mythical beings, AI, etc.). The TTS picker depends on this for voice selection. Narrator gets `"neutral"` unless the prose is in first person and gendered.
- `ageRange`: `"child"` (≤12), `"teen"` (13–19), `"adult"` (20–60), `"elderly"` (60+). Use the manuscript's stated or strongly implied age. Skip the field if you genuinely don't know.
- `tone`: integer fields, 0 (low) to 100 (high). Skip a field rather than guess.
- `evidence`: **at least 3 quotes per character**, sorted longest-first.
  - **Each quote MUST be a single continuous utterance, copied verbatim
    from the manuscript.** Do **NOT** stitch fragments from different
    paragraphs, scenes, or chapters together to make one longer "quote"
    — even if every utterance the character has is short. A 40-char
    real line is always preferable to a 250-char Frankenstein quote
    that the character never actually said in one breath. The server
    verifies each quote is a substring of the source text on ingest and
    will drop quotes that are not — sticking to verbatim is the only
    way to get the quote into the cast.
  - The **first quote drives the TTS voice-cloning sample**, so it
    should be the **single longest utterance the character actually
    has** in the manuscript. Longer is better for prosody settling, but
    if the character's longest real line is "Yes." then "Yes." is the
    entry. The TTS sample will be short; that's intentional — short
    real audio beats fabricated long audio.
  - The remaining quotes are tonal evidence shown beneath the sample
    quote in the UI. Same verbatim rule.
  - Add a `note` when the link to the character's voice/identity isn't
    obvious. Always note *why* the first quote is representative.
  - The server re-sorts longest-first on ingest, so ordering errors won't
    break the UI — but emit them sorted so the JSON is human-readable.
- `chapters[]` — **use the pre-detected list from the inbox verbatim.**
  The local parser has already split the manuscript and supplies a
  `## Chapter list (pre-detected by the local parser — use verbatim)`
  section above the manuscript body. Copy every `id` and `title` into your
  output's `chapters` field in the same order. Do **not** merge, split,
  drop, or re-title these chapters even if the manuscript prose suggests
  otherwise — stage 2 keys off this list, and divergence breaks the
  per-chapter iteration. The bullets below describe the boundary patterns
  the parser already recognises; you don't need to re-derive them.
- `chapters[].id` is **1-based and contiguous**. Don't skip numbers. Use the chapter ordering as it appears in the manuscript.
- `chapters[].title` should reflect the manuscript's own labelling. Chapter
  boundaries aren't always "Chapter N" — books also use:
  - **Numbered sections** with non-`chapter` keywords: `Day One`, `Part I`,
    `Book Two`, `Act III`, `Section 4`, `Scene 7`.
  - **Standalone markers** that need no number: `Prologue`, `Epilogue`,
    `Interlude`, `Preface`, `Introduction`, `Afterword`, `Foreword`.
  - **Markdown headings** (`# Title`, `## Title`) at the start of a section.

  Preserve the heading verbatim as the title (e.g. `"Day One"`, `"Prologue"`,
  `"Chapter 3: The Reckoning"`). Don't normalise "Day Two" into "Chapter 2".
  If the manuscript uses days as chapters, the chapter list should read
  `Day One`, `Day Two`, … in order — one entry per day.

  Plaintext manuscripts often wrap headings in **decoration characters**:
  `+ DAY ONE +`, `=== Chapter 3 ===`, `*** Prologue ***`, `~~ Part I ~~`.
  Strip those cosmetic borders when extracting the title — `+ DAY ONE +`
  becomes `"DAY ONE"`, not `"+ DAY ONE +"`. The keyword + number/standalone
  marker stays the load-bearing signal regardless of decoration.

## How to run

In a separate Claude Code window (or Claude chat):

1. Read `server/handoff/inbox/{manuscriptId}-stage1.md`.
2. Produce the JSON above.
3. Write it to `server/handoff/outbox/{manuscriptId}-stage1.json`.

The server is watching that path and will pick it up automatically.

## If validation fails

The server will write `server/handoff/outbox/{manuscriptId}-stage1.errors.json`
describing what went wrong (invalid JSON or schema violations). Fix and re-save
the `.json` file; the server will retry. Common pitfalls:

- Missing required field (`id`, `name`, `role`, `color`).
- `chapters[].id` not a positive integer.
- Trailing commas or comments in the JSON (use strict JSON, no JSONC).

## Reference

The canonical character shape is `Character` in `openapi.yaml` (and
`src/lib/api-types.ts`). The sample fixture
`src/mocks/canned-data.ts:ANALYSIS_NORTHERN_STAR` shows a fully-populated
example you can mimic.
