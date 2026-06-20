---
name: audiobook-character-detection-per-chapter
description: Phase 0a of the audiobook-generator pipeline. Reads ONE CHAPTER plus the running cast roster and returns the speaking characters that appear in this chapter — new and recurring — so the server can grow a unified roster across the book.
---

# Audiobook character detection — per-chapter (Phase 0a)

You are an automated worker reading **one chapter** of a manuscript. Identify
every speaking character that appears in **this chapter** — new and recurring —
and return them as a single JSON object, following the schema and rules below.

## What you receive

The input contains:

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
      "id": "narrator", // see "Reusing existing ids" below
      "name": "Narrator",
      "role": "Third-person observer",
      "color": "narrator",
      "attributes": ["restrained", "wry"],
      "gender": "neutral",
      "ageRange": "adult",
      "tone": { "warmth": 55, "pace": 40, "authority": 70, "emotion": 35 },
      "description": "A measured narrator …",
      "evidence": [
        {
          "quote": "He could feel it before he saw it — a pressure shift behind his right ear …",
          "note": "Long-form: anchors register + period vocabulary.",
        },
        { "quote": "She said it under her breath, …", "note": "Dry, observational." },
      ],
    },
    // ... one entry per speaking character that appears IN THIS CHAPTER,
    //     new or recurring. Always include "narrator" if narrative prose
    //     is present. Narrator-only named characters (bodyguards / mentors
    //     / family referenced in narration with role markers but without
    //     quoted dialogue) MAY appear with `detectionSource:
    //     "narrator-mention"` — see "Narrator-only named characters" below.
  ],
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
   `FILED BY: ODUVAN`, signature `—Marlow`, chapter title `Wren's
Registry File`, the surrounding bio block, etc.). The author of
   such text is a character whose `id` is their name, NOT `narrator`.
   A whole first-person **novel** is NOT such a document — its first-person voice
   is the protagonist/narrator, not the book's author. Never roster the book's
   byline author as a character unless they explicitly act or speak in the story
   (e.g. a clearly-framed author's note).

**Binding rule — an explicit dialogue tag always counts.** If the chapter
contains a `<Name> <speech-verb>` attribution beat next to a quote — `"…,"
Lessom repeated.`, `"Fine," Sela agreed.`, `"Where?" Wren asked.` —
that Name **MUST** appear on the roster, every time, no exceptions. The tag
itself is the verbatim evidence; do not weigh whether the character seems
"important" or count how many lines they have. A character tagged once and a
character tagged ten times are equally required. A character who is mostly
*addressed* by others but speaks even one tagged line still counts — being
spoken to is irrelevant, speaking once is decisive. When in doubt, scan the
chapter for `<name> <speech-verb>`: a single hit is mandatory grounds for
inclusion. Omitting a minor-but-tagged speaker — letting their quoted lines
fall through to the narrator — is the exact failure this rule prevents.

Do **NOT** include:

- Pets, animals, or non-speaking creatures (a cat that purrs, a dog that
  barks, a horse that whinnies, a magical creature that scampers).
  Sounds the narrator describes are not dialogue. Marty the cat, Rufus
  the pet dinosaur, an imp that hisses — all of these are narrator
  business, not cast.
- Characters mentioned by name in narration but who never speak in this
  chapter (a character described, remembered, talked-about, or in the
  background of a scene without saying anything) — **EXCEPT** the
  narrow class covered by "Narrator-only named characters" below.
- Inanimate objects, places, abstract concepts, or named items.
- Entities whose only "lines" are non-verbal sounds (growls, purrs,
  squeaks, hisses, roars) rendered as onomatopoeia. These read aloud
  in the narrator's voice; they do not need their own roster slot.

Test for inclusion: can you copy a verbatim sentence from this chapter
that is **spoken or written by** the entity? If no, they do not go on
the roster — unless they qualify under the narrator-only-named-character
rule below. Otherwise the narrator covers them.

### Narrator-only named characters (canonical scene presence without quoted dialogue)

Some named characters are referenced heavily in narration but rarely or
never quote dialogue in a given chapter — bodyguards, mentors, family
members who are physically present and central to the scene but whose
words are summarised rather than quoted. The classic shape is a chapter
that describes a character by name with a role/relationship marker but
does not give them a verbatim utterance.

**Include such a character on the roster** when ALL of the following are
true:

1. They have a **proper noun name** (not a descriptor — "Sela", not
   "the bodyguard").
2. The name appears **at least twice** in this chapter's narration.
3. The narration carries a **role or relationship marker** identifying
   them as a recurring scene presence — e.g. "his bodyguard, Sela",
   "Sela volunteered for the position", "Garrow, Wren's goblin
   bodyguard, stepped between them", "her mentor, Mr. Casper".
4. They do NOT have any quoted dialogue in this chapter (if they do,
   the normal "Direct dialogue" rule applies and you skip this block).

When you include such a character, emit them with:

- `detectionSource: "narrator-mention"` (a new optional field — set it
  exactly to that string).
- `evidence: []` (no quotes to attribute).
- All other fields as usual: `id`, `name`, `role`, `color`, `gender`,
  `ageRange`, optional `tone`, optional `description`.

Worked examples:

- Chapter narration includes "He's now under the protection of Sela,
  who volunteered for the position." and later "Sela and Garrow were
  also injured during this incident." → emit
  `{ id: "sela", name: "Sela", role: "Bodyguard",
detectionSource: "narrator-mention", evidence: [] }`. The narrator
  still covers the narration text; this entry exists so the cast has a
  voice slot for Sela that the user can fill later.
- Chapter narration includes "Mr. Casper's lessons came back to her at
  that moment." once, with no other mentions in the chapter and no
  role marker → DO NOT include (only one mention, no role marker; the
  narrator covers it).

The default character entry still requires `detectionSource:
"dialogue"` when emitted via the "Only actual speakers" rule above
(omit the field — it defaults to dialogue on the server side). The
field exists so the downstream minor-cast fold can keep canonical
bodyguards / mentors / family on the roster even when their attributed
line count would normally fold them into the unknown-male / unknown-female
buckets. Without this signal, characters like Sela and Garrow (Lost
Cities Saltgrave — see
`docs/features/archive/97-narrator-only-named-characters.md`) get silently
erased from the cast at the post-stage-2 fold pass.

If a character previously had dialogue in an earlier chapter (already on
the roster) but only appears in narration in _this_ chapter, omit them
from this chapter's output — see "Returning characters NOT in this
chapter" below.

### First-person POV / journal / registry / log formats

Companion books, prequels, and supplementary volumes often present
chapters as **documents** rather than narrated scenes: a journal entry,
a medical log, a Registry classified file, a letter, a transcript. The
prose is first-person but the speaker is _not_ an omniscient narrator
— they are a specific named character in the story world.

When a chapter is one of these formats:

- The `id: "narrator"` slot is **reserved** for omniscient third-person
  prose with no in-fiction author. Use it only when the chapter is
  clearly narrated by an external storyteller, not by a character.
- The **author** of the document is the character whose voice should
  speak the text. Identify them from the strongest available signal:
  chapter title (`Wren's Memory Log — Day 4`), document header
  (`FILED BY: ODUVAN`, `Author: Marlow Halden`), closing signature
  (`—Marlow`), surrounding bio block, or running-roster context (if
  the roster has `marlow` and this chapter is unmistakably Marlow's
  diary, use `marlow`).
- The evidence quotes for that character should be excerpts of the
  document's prose — they don't need to be dialogue. Pick a long,
  representative sentence and a short, characterising one.
- If a journal entry contains _quoted dialogue_ (the diarist quoting
  someone else's speech inside their entry), the quoted speaker also
  gets their own roster entry (provided they have a real, attributed
  quote).
- If the chapter switches POV mid-stream (e.g. a registry file with a
  filing officer's intro followed by the subject's own statement),
  emit one entry per distinct first-person voice, each with their
  own evidence.

Worked examples:

- **Chapter "Oduvan's Medical Log"** opens with `FILED BY: ODUVAN ·
PATIENT: WREN SPARROW` and the body is `I'd just settled into bed
when Wren hailed me. I figured she wouldn't want to know that her
hands were covered in yeti pee.` → roster entry
  `{ id: "oduvan", name: "Oduvan", role: "Healer / journal author",
evidence: [{ quote: "I'd just settled into bed when Wren hailed
me." }, { quote: "I figured she wouldn't want to know that her hands
were covered in yeti pee." }] }`. **Not** narrator.
- **Chapter "Marlow's Diary — Day Three"** signs off with `—Marlow`. The
  body is `Sparrow's still mad at me. I've been working on the perfect
apology. It hasn't been going well.` → roster entry
  `{ id: "marlow", name: "Marlow Halden", evidence: [...] }`. **Not**
  narrator.

### Reusing known series characters (when the prompt carries a prior)

The input may include a section `## Known characters from prior books
in this series` with `name`, `aliases`, `description`, and
`fromBookTitles` (an array of every prior book that confirmed this
character) per character. **Treat that list as the authoritative
identity pool for this series.** If a speaker in this chapter matches
a known series character by name or by alias (case-insensitive,
ignoring punctuation), reuse their `id` **verbatim** — do not invent a
new id. Mis-attributing a series-regular as a fresh character creates
duplicate voice profiles and breaks downstream voice-match scoring.
New characters introduced in this book that are NOT in the list should
still get fresh kebab-case ids.

### Reusing existing ids (CRITICAL — drives roster stability)

- If a character in this chapter is **already in the running roster**,
  reuse the existing `id` **verbatim**. The server matches characters
  across chapters by `id`; a typo or stylistic variation
  (`wren-sparrow` vs `wren`) creates a duplicate entry.
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

## Common pitfalls

Emit strict JSON (no trailing commas, no comments), reusing existing roster ids
verbatim. Common mistakes that fail validation:

- Missing required field (`id`, `name`, `role`, `color`).
- Trailing commas or comments in the JSON (use strict JSON).
- Character with an id that drifted from the running roster (e.g.
  `wren` in earlier chapters becoming `wren-sparrow` here).

## Reference

The canonical character shape is `Character` in `openapi.yaml` (and
`src/lib/api-types.ts`). The whole-book sibling skill
`audiobook-character-analysis.md` has additional examples of the
character-output shape (the per-chapter call returns the same shape,
just scoped to one chapter).
