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
      "tone": {                     // each on 0–100, leave any field out if uncertain
        "warmth": 55,
        "pace": 40,
        "authority": 70,
        "emotion": 35
      },
      "description": "A measured, period-appropriate narrator. Uses sea-trade vocabulary; rarely interjects opinion.",
      "evidence": [
        { "quote": "thirty winters at sea had taught him to trust", "note": "Anchors register + age." }
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
- `tone`: integer fields, 0 (low) to 100 (high). Skip a field rather than guess.
- `evidence`: 1–3 short quotes from the manuscript that justify your reading. Keep quotes under ~120 chars; add a `note` when the link isn't obvious.
- `chapters[].id` is **1-based and contiguous**. Don't skip numbers. Use the chapter ordering as it appears in the manuscript.

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
