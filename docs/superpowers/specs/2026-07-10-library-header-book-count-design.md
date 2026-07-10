# Library header book-count copy fix

Issue: #1461 — "Library header hardcodes 'carry through to book seven' — inconsistent with the six-book series story"

## Problem

`src/components/library/library-chrome.tsx:100` hardcodes a specific book number in the library welcome subhead:

> Voices stay consistent across a series — characters who appear in book one carry through to book seven.

This is fixed copy shown to every user regardless of how many books they actually have, and it reads oddly for anyone whose library isn't seven books deep. It's also internally inconsistent with the same screen's series-memory chip and reveal/share-card copy, which say "5 voices, 6 books" / "Six books in, not a voice changed."

## Fix

Make the line number-agnostic instead of picking a different hardcoded number, so it stays true for every library regardless of size:

```diff
- — characters who appear in book one carry through to book seven.
+ — characters who appear in book one carry through, book after book.
```

No data derivation needed — this is static copy, not tied to any per-user book count.

## Scope

Single-line JSX text change in `library-chrome.tsx`. No component logic, props, or tests are affected (no test currently asserts this exact string; if one does, update it to match).

## Testing

Visual/manual check: load the library view and confirm the subhead reads correctly. No new automated test needed for a static copy string.
