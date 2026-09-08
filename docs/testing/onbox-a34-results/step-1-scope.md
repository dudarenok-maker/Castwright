# A34 step 1 — scope every book with the wrong-direction characterId shape

Read-only investigation for register row A34 (#2584, #2040), parent #2903.
No file under `C:\AudiobookWorkspace\books\` was written by this step.

## Detection logic used

Per PR #2640's `stripEstablishedAsciiRewrites` / `normaliseForMatch`
(`server/src/analyzer/roster-dedup.ts`), the defect shape is:

- `cast-id-history.json`'s `supersededBy` map has an entry `from -> to` where
- `from` is an **established ASCII kebab id** (`isAsciiKebabId`:
  `/^[a-z0-9]+(-[a-z0-9]+)*$/`), and
- `to` is **non-ASCII** (fails `isAsciiKebabId`), and
- the two are **the same character by name**: `normaliseForMatch(name(from))
  === normaliseForMatch(name(to))`, comparing the prior cast row at `from`
  against the live/fresh cast row `to` currently resolves to.

An ASCII→ASCII or non-ASCII→ASCII rewrite is not this shape (that's the
comparator's designed "genuine improvement onto a more canonical id"
direction, left alone deliberately).

## Method

1. Recursively found every `cast.json` under `C:\AudiobookWorkspace\books\`
   (`find ... -iname cast.json`) — **23 books total**.
2. Recursively found every `cast-id-history.json` under the same root — only
   **5 of the 23 books have one at all**. A book with no history file has no
   retirement recorded and therefore cannot carry this shape — it was ruled
   out without needing to open its `cast.json`.
3. For each of the 5 books with a history file, read `supersededBy` and
   classified every entry's `from`/`to` ASCII-ness by inspection.
4. For any `from` that is ASCII and `to` is non-ASCII, read the book's
   `cast.json` to get both ids' current/prior `name` fields and compare under
   `normaliseForMatch` (lowercase, quote/dash normalisation, whitespace
   collapse — no further transformation needed for these names since none
   contain quotes/em-dashes/ellipses).

## Books with a `cast-id-history.json` (5 of 23)

| Book | `supersededBy` entries | Wrong-direction hit? |
|---|---|---|
| `Castwright/Standalones/Заказ Коалфолла` | `mayrin→mairin`, `coalfall→coalfall-dragon`, `мэйрин→mairin`, `коалфолл→coalfall-dragon`, `widow-casper→widow-kasper`, `brann→brann-wire`, `berrin→berrin-wire`, `lessom→father-lessom`, **`oduvan→одуван`**, `brann-weir→brann-wire`, `berrin-weir→berrin-wire` | **YES** — `oduvan→одуван` only |
| `Derek Landy/Skulduggery Pleasant/Playing with Fire` | `lightning-dave→lightning_dave`, `the-torment→the_torment` | No — both ASCII→ASCII |
| `Shannon Messenger/Keeper of the Lost Cities/Everblaze` | `lady-alina→dame-alina` | No — both ASCII→ASCII |
| `Сергей Лукьяненко/Standalones/Ночной дозор (C2C3 run 2)` | `vampire-man→unknown-male`, `igor→unknown-male`, `lena→unknown-female`, `vampire→unknown-female`, `polina-vasilievna→unknown-female` | No — all ASCII→ASCII |
| `Сергей Лукьяненко/The Night Watch Tetralogy/Ночной дозор` | `pavel→unknown-male`, `dark-programmer-2→unknown-male`, `dark-programmer-3→unknown-male`, `dark-programmer-4→unknown-male` | No — all ASCII→ASCII |

## Required cross-check: *Заказ Коалфолла*

Confirmed this book's hit matches the exact shape the wave-8 2026-08-27 run
recorded:

- `cast-id-history.json`: `"oduvan": "одуван"` — established ASCII id
  `oduvan` recorded first (`recordedAtSeq: 12`, `2026-08-21T07:47:44.959Z`),
  no earlier record for `одуван`.
- `cast.json`: the live character is `id: "одуван"`, `name: "Одуван"`
  (role: "Мастер-кузнец", the blacksmith). There is no `oduvan` row left in
  the live cast — it was fully retired in favour of `одуван`.
- `normaliseForMatch("Одуван") === normaliseForMatch("Одуван")` — same name
  both sides (the prior ASCII row's name, recorded at the same retirement,
  was also "Одуван"; the id was the only thing that changed).

This is the sole hit in the whole `Заказ Коалфолла` history — every other
`supersededBy` entry in that same file is ASCII→ASCII or non-ASCII→ASCII and
is correctly excluded by the shape definition. Detection query trusted.

## Result: 1 hit, 22 books clear, 0 ambiguous cases

- **1 book hits the wrong-direction shape**: `Castwright/Standalones/Заказ
  Коалфолла`, entry `oduvan → одуван` (character "Одуван", the blacksmith).
  This is the already-known register-row-A34 case; no other entry in its own
  history matches.
- **18 of the 23 books have no `cast-id-history.json` at all** and are
  therefore automatically clear of this shape (nothing was ever superseded):
  the other 6 `Castwright/Standalones/*` localisation copies (`Der Auftrag
  von Coalfall`, `El Encargo de Coalfall`, `La Commande de Coalfall`, `The
  Coalfall Commission`, `コールフォールの依頼`, `煤落的委托`), `Derek
  Landy/Skulduggery Pleasant/{Scepter of the Ancients, The Lost Art of World
  Domination}`, `Shannon Messenger/Keeper of the Lost Cities/{Bonus Keefe
  Story, Exile, Keeper of the Lost Cities, Neverseen, Stellarlune, Unlocked,
  Unraveled}`, `Лидия Ивановна Острецова/Standalones/Юный дрессировщик`, and
  `Сергей Лукьяненко/Standalones/Ночной дозор (C2 throwaway)`.
- **4 of the 23 books have a history file but no wrong-direction entry**:
  `Playing with Fire`, `Everblaze`, `Ночной дозор (C2C3 run 2)`, and the
  Tetralogy's `Ночной дозор` — every `supersededBy` entry in all four is
  ASCII→ASCII (an id-format cleanup or a fold onto `unknown-male`/
  `unknown-female`), never ASCII→non-ASCII.
- **0 ambiguous cases** — no entry required a judgment call about which side
  was "established first"; every non-hit was ruled out purely by ASCII-ness
  of `from`/`to`, and the one hit's direction (established ASCII first,
  non-ASCII survivor later) is unambiguous from `recordedAtSeq`/
  `recordedAtIso`.

## Implication for step 2 (repair script)

The repair pass's detection query only needs to touch the 5 books that carry
a `cast-id-history.json` — the other 18 can be skipped outright without
reading their `cast.json`. Within those 5, exactly one row in one file needs
repair. Step 2 should still implement the general ASCII-kebab-`from` /
non-ASCII-`to` / name-match query (not special-case this one id), since the
defect class is general even though only one instance of it currently exists
in the on-box workspace.
