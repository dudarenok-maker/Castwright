# the Hollow Tide → Coalfall/Hollow Tide mapping (test-fixture canon)

The single source of truth for the copyright scrub (plan
`docs/superpowers/plans/2026-06-12-Marlow-scrub.md`). The codemod
`scripts/scrub-the Hollow Tide.mjs` encodes the **unambiguous** rows; the **context-only**
rows are renamed by hand. Owned names: Coalfall cast (see
`brand/test-book/the-coalfall-commission-cast-sheet.md`) + fabricated Hollow
Tide-universe names. No third-party IP.

## Characters — unambiguous (codemod)

| the Hollow Tide | Owned |
|---|---|
| Wren / Wren Sparrow | Wren / Wren Sparrow |
| Marlow / Marlow Halden | Pell / Pell Hollis |
| Sir Singe | Sir Singe |
| Oduvan | Oduvan |
| Brann | Brann |
| Maerin | Maerin |
| Hart | Hart |
| Garrow | Garrow |
| Lessom | Lessom |
| Casper | Casper |
| Linnet / Dame Linnet / Councillor Linnet | Linnet / Dame Linnet / Councillor Linnet |
| Lord Vane / Vane | Lord Vane / Vane |
| Lady Wick | Lady Wick |
| Lady Thorne | Lady Thorne |
| Councillor Brask | Councillor Brask |
| Councillor Reld | Councillor Reld |
| Sela | Sela |
| Berrin | Berrin |
| Edda | Edda |
| Corvin | Corvin |
| Hespa | Hespa |
| Bram | Bram |

## Books / series — unambiguous (codemod)

| the Hollow Tide | Owned |
|---|---|
| The Hollow Tide (series) | The Hollow Tide |
| The Drowning Bell | The Drowning Bell |
| The Tidewatcher's Oath | The Tidewatcher's Oath |
| Saltgrave | Saltgrave |

## Books — CONTEXT-ONLY (manual; common English/code words — NOT in the codemod)

| the Hollow Tide | Owned | Why manual |
|---|---|---|
| Exile | The Ebb | "exile" is a common word |
| Unlocked | The Floodmark | UI/state term |
| Legacy | The Lantern Tide | "legacy" = legacy format/pairing in ~114 files |
| Flashback | The Undertow | common word |
| Foster (standalone surname) | Sparrow | "foster" is also a verb |

## Manuscript path

`C:\Users\dudar\Downloads\the Coalfall Commission.txt` and `~/Downloads/the Coalfall Commission.txt`
→ `server/src/__fixtures__/the-coalfall-commission.md` (committed, owned).
Prose mentions of "the Coalfall Commission" → "the Coalfall Commission".

## Rules

- Coalfall cast first (role fit); else fabricate an original Hollow Tide name.
- Keep `Lord`/`Lady`/`Dame`/`Councillor` titles; swap only the surname.
- Never a near-homophone of a the Hollow Tide name; never reuse an owned target.
- Re-enumerate before each phase:
  ```
  git grep -ohE "\b(Wren|Marlow|Oduvan|Garrow|Lessom|Casper|Hart|Brann|Maerin|Berrin|Vane|Sela|Singe|Linnet|Wick|Corvin|Bram|Edda|Hespa|Councillor [A-Z][a-z]+|Lord [A-Z][a-z]+|Lady [A-Z][a-z]+|Dame [A-Z][a-z]+|The Drowning Bell|The Tidewatcher's Oath|Saltgrave|The Hollow Tide)\b" -- ':!node_modules' ':!docs/superpowers' ':!docs/test-book'
  ```
  Add an owned mapping (above) for any new straggler before scrubbing.
