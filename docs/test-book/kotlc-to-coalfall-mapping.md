# KotLC → Coalfall/Hollow Tide mapping (test-fixture canon)

The single source of truth for the copyright scrub (plan
`docs/superpowers/plans/2026-06-12-keefe-scrub.md`). The codemod
`scripts/scrub-kotlc.mjs` encodes the **unambiguous** rows; the **context-only**
rows are renamed by hand. Owned names: Coalfall cast (see
`brand/test-book/the-coalfall-commission-cast-sheet.md`) + fabricated Hollow
Tide-universe names. No third-party IP.

## Characters — unambiguous (codemod)

| KotLC | Owned |
|---|---|
| Sophie / Sophie Foster | Wren / Wren Sparrow |
| Keefe / Keefe Sencen | Tam / Tam Hollis |
| Lord Hunkyhair | Sir Singe |
| Elwin | Oduvan |
| Fitz | Brann |
| Biana | Maerin |
| Dex | Hart |
| Sandor | Garrow |
| Prentice | Lessom |
| Forkle | Casper |
| Alina / Dame Alina / Councillor Alina | Linnet / Dame Linnet / Councillor Linnet |
| Lord Cassius / Cassius | Lord Vane / Vane |
| Lady Galvin | Lady Wick |
| Lady Alexine | Lady Thorne |
| Councillor Terik | Councillor Brask |
| Councillor Emery | Councillor Reld |
| Grizel | Sela |
| Maruca | Berrin |
| Marella | Edda |
| Grady | Corvin |
| Edaline | Hespa |
| Brant | Bram |

## Books / series — unambiguous (codemod)

| KotLC | Owned |
|---|---|
| Keeper of the Lost Cities (series) | The Hollow Tide |
| Stellarlune | The Drowning Bell |
| Everblaze | The Tidewatcher's Oath |
| Neverseen | Saltgrave |

## Books — CONTEXT-ONLY (manual; common English/code words — NOT in the codemod)

| KotLC | Owned | Why manual |
|---|---|---|
| Exile | The Ebb | "exile" is a common word |
| Unlocked | The Floodmark | UI/state term |
| Legacy | The Lantern Tide | "legacy" = legacy format/pairing in ~114 files |
| Flashback | The Undertow | common word |
| Foster (standalone surname) | Sparrow | "foster" is also a verb |

## Manuscript path

`C:\Users\dudar\Downloads\Bonus Keefe Story.txt` and `~/Downloads/Bonus Keefe Story.txt`
→ `server/src/__fixtures__/the-coalfall-commission.md` (committed, owned).
Prose mentions of "Bonus Keefe Story" → "the Coalfall Commission".

## Rules

- Coalfall cast first (role fit); else fabricate an original Hollow Tide name.
- Keep `Lord`/`Lady`/`Dame`/`Councillor` titles; swap only the surname.
- Never a near-homophone of a KotLC name; never reuse an owned target.
- Re-enumerate before each phase:
  ```
  git grep -ohE "\b(Sophie|Keefe|Elwin|Sandor|Prentice|Forkle|Dex|Fitz|Biana|Maruca|Cassius|Grizel|Hunkyhair|Alina|Galvin|Grady|Brant|Marella|Edaline|Councillor [A-Z][a-z]+|Lord [A-Z][a-z]+|Lady [A-Z][a-z]+|Dame [A-Z][a-z]+|Stellarlune|Everblaze|Neverseen|Keeper of the Lost Cities)\b" -- ':!node_modules' ':!docs/superpowers' ':!docs/test-book'
  ```
  Add an owned mapping (above) for any new straggler before scrubbing.
