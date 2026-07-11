# Non-story chapter classification

You are given ONE chapter of a book (its title and body). Decide whether the
whole chapter is **non-story front matter** — a foreword, preface, publisher's
or translator's note, or a critical/biographical essay *about the book or its
author* — as opposed to **narrative fiction** (a story chapter, including a
framed letter, diary, or in-fiction author's note where characters speak).

Answer conservatively. When in doubt, answer `false` (treat it as story).

## Output schema

Return ONLY this JSON object, no markdown fences:

```json
{ "nonStory": true }
```

- `nonStory` (boolean, required): `true` only if the chapter is non-story front
  matter as defined above; otherwise `false`.

## Examples

- A critical essay discussing another author's life and work → `{ "nonStory": true }`
- A translator's preface about the edition → `{ "nonStory": true }`
- A story chapter, a prologue that is fiction, an in-fiction letter → `{ "nonStory": false }`
