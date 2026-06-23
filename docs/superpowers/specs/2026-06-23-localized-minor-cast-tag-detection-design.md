---
status: draft
---

# Localized minor-cast tag detection (ES + RU) — Design

**Issue:** #1028 — _Non-English minor-cast protection lost (`foldMinorCast` loses `taggedSpeakerIds` on non-English)._
**Area:** `srv` (`server/src/analyzer/`)
**Follow-up of:** fs-41/fs-50 seam-3d (`docs/superpowers/plans/2026-06-23-fs41-fs50-seam3d-attribution-gate.md`), which gated the English-only attribution heuristics off for non-English and explicitly deferred per-language localisation.

> **Revision note (adversarial pass, 2026-06-23):** the first draft used a
> `flipTarget: 'self'` flip that mis-voiced the narration tail of an inline
> `quote + tag + narration` sentence and targeted the wrong sentence for the real
> stranding failure mode. The flip is redesigned below as a **guarded bidirectional
> adjacency** rule (`flipStrategy: 'adjacent'`) and gated on an **empirical
> segmentation check** (Task 0 of the plan). The verb-name regex, anchor, and regex
> flags were also corrected. See "Adversarial-review changelog" at the end.

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
- Pronoun-tag resolution (`сказал он` / `dijo él` — rejected as stopwords, never
  resolved to a speaker).
- NER or any model call. This is deterministic, pure-function string work.
- Exhaustive verb lists — curated and inclusion-biased, extensible by adding to a row
  (same philosophy as `DIALOGUE_VERBS`).
- Sentence-splitting: sentences are the atomic downstream unit; this design never
  subdivides a sentence (it is precisely why the flip never re-voices a mixed
  quote+narration sentence — see D1).

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
  /** Word order of the tag relative to the name. Drives regex assembly AND the
      regex flag set: 'name-verb' is ASCII-only (no `u` flag, byte-identical to
      today's English regex); 'verb-name' uses the `u` flag for \p{Lu}/\p{L}. */
  order: 'name-verb' | 'verb-name';
  /** Regex source capturing one capitalized name token. en: "[A-Z][A-Za-z’'-]+"
      (used without the `u` flag). es/ru: "\\p{Lu}[\\p{L}’'-]+" (used with `u`). */
  nameCapture: string;
  /** Which sentence(s) the flip may move onto a resolved tag's speaker:
        - 'preceding' (English): the immediately-PRIOR sentence in the same
          chapter — today's exact, unchanged behaviour (the tag is its own
          pure-narration beat, e.g. `Behnam noted.`).
        - 'adjacent' (ES/RU): the immediately-PRIOR and/or-FOLLOWING sentence,
          each only when it is narrator + quote-bearing + carries NO dialogue
          verb of its own (a bare, stranded quote fragment). NEVER the
          tag-bearing sentence itself (avoids re-voicing an inline
          quote+tag+narration sentence — see D1). Bidirectional so an
          interrupted quote `«A, — сказал X, — B»` split into three sentences
          re-attributes both halves. */
  flipStrategy: 'preceding' | 'adjacent';
  /** Pronouns/articles that look like a name in verb-name order but aren't
      ('сказал он', 'dijo él'). Unioned (per call, no mutation) with the shared
      English STOPWORDS. */
  stopwords?: readonly string[];
}

export const TAG_GRAMMARS: Record<string, TagGrammar> = {
  en: { verbs: DIALOGUE_VERBS, order: 'name-verb',
        nameCapture: "[A-Z][A-Za-z’'-]+", flipStrategy: 'preceding' },
  es: { verbs: ES_VERBS, order: 'verb-name',
        nameCapture: "\\p{Lu}[\\p{L}’'-]+", flipStrategy: 'adjacent',
        stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, order: 'verb-name',
        nameCapture: "\\p{Lu}[\\p{L}’'-]+", flipStrategy: 'adjacent',
        stopwords: RU_STOPWORDS },
};

/** Grammar for a book language, or null when the language has no row (caller
    keeps the existing no-op gate). Keyed by normaliseBookLanguage(language);
    missing/empty normalises to 'en' (matches the existing `language = 'en'`
    default on both consumers). */
