---
name: audiobook-character-detection-per-chapter
description: Phase 0a of the audiobook-generator pipeline. Reads ONE CHAPTER plus the running cast roster and returns the speaking characters that appear in this chapter — new and recurring — so the server can grow a unified roster across the book.
---

# Audiobook character detection — per-chapter (Phase 0a)

You are reading **one chapter** of a manuscript. The local server has written
a handoff prompt to
`server/handoff/inbox/{manuscriptId}-stage1-ch{chapterId}.md`. Your job is
to read it, identify every speaking character that appears in **this
chapter**, and write a JSON file to
`server/handoff/outbox/{manuscriptId}-stage1-ch{chapterId}.json`.

## What you receive

The inbox file contains:

1. **Manuscript metadata** — title, manuscriptId, chapterId, chapter title.
2. **The running roster** — every character detected in earlier chapters,
   with `{ id, name, role }`. The server has already merged these from
   prior per-chapter passes; treat the roster as authoritative for those
   characters' identities.
3. **The chapter text** — the body of this single chapter only.

## What to produce

A JSON object with exactly this shape:

```jsonc
{
  "characters": [
    {
      "id": "narrator",                // see "Reusing existing ids" below
      "name": "Narrator",
      "role": "Third-person observer",
      "color": "narrator",
      "attributes": ["restrained", "wry"],
      "gender": "neutral",
      "ageRange": "adult",
      "tone": { "warmth": 55, "pace": 40, "authority": 70, "emotion": 35 },
      "description": "A measured narrator …",
      "evidence": [
        { "quote": "He could feel it before he saw it — a pressure shift behind his right ear …",
          "note": "Long-form: anchors register + period vocabulary." },
        { "quote": "She said it under her breath, …",
          "note": "Dry, observational." }
      ]
    }
    // ... one entry per speaking character that appears IN THIS CHAPTER,
    //     new or recurring. Always include "narrator" if narrative prose
    //     is present.
  ]
}
```

There is **no `chapters` field** in this output — the parser already owns
the chapter list, and Phase 0a runs once per chapter so each call is
about exactly one chapter's id.

## Rules

### Only actual speakers (CRITICAL — drives whether a voice profile is created)

A character belongs in the roster when this chapter contains at least
one **verbatim utterance** that is theirs — either:

1. **Direct dialogue** — a line of speech the narrator attributes to
   them, e.g. `"Hello," she said.` or `"Get out!" Marty growled.`
2. **First-person prose by an identifiable author** — a journal entry,
   medical log, registry filing, letter, diary, transcript, or bio
   page **whose author is named or strongly implied** (header
   `FILED BY: Oduvan`, signature `—Marlow`, chapter title `Wren's
   Registry File`, the surrounding bio block, etc.). The author of
   such text is a character whose `id` is their name, NOT `narrator`.

Do **NOT** include:

- Pets, animals, or non-speaking creatures (a cat that purrs, a dog that
  barks, a horse that whinnies, a magical creature that scampers).
  Sounds the narrator describes are not dialogue. Marty the cat, Rufus
  the pet dinosaur, an imp that hisses — all of these are narrator
  business, not cast.
- Characters mentioned by name in narration but who never speak in this
  chapter (a character described, remembered, talked-about, or in the
  background of a scene without saying anything).
- Inanimate objects, places, abstract concepts, or named items.
- Entities whose only "lines" are non-verbal sounds (growls, purrs,
  squeaks, hisses, roars) rendered as onomatopoeia. These read aloud
  in the narrator's voice; they do not need their own roster slot.

Test for inclusion: can you copy a verbatim sentence from this chapter
that is **spoken or written by** the entity? If no, they do not go on
the roster. The narrator covers them.

If a character previously had dialogue in an earlier chapter (already on
the roster) but only appears in narration in *this* chapter, omit them
from this chapter's output — see "Returning characters NOT in this
chapter" below.

### First-person POV / journal / registry / log formats

Companion books, prequels, and supplementary volumes often present
chapters as **documents** rather than narrated scenes: a journal entry,
a medical log, a Registry classified file, a letter, a transcript. The
prose is first-person but the speaker is *not* an omniscient narrator
— they are a specific named character in the story world.

When a chapter is one of these formats:

- The `id: "narrator"` slot is **reserved** for omniscient third-person
  prose with no in-fiction author. Use it only when the chapter is
  clearly narrated by an external storyteller, not by a character.
- The **author** of the document is the character whose voice should
  speak the text. Identify them from the strongest available signal:
  chapter title (`Wren's Memory Log — Day 4`), document header
  (`FILED BY: Oduvan`, `Author: Marlow Halden`), closing signature
  (`—Marlow`), surrounding bio block, or running-roster context (if
  the roster has `Marlow` and this chapter is unmistakably Marlow's
  diary, use `Marlow`).
- The evidence quotes for that character should be excerpts of the
  document's prose — they don't need to be dialogue. Pick a long,
  representative sentence and a short, characterising one.
