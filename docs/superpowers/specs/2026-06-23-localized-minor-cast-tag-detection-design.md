---
status: draft
---

# Localized minor-cast tag detection (ES + RU) — Design

**Issue:** #1028 — _Non-English minor-cast protection lost (`foldMinorCast` loses `taggedSpeakerIds` on non-English)._
**Area:** `srv` (`server/src/analyzer/`)
**Follow-up of:** fs-41/fs-50 seam-3d (`docs/superpowers/plans/2026-06-23-fs41-fs50-seam3d-attribution-gate.md`), which gated the English-only attribution heuristics off for non-English and explicitly deferred per-language localisation.

## Problem

`taggedSpeakerIds` (the fold's "keep this prose-tagged speaker" protection) and
`recoverTaggedNarratorLines` (the narrator-flip that moves a stage-2-stranded quote
back onto its speaker) share one English-only heuristic: a `<Name> <speech-verb>`
regex over `DIALOGUE_VERBS`. Seam-3d (`f335b0c8`) threaded the book language into
both and made them early-return a no-op when `isNonEnglish(language)`.

For non-English books the consequence is that a real minor-cast speaker whose lines
stage-2 left on the narrator (0 / few attributed lines) is **no longer protected** —
the `<minLines` fold buckets them into `unknown-male/female`, or the 0-line drop
removes them entirely.

The deeper cause is grammatical, not just the gate: English tags the speaker
**after** the name (`"All right," Berrin said`), while Spanish and Russian **invert**
to verb-before-name and use different verbs:

- ES (`samples/the-coalfall-commission/manuscript.es.md:147`): `«Está bien», dijo Berrin`
- RU (`server/src/__fixtures__/the-coalfall-commission.ru.md:11,45`): `«Оставь, — сказал мастер Одуван…»`, `«…», — сказала Рен`

So even before the gate the English regex never matched ES/RU prose; the gate only
made the no-op explicit. The fix is the deferred localisation: a language-aware tag
detector for the two shipped/next non-English languages (Spanish is operator-accepted;
Russian has the most prior attribution work).

## Goal

Restore **both** the keep-protection **and** the narrator-flip recovery for `es` and
`ru` via a per-language tag grammar, leaving English byte-for-byte unchanged and every
other language (fr/de/…) still gated off until it gets its own row.

## Non-goals

- fr/de localisation (separate canary follow-ups — they stay gated, returning the
  existing no-op).
- Russian morphological stemming / declined-name coverage (nominative capture only;
  same documented v1 limitation as `GENERIC_ROLE_RU` in the fold).
- NER or any model call. This is deterministic, pure-function string work.
- Exhaustive verb lists — curated and inclusion-biased, extensible by adding to a row
  (same philosophy as `DIALOGUE_VERBS`).

## Architecture (Approach A — per-language grammar table + shared engine)

A new `server/src/analyzer/tag-grammar.ts` holds the single source of truth for how a
language tags dialogue. `recover-tagged-lines.ts` reads a grammar row by normalised
language and builds its scan/flip behaviour from it. No call-site changes: seam-3d
already threads the book language into both consumers
(`fold-minor-cast.ts:315`, the two `recoverTaggedNarratorLines(...)` calls in `analysis.ts`).

### Component 1 — `tag-grammar.ts` (new)

```ts
export interface TagGrammar {
  /** Localized dialogue verbs. All gendered/inflected surface forms listed
      explicitly (not stemmed): RU 'сказал' AND 'сказала'. Inclusion-biased. */
  verbs: readonly string[];
  /** Word order of the tag relative to the name. */
  order: 'name-verb' | 'verb-name';
  /** Regex source (no flags) capturing one capitalized name token. */
  nameCapture: string;
  /** Which sentence carries the quote to flip relative to the tag sentence:
      'preceding' (English — tag is its own following beat, flip the prior
      sentence) or 'self' (ES/RU — tag is inline with the quote, flip the
      tag-bearing sentence itself when it is on narrator). */
  flipTarget: 'preceding' | 'self';
  /** Pronouns/articles that look like a name in verb-name order but aren't
      ('сказал он', 'dijo él'). Merged with the shared English STOPWORDS. */
  stopwords?: readonly string[];
}

export const TAG_GRAMMARS: Record<string, TagGrammar> = {
  en: { verbs: DIALOGUE_VERBS, order: 'name-verb',
        nameCapture: "[A-Z][A-Za-z’'-]+", flipTarget: 'preceding' },
  es: { verbs: ES_VERBS, order: 'verb-name',
        nameCapture: "\\p{Lu}[\\p{L}’'-]+", flipTarget: 'self',
        stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, order: 'verb-name',
        nameCapture: "\\p{Lu}[\\p{L}’'-]+", flipTarget: 'self',
        stopwords: RU_STOPWORDS },
};

/** Grammar for a book language, or null when the language has no row (caller
    keeps the existing no-op gate). Keyed by normaliseBookLanguage(language). */
export function grammarFor(language: string): TagGrammar | null;
```

- The `en` row **reproduces today's `makeTagRegex` output exactly** — the regression
  guard is that every existing English assertion in `recover-tagged-lines.test.ts`
  stays green untouched.
- `en` reuses `DIALOGUE_VERBS` so the `.mjs` drift test (`dialogue-verbs-drift.test.mjs`)
  is untouched. ES/RU verb lists live only in `tag-grammar.ts` (no `.mjs` consumer).

Seed verb lists (curated, extensible):
- **ES_VERBS:** `dijo, preguntó, respondió, contestó, añadió, gritó, murmuró, susurró,
  exclamó, replicó, repitió, insistió, continuó, pidió, ordenó, suspiró`.
- **RU_VERBS:** gendered pairs `сказал/сказала, спросил/спросила, ответил/ответила,
  отозвался/отозвалась, проговорил/проговорила, пробормотал/пробормотала,
  воскликнул/воскликнула, прошептал/прошептала, продолжил/продолжила,
  добавил/добавила, крикнул/крикнула`.

### Component 2 — detection engine (`recover-tagged-lines.ts`)

`makeTagRegex()` → `tagRegexFor(grammar)` assembling, by `order`:

- `name-verb`: `\b(<nameCapture>)\s+(?:<verbs>)\b` (today's English regex).
- `verb-name`: `(?:^|[—–\-«"“,]\s*|\s)(?:<verbs>)\s+(<nameCapture>)`, `u` flag — the
  verb is anchored to a quote-close / em-dash / comma beat so a bare verb mid-clause
  doesn't trigger, and the capture is the first capitalized token after it.

Both public functions:
- Replace `if (isNonEnglish(language)) return <no-op>` with:
  `const g = grammarFor(language); if (!g) return <no-op>;` — `es`/`ru` now resolve a
  grammar; fr/de/etc. resolve `null` and keep the existing gated no-op.
- `taggedSpeakerIds`: scan every sentence with `tagRegexFor(g)`, `resolveNameToId` the
  capture against the roster, collect the resolved ids. (Order-agnostic — works for
  both `flipTarget`s.)
- `recoverTaggedNarratorLines`: for each tag match, pick the quote sentence by
  `g.flipTarget`:
  - `'preceding'` (en): the immediately-prior sentence in the same chapter, currently
    narrator — today's exact logic.
  - `'self'` (es/ru): the tag-bearing sentence itself, **only when** it is currently
    narrator AND contains a quote glyph (`«` `»` `“` `”` `"` or a leading `—`) — so an
    inline `«Está bien», dijo Berrin` on narrator flips to Berrin, but a pure narration
    sentence that merely contains a verb+name never does.
  - Both paths keep the invariants: never overwrite a non-narrator attribution; only
    act when the name resolves to exactly one rostered character.

### Component 3 — name matching under Unicode (`recover-tagged-lines.ts`)

- `buildNameToId` / `resolveNameToId` already lowercase (Unicode-aware in JS) and
  tokenize; the token split `/[\s.-]+/` is fine for Cyrillic/accented input.
- Stopword rejection becomes grammar-aware: the shared English `STOPWORDS` set is
  unioned with `grammar.stopwords` (RU: `он, она, оно, они, это, тот, та, кто, что,
  там, тут, так, вот`; ES: `él, ella, ellos, ellas, este, esta, eso, que, quien,
  aquí, allí`). The `nameCapture` capital-letter requirement already filters lowercase
  common nouns (`дракон`, the dragon).
- Conservative acceptance unchanged: ambiguous name → `null` → not acted on.

## Data flow

```
analysis.ts / fold-minor-cast.ts  ──(book language already threaded)──►
  taggedSpeakerIds(sentences, roster, language)
  recoverTaggedNarratorLines(sentences, roster, language)
       └─ grammarFor(language)
            ├─ null  → existing no-op (en handled by 'en' row; fr/de/… gated)
            └─ row   → tagRegexFor(row) → resolveNameToId(roster) → conservative accept
```

## Error handling / safety

- A wrong match can only ever land on a **real rostered name** (single-resolution
  rule); it cannot invent a speaker. This bounds the §4.3 mis-attribution concern that
  made flips risky for non-English.
- `'self'` flips require the sentence to be narrator-attributed AND quote-bearing, so a
  description sentence that happens to contain `<verb> <Name>` is not flipped.
- Unmapped languages are unchanged (still no-op) — zero risk to fr/de/any future
  language until it gets a curated row.

## Testing (the "done" gate)

- **`tag-grammar.test.ts` (new):** `grammarFor` mapping; `tagRegexFor` per language —
  `en` source equals today's regex; `es` matches `«Está bien», dijo Berrin` → `Berrin`;
  `ru` matches `«…», — сказала Рен` → `Рен` and `— сказал мастер Одуван` → `Одуван`;
  pronoun beats (`сказал он`, `dijo él`) and lowercase nouns (`сказал дракон`) do not
  resolve.
- **`recover-tagged-lines.test.ts` (extend):** ES + RU fixtures mirroring the English
  ones — (a) `taggedSpeakerIds` returns `{berrin}` / `{рен}`; (b) `recoverTaggedNarratorLines`
  flips a narrator-stranded inline quote onto Berrin/Рен via `flipTarget: 'self'`;
  (c) a correctly-attributed book is a no-op; (d) fr/de still return the empty/no-flip
  no-op. Every existing English assertion stays unchanged (regression guard).
- **`fold-minor-cast.test.ts` (extend):** a Spanish-roster case proving a low-line
  `Berrin` whose quote the prose tags is **kept** (own slot), not folded into
  `unknown-male`. Direct #1028 regression — red before, green after.
- **On-box acceptance (owed, non-blocking):** re-render the Spanish Coalfall canary and
  confirm Berrin/Ivo survive with their own voices; record in the plan's Ship notes
  (mirrors how the other canary work tracks GPU acceptance).

## Open design point for review

`flipTarget` is the one non-obvious element: English's flip ("the preceding sentence is
the quote") does not transfer to ES/RU, where the tag is inline with the quote. The
`'self'` strategy assumes stage-2 keeps `«Está bien», dijo Berrin` as one sentence and
strands the whole thing on narrator. If the segmenter instead splits the quote from the
inline tag for ES/RU, we'd also want the `'preceding'` fallback for those languages. The
unit fixtures should pin whichever segmentation the real pipeline produces — to be
confirmed against an actual ES/RU stage-2 output during implementation; the grammar
field makes either choice a one-line change.