export function grammarFor(language: string): TagGrammar | null;
```

- The `en` row + its name-verb assembly (below) **reproduce today's `makeTagRegex`
  output exactly, including the absence of the `u` flag** — the regression guard is
  that every existing English assertion in `recover-tagged-lines.test.ts` stays green
  untouched.
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

- **`name-verb` (en)** — `\b(<nameCapture>)\s+(?:<verbs>)\b`, built **without** the
  `u` flag → identical to today's regex.
- **`verb-name` (es/ru)** — built **with** the `u` flag:
  `(?:^|[—–\-«»"“”,:]\s*)(?:<verbs>)\s+(?:\p{Ll}[\p{L}’'-]*\s+){0,2}(<nameCapture>)`.
  The verb is anchored to start-of-string or a quote-close / em-dash / comma / colon
  **dialogue beat** (no bare-whitespace alternative — so an ordinary narrative use of
  a polysemous verb such as ES `Coalfall llamó a la puerta` does not match). Up to two
  optional lowercase tokens between the verb and the name absorb a role noun
  (`сказал мастер Одуван`, `dijo el viejo Berrin`). The capture is the first
  capitalized token thereafter.

Both public functions resolve a grammar up front and replace the
`if (isNonEnglish(language)) return <no-op>` early-return with:
`const g = grammarFor(language); if (!g) return <no-op>;` — `es`/`ru` now resolve a
grammar; fr/de/etc. resolve `null` and keep the existing gated no-op.

- **`taggedSpeakerIds`** (keep-protection — segmentation-agnostic): scan every sentence
  with `tagRegexFor(g)`, `resolveNameToId` the capture against the roster, collect the
  resolved ids. Order- and `flipStrategy`-independent. This alone closes #1028.
- **`recoverTaggedNarratorLines`** (audio re-attribution): for each sentence `S`
  carrying a resolvable `<tag → id>`:
  - `flipStrategy: 'preceding'` (en) — flip `S-1` iff same chapter and currently
    narrator. **Today's exact logic, unchanged.**
  - `flipStrategy: 'adjacent'` (es/ru) — consider `S-1` and `S+1`. Flip a neighbour `Q`
    onto `id` iff **all** hold: `Q` is the same chapter; `Q.characterId === narrator`;
    `Q` is quote-bearing (contains `« » “ ” "` or a leading `—`); and `Q` carries **no**
    grammar dialogue verb of its own (so a neighbour that is itself a tag — resolvable
    or pronoun-tagged — is never stolen). Never flip `S` itself.
  - Both paths keep the global invariants: never overwrite a non-narrator attribution;
    only act when the name resolves to exactly one rostered character.

### Component 3 — name matching under Unicode (`recover-tagged-lines.ts`)

- `buildNameToId` / `resolveNameToId` already lowercase (Unicode-aware in JS) and
  tokenize; the token split `/[\s.-]+/` is fine for Cyrillic/accented input.
- Stopword rejection becomes grammar-aware: a **per-call** union of the shared English
  `STOPWORDS` set with `grammar.stopwords` (the module-level set is never mutated).
  RU: `он, она, оно, они, это, тот, та, кто, что, там, тут, так, вот`; ES: `él, ella,
  ellos, ellas, este, esta, eso, que, quien, aquí, allí`. The `nameCapture`
  capital-letter requirement already filters lowercase common nouns (`дракон`).
- Conservative acceptance unchanged: ambiguous name → `null` → not acted on.

## Data flow

```
analysis.ts / fold-minor-cast.ts  ──(book language already threaded)──►
  taggedSpeakerIds(sentences, roster, language)
  recoverTaggedNarratorLines(sentences, roster, language)
       └─ grammarFor(language)
            ├─ null  → existing no-op (en handled by 'en' row; fr/de/… gated)
            └─ row   → tagRegexFor(row) → resolveNameToId(roster) → conservative accept
                       (flip target chosen by row.flipStrategy)
```

## Error handling / safety

- A wrong match can only ever land on a **real rostered name** (single-resolution
  rule); it cannot invent a speaker. This bounds the §4.3 mis-attribution concern that
  made flips risky for non-English.
- The `'adjacent'` flip never moves the tag-bearing sentence itself and never moves a
  neighbour that carries its own dialogue verb, so (a) an inline quote+tag+narration
  sentence is left intact (no re-voiced narration) and (b) a dialogue exchange does not
  cross-attribute one speaker's reply to another.
- Unmapped languages are unchanged (still no-op) — zero risk to fr/de/any future
  language until it gets a curated row.

## Testing (the "done" gate)

- **Task 0 — empirical segmentation check (prerequisite, in the plan):** run real
  stage-2 attribution over a handful of ES + RU Coalfall dialogue paragraphs and record
  how inline-tagged dialogue is actually segmented and stranded (one sentence vs. split
  quote/tag fragments; which fragment lands on narrator). The unit fixtures below are
  built from that observed output, and the `flipStrategy` choice is confirmed (or, if
  the model keeps inline quote+tag as one correctly-attributed sentence, the flip
  simply rarely fires and keep-protection carries the fix). No code is finalised before
  this is observed.
- **`tag-grammar.test.ts` (new):** `grammarFor` mapping; `tagRegexFor` per language —
  `en` source equals today's regex AND is built without `u`; `es` matches
  `«Está bien», dijo Berrin` → `Berrin`; `ru` matches `«…», — сказала Рен` → `Рен`,
  `— сказал мастер Одуван` → `Одуван` (role-noun skip), and the interrupted
  `«…, — сказал Одуван, — …»` → `Одуван`; pronoun beats (`сказал он`, `dijo él`),
  lowercase nouns (`сказал дракон`), and a narrative `Coalfall llamó a la puerta`
  (polysemous verb, not a dialogue beat) all fail to resolve.
- **`recover-tagged-lines.test.ts` (extend):** ES + RU fixtures mirroring the English
  ones — (a) `taggedSpeakerIds` returns `{berrin}` / `{рен}`; (b) the `'adjacent'` flip
  moves a stranded **tagless** quote neighbour onto Berrin/Рен (incl. the bidirectional
  interrupted-quote case); (c) an inline quote+tag+narration sentence on narrator is
  **NOT** flipped (no re-voiced narration); (d) a dialogue-exchange neighbour that
  carries its own verb is not stolen; (e) a correctly-attributed book is a no-op;
  (f) fr/de still return the empty/no-flip no-op. Every existing English assertion
  stays unchanged (regression guard).
- **`fold-minor-cast.test.ts` (extend):** a Spanish-roster case proving a low-line
  `Berrin` whose quote the prose tags is **kept** (own slot), not folded into
  `unknown-male`. Direct #1028 regression — red before, green after.
- **On-box acceptance (owed, non-blocking):** re-render the Spanish Coalfall canary and
  confirm Berrin/Ivo survive with their own voices; record in the plan's Ship notes
  (mirrors how the other canary work tracks GPU acceptance).

## Known limitations (documented, not fixed in v1)

- **RU inflection:** a declined name (dative addressee `— сказал Одувану Рен`) won't
  resolve `Одувану` (only the nominative is in the roster map) — a conservative *miss*,
  not a mis-attribution. Same caveat as `GENERIC_ROLE_RU`.
- **One tag per sentence:** `tagRe.exec` finds only the first `<tag>` in a sentence; a
  two-speaker exchange segmented into a single sentence catches only the first. English
  has the same limit.
- **Pronoun-tagged stranded quotes** (`«B» — добавил он`) are not recovered — `он` is a
  stopword, so the neighbour-disqualifier (a neighbour with any dialogue verb is left
  alone) keeps us from guessing the antecedent.

## Adversarial-review changelog (2026-06-23)

- **D1 (critical):** replaced `flipTarget: 'self'` with guarded bidirectional
  `flipStrategy: 'adjacent'`; the flip never re-voices an inline quote+tag+narration
  sentence and targets the real stranding mode (a split-out tagless quote fragment).
  Added Task 0 empirical segmentation check.
- **B (serious):** verb-name regex now absorbs up to two lowercase role tokens between
  the verb and the name (`сказал мастер Одуван`), matching the test claim.
- **C (moderate):** dropped the bare `\s` anchor; the verb must sit on a quote/dash/
  comma/colon dialogue beat, so a narrative polysemous verb no longer false-keeps.
- **A (minor):** pinned name-verb (en) to **no** `u` flag and verb-name (es/ru) to the
  `u` flag, making the "English byte-identical" claim explicit.
- Documented RU-inflection / one-tag-per-sentence / pronoun-tag recall limits; stopword
  union is per-call (no module-set mutation).