- If a journal entry contains *quoted dialogue* (the diarist quoting
  someone else's speech inside their entry), the quoted speaker also
  gets their own roster entry (provided they have a real, attributed
  quote).
- If the chapter switches POV mid-stream (e.g. a registry file with a
  filing officer's intro followed by the subject's own statement),
  emit one entry per distinct first-person voice, each with their
  own evidence.

Worked examples:

- **Chapter "Oduvan's Medical Log"** opens with `FILED BY: Oduvan ·
  PATIENT: Wren Sparrow` and the body is `I'd just settled into bed
  when Wren hailed me. I figured she wouldn't want to know that her
  hands were covered in yeti pee.` → roster entry
  `{ id: "Oduvan", name: "Oduvan", role: "Healer / journal author",
  evidence: [{ quote: "I'd just settled into bed when Wren hailed
  me." }, { quote: "I figured she wouldn't want to know that her hands
  were covered in yeti pee." }] }`. **Not** narrator.
- **Chapter "Marlow's Diary — Day Three"** signs off with `—Marlow`. The
  body is `Foster's still mad at me. I've been working on the perfect
  apology. It hasn't been going well.` → roster entry
  `{ id: "Marlow", name: "Marlow Halden", evidence: [...] }`. **Not**
  narrator.

### Reusing existing ids (CRITICAL — drives roster stability)

- If a character in this chapter is **already in the running roster**,
  reuse the existing `id` **verbatim**. The server matches characters
  across chapters by `id`; a typo or stylistic variation
  (`Wren-foster` vs `Wren`) creates a duplicate entry.
- For recurring characters you may still emit fresh `evidence`, refined
  `description`, updated `tone`, etc. — the server merges fields
  intelligently. But the `id` MUST match the roster's entry.
- For **new** characters introduced in this chapter, follow the same
  conventions as the existing roster: `id` is kebab-case, stable,
  unique. Use last names or descriptive nicknames
  (`halloran`, `eliza-gray`, `cook-marcus`).
- Always include `narrator` if narrative prose appears in this chapter,
  even if the chapter is mostly dialogue. The narrator entry should
  carry forward the same `id: "narrator"` across chapters.

### Returning characters NOT in this chapter

- **Don't.** Skip characters that don't speak or aren't directly
  observed in this chapter, even if they're in the running roster.
  The server already has those entries from earlier chapters.

### Field rules (same as the whole-book skill, just scoped)

- `id`: kebab-case, stable, unique within the book.
- `color`: when uncertain, reuse `narrator`, `halloran`, `eliza`, or
  `marcus` (these have hand-tuned palettes). Otherwise emit a fresh
  kebab token.
- `attributes`: 2–5 short tags — adjectives or noun phrases describing
  speech behaviour, not appearance.
- `gender`: emit for every non-narrator character when this chapter
  gives any signal — pronouns, honorifics, gendered relationships. Use
  `"neutral"` only when truly ambiguous. Drives the TTS voice picker.
- `ageRange`: `"child"` (≤12), `"teen"` (13–19), `"adult"` (20–60),
  `"elderly"` (60+). Skip the field if you genuinely don't know.
- `tone`: integer fields, 0 (low) to 100 (high). Skip a field rather
  than guess.
- `evidence`: at least 2 quotes per character per chapter when possible
  (1 is acceptable for very minor characters with a single line). Each
  quote MUST be a single continuous utterance, copied **verbatim** from
  this chapter. **Do NOT stitch utterances from different paragraphs or
  scenes together to make one longer "quote"** — even if every line the
  character has in this chapter is short. A 40-char real line is always
  preferable to a 250-char Frankenstein quote that the character never
  actually said in one breath. The server verifies each quote against
  the manuscript and drops fabricated ones — sticking to verbatim is
  the only way to get a quote into the cast.
- The first/longest quote drives the TTS voice-cloning sample. It
  should be the single longest utterance the character has **in this
  chapter**. The server will keep the longest across all chapters once
  the full roster is finalised.

## How to run

In a separate Claude Code window (or Claude chat):

1. Read `server/handoff/inbox/{manuscriptId}-stage1-ch{chapterId}.md`.
2. Identify the speaking characters in the chapter body, reusing
   existing roster ids verbatim.
3. Produce the JSON above.
4. Write it to
   `server/handoff/outbox/{manuscriptId}-stage1-ch{chapterId}.json`.

The server is watching that path and will pick it up automatically.

## If validation fails

The server writes
`server/handoff/outbox/{manuscriptId}-stage1-ch{chapterId}.errors.json`
describing what went wrong (invalid JSON or schema violation). Fix and
re-save the `.json` file; the server will retry. Common pitfalls:

- Missing required field (`id`, `name`, `role`, `color`).
- Trailing commas or comments in the JSON (use strict JSON).
- Character with an id that drifted from the running roster (e.g.
  `Wren` in earlier chapters becoming `Wren-foster` here).

## Reference

The canonical character shape is `Character` in `openapi.yaml` (and
`src/lib/api-types.ts`). The whole-book sibling skill
`audiobook-character-analysis.md` has additional examples of the
character-output shape (the per-chapter call returns the same shape,
just scoped to one chapter).
