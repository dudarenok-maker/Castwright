---
status: draft
issues: ['#1050', '#1051']
depends_on: ['#1028', '#1049']
languages: ['es', 'ru', 'fr', 'de']
---

# es/ru/fr/de analyzer-heuristic localization (#1050 + #1051)

Localize two analyzer heuristics that are currently English-only, for **es, ru, fr,
de**, reusing the per-language `tag-grammar.ts` substrate that #1028/#1049 landed:

- **#1050** — `isDescriptorName` (the minor-cast fold) only folds throwaway
  "descriptor" names for `en` (and `ru`, partially). Spanish/French/German
  background descriptors leak their own one-off voice slots.
- **#1051** — the roster-coverage guard (`validateRosterCoverage`,
  `validateAttributionCoverage`, `runStage1WithRosterGuard`) is gated off for
  **all** non-English. A speaker stage-1 drops from the roster is never
  recovered. This is the actual fix for the on-box Berrin/Ivo loss that
  motivated #1028 (see "Motivating evidence").

## Motivating evidence (why #1051 matters)

On-box Gemini analysis of `samples/the-coalfall-commission/manuscript.es.md`
(`language=es`) post-#1049:

- Cast had 13 members; **Berrin and Ivo were absent entirely** — stage-1 never
  rostered them.
- `«Está bien»,` (prose: `…, dijo Berrin`) → attributed to `unknown-male`.
- Ivo's lines → `unknown-male` / `narrator`.
- #1028's keep-protection + narrator-flip **couldn't fire** because they are
  *rostered-only*: `taggedSpeakerIds` / `resolveNameToId` require the captured
  name to match a rostered character, and Berrin/Ivo aren't rostered. #1051 is
  the layer that gets them rostered; the two compose (see "How the layers
  compose"). The #1028 flip did **not** misfire (no line went to a wrong
  speaker), so #1051 doesn't risk regressing it.

## Scope decisions (locked with the user)

1. **Languages: es + ru + fr + de** for both units.
2. **Architecture (Approach A):** `tag-grammar.ts` stays the single source of
   truth for dialogue-tag grammar; a **new** sibling `descriptor-grammar.ts`
   houses the descriptor data. Neither heuristic hand-rolls `if (lang === …)`
   ladders. (Rejected: B — one unified module, overloads a single unit and
   churns the just-shipped `tag-grammar.ts`; C — inline per-language branches,
   duplicates the verb-name machinery the grammar already encodes.)
3. **fr/de full parity, lean on existing filters.** The roster guard auto-adds
   missing speakers for fr/de just like es/ru; a wrong add (e.g. German `Mann`)
   gets no lines → folded by Unit A's descriptor grammar or dropped as a 0-line
   non-speaker. **This makes Unit A a prerequisite for Unit B's fr/de safety →
   land Unit A first.**
4. **Both-orders detection for all four** (name-verb **and** verb-name). The
   flip already handles quote-on-either-side; this is a detection-only change.
5. **Consequence accepted by the user:** un-gating fr/de in `tag-grammar.ts`
   also activates #1028's flip + fold-keep-protection for fr/de (shared
   `grammarFor()` gate). Adding name-verb detection to es/ru/fr/de changes their
   attribution output, which **invalidates the Spanish operator-acceptance**
   (re-render + re-accept owed) and shifts ru. See "Owed validation".

## Invariants (reviewer-checked)

- **English is byte-identical.** Both modules' `en` path is unchanged; passing
  no `language` defaults to `'en'`. `EN_NAME` keeps the curly apostrophe `'`
  (U+2019). Existing **English** assertions in `fold-minor-cast.test.ts` and
  `roster-coverage.test.ts` stay green **and unedited**.
- **The unmapped tail stays gated.** Any language without a grammar row resolves
  `grammarFor()` / `descriptorGrammarFor()` → `null` → no-op. The gate moves from
  "is English?" to "do we have a row?"; it does not vanish.
- **es/ru/fr/de behavior intentionally changes** (both-orders + new descriptor
  rows + un-gated guard). Existing es/ru tests are reviewed and updated to the
  new expectations, not frozen.

## Adversarial review (round 1) — findings folded in

| # | Severity | Finding | Resolved in |
|---|---|---|---|
| A | 🔴 | A single both-orders *alternation* regex puts the name in group 1 *or* 2, breaking 5 `m[1]` reads (`undefined`); duplicate named groups are a Node-20 SyntaxError. | §B.2 "Capture-group model" + §B.6 array model (`tagRegexesFor[]`), 5 consumer sites loop. |
| B | 🔴 | Porting the ru function-word rule to es/fr/de folds **real names** with nobiliary/patronymic particles (`de Gaulle`, `von Bismarck`). | "Function-word rule is ru-only"; es/fr/de `functionWords` empty. |
| J | 🟠 | Name-verb mode makes thin es/ru stopwords manufacture junk roster adds (`Entonces dijo`). | §B.3 stopword expansion + a pinning test. |
| D | 🟠 | `orders[]` also breaks `verbBeatRegexFor` (reads `g.order`). | §B.6 multi-order `verbBeatRegexFor`. |
| C | 🟡 | Bare-noun match folds a *recurring* narrator-named role even with many lines. | Accepted limit (Unit A "Known v1 limits"). |
| E | 🟡 | Removing the gate orphans the `isNonEnglish` import. | Files-touched note. |
| F | 🟡 | de seam-3d gate tests must be *inverted to detection*, not deleted. | Testing strategy. |
| G | 🟡 | `recover-missing-character.mjs` stays English. | Out of scope. |
| H | ✅ | `m`-flag byte-identity for en — *verified no-op* (no anchors in en regex). | §B.2. |

## Adversarial review (round 2) — findings folded in

| # | Severity | Finding | Resolved in |
|---|---|---|---|
| R2-1 | 🟠 | The per-order regex array can **double-count one physical tag** (matched by two orders) → `tagCount` hits 2 → passes the `≥2-hits` gate without quote-adjacency, defeating the single-hit false-positive bound. | §B.2 — dedupe matches by capture position (`m.index`), not just by name. |
| R2-2 | 🟠 | A `tagRegexFor` single-regex shim (proposed in round 1) is a **footgun**: a caller using `[0]` silently gets only the first order, dropping name-verb detection. | §B.6 — **remove `tagRegexFor` entirely**; all callers use the array. |
| R2-3 | 🟠 | **Verified glyph gaps:** roster `QUOTE_CHARS` (`/["“”]/`) lacks guillemets `« »` (es/ru) **and** German `„` (U+201E); `QUOTE_GLYPHS` (isQuoteBearing) lacks German `„` (U+201E). Quote-adjacency is blind to es/ru/de dialogue marks. | §B.4 + §7 — widen both, exact code points named. |
| R2-8 | 🟠 | **Verified:** the name-verb branch's `\b` is ASCII-only → the **trailing `\b` after a Cyrillic verb** (`сказал`) never fires, so ru name-verb tags don't match. (de verbs are ASCII, fine.) | §B.6 — Unicode-safe boundaries on **both** sides of the name-verb tag for ru. |
| R2-4 | 🟡 | Unit A only fires for es/fr/de if `language` reaches `foldMinorCast` at **both** the interim (`nameOnly`) and final passes. Final already gets it (#1028); interim unverified. | Call-sites section. |
| R2-5 | 🟡 | Roster-guard auto-adds carry no gender → a false-add `Frau` folds into the **male** bucket (wrong gender). | Unit B §5 note. |
| R2-6 | 🟢 | `m`+`VERB_BEAT` `^` interacts with manuscript hard-wrapping. | Verify-at-implementation note (§B.2). |
| R2-7 | 🟢 | German `articles` `den/dem` are unnecessary (analyzer emits nominative). | Trimmed to nominative in the rows. |

---

## Unit A — `descriptor-grammar.ts` (#1050)

New module `server/src/analyzer/descriptor-grammar.ts`, mirroring
`tag-grammar.ts`. One row per language; `isDescriptorName(name, lang)` becomes a
data-driven matcher over it.

```ts
export interface DescriptorGrammar {
  /** Leading article tokens for the article-led rule (lowercased). Empty = rule off. */
  articles: ReadonlySet<string>;
  /** Generic role nouns (lowercased). */
  genericNouns: ReadonlySet<string>;
  /** How a generic noun matches: lone token / last token of a ≥2-word name / either. */
  nounMatch: 'bare' | 'trailing' | 'both';
  /** Standalone prepositions/conjunctions whose presence in a multi-word name
      marks it a description, not a name (lowercased). Empty = rule off. */
  functionWords: ReadonlySet<string>;
}
export function descriptorGrammarFor(language: string): DescriptorGrammar | null;
```

`isDescriptorName` applies, in order:

1. **`^unknown\b`** — the Stage-1 contract, **language-independent** (the model
   emits "Unknown …" even on non-English books). Kept exactly as today.
2. **Article-led** — `^<article> <word>( <word>)?$` (≤2 words after the article),
   built from `articles`, case-insensitive + Unicode. FR `l'` elision handled
   (both `le/la/les… ` with a space and `l'…` apostrophe-no-space).
3. **Generic noun** — `bare` (lone token), `trailing` (last token of a ≥2-word
   name), or `both`.
4. **Function-word phrase (ru-only)** — a multi-word name carrying a standalone
   token from `functionWords` is a description. Leading/trailing dashes stripped
   per token (as the existing ru rule does). **This rule is RUSSIAN-ONLY** — see
   "Function-word rule is ru-only" below for why it is unsafe for es/fr/de. For
   those languages `functionWords` is empty and the rule never fires.

### The rows

| lang | articles | genericNouns (representative — full list curated, inclusion-biased) | nounMatch | functionWords |
|---|---|---|---|---|
| en | `the` | boy, girl, man, woman, guy, lady, kid, person, figure, stranger, voice *(= today's `GENERIC_ROLE_TAIL`)* | `trailing` | *(empty — en unchanged)* |
| ru | *(none)* | девушка, парень, юноша, мужчина, женщина, незнакомец, незнакомка, человек, голос, старик, старуха, парнишка, оператор, водитель *(= today's `GENERIC_ROLE_RU`)* | `bare` | *(= today's `RU_FUNCTION_WORDS`)* |
| es | el, la, los, las, un, una, unos, unas | hombre, mujer, chico, chica, desconocido, desconocida, anciano, anciana, niño, niña, señor, señora, voz, conductor | `both` | *(empty — see "Function-word rule is ru-only")* |
| fr | le, la, l', les, un, une, des | homme, femme, garçon, fille, inconnu, inconnue, vieil, vieille, voix, conducteur, enfant | `both` | *(empty)* |
| de | der, die, das, ein, eine | mann, frau, junge, mädchen, fremder, fremde, stimme, fahrer, alte, alter, kind | `both` | *(empty)* |

### Byte-identity & migration

- The inline `GENERIC_ROLE_TAIL`, `GENERIC_ROLE_RU`, `RU_FUNCTION_WORDS`
  constants **move** from `fold-minor-cast.ts` into the `en`/`ru` rows (one home,
  not copied). en (`the` + `trailing`) reproduces the `^the…$` regex + the
  trailing-noun rule; ru (`bare` + function-words) reproduces the lone-noun +
  function-word rules. Existing en/ru fold tests stay green unedited.

### Function-word rule is ru-only (adversarial-review finding B)

The Russian function-word rule is safe **only because of a Russian-specific
property** the existing code comment states outright: *a proper Russian name
structurally never contains a preposition/conjunction as a separate token.*
**That property is false for Romance and German**, whose proper names routinely
carry nobiliary/patronymic particles as standalone tokens:

- `María **de** la Cruz`, `Charles **de** Gaulle`, `Ponce **de** León`,
  `Otto **von** Bismarck`, `**von** Trapp`.

A naive port would fire on `de` / `del` / `du` / `des` / `von` and **fold real
characters into `unknown-male`** — a direct violation of the #938 lesson ("never
let a widened fold swallow a real character"). Therefore:

- **`functionWords` is empty for es/fr/de**; the rule fires for **ru only**.
- Descriptive es/fr/de phrases (`el hombre de la chaqueta`, `der Mann mit dem
  Hund`) still fold — via the **post-stage-2 line-count fold**, since by
  definition a one-off background phrase is a low-line speaker. We trade a little
  precision (these don't fold at the pre-stage-2 interim pass) for zero
  real-name false-folds.

### Known v1 limits (documented, not bugs)

- **`nounMatch:'both'`** for es/fr/de enables **bare** single-token matching —
  more aggressive (could fold a real character literally named a common noun).
  Mitigated by exact-token match against a *curated* list (not fuzzy) + the
  line-count fold + the #938 lesson backstop. de specifically *needs* bare match
  so the roster guard's German false-adds (`Mann`) get folded. **Accepted
  consequence (finding C):** a *recurring* narrator-named role rendered as a
  generic noun (`El Conductor`, `Der Hauptmann`) folds into the bucket **even with
  many lines**, because descriptor-match ignores line count — same pre-existing
  behavior as English `The Stranger`. Re-cast manually if a book makes such a
  role a main character.
- **Inflection is partial-coverage v1** (same as ru today): listed surface forms
  only, both genders spelled out, no stemmer.

---

## Unit B — roster-guard localization (#1051)

Changes in `server/src/analyzer/roster-coverage.ts` (both
`validateRosterCoverage` and `validateAttributionCoverage`) plus small additions
to `tag-grammar.ts`.

### 1. Replace the gate

Delete the `if (isNonEnglish(language)) return {ok:true,…}` early-returns.
Replace with the grammar null-guard (mirrors `recover-tagged-lines.ts`):

```ts
const g = grammarFor(language);
if (!g) return { ok: true, missingSpeakers: [], issues: [] }; // unmapped → gated
```

### 2. Build the scan from the grammar

Replace the hardcoded English `new RegExp('\\b([A-Z]…)\\s+(?:${verbAlt})\\b','g')`
with grammar-driven regexes. The guard scans **whole chapter prose** (stage-1,
pre-segmentation — only raw body text exists), so it needs a **global + multiline**
variant. Because a language can have **multiple word orders** (see §6), this is an
**array of regexes — one per order** — NOT a single alternation regex (see
"Capture-group model" below for why). Add one export to `tag-grammar.ts`:

```ts
/** Body-scan variants of tagRegexesFor: one FRESH regex PER order, each with g
    (+ m, + u as appropriate), for the whole-chapter exec-loop in
    roster-coverage.ts. Name is capture group 1 in EACH (single-group) regex.
    Body-scan ONLY — never use in the per-sentence model (its lastIndex would
    leak across sentences). Fresh objects per call → no shared state. */
export function tagScanRegexesFor(g: TagGrammar): RegExp[];
```

The body-scan loop runs each regex over the body, merging candidates. **Dedupe by
capture position, not just by name (adversarial-review finding R2-1):** the same
physical tag can be matched by two order-regexes; if both increment the candidate's
`tagCount`, a single real tag reads as 2 hits and **passes the `≥2-hits` gate
without quote-adjacency**, defeating the single-hit false-positive bound. Track
matched `m.index` spans and count each source span once. `m` (multiline) so
`VERB_BEAT`'s `^` matches each line start in a multi-line body, not just string
start. `m` is a **no-op for `en`** (its name-verb regex has no `^`/`$` anchor), so
the English scan stays byte-identical.

**Hard-wrap caveat (R2-6, verify-at-implementation):** with `m`, `VERB_BEAT`'s `^`
fires at every line start. If chapter `bodyText` is hard-wrapped mid-sentence
(newlines inside a sentence), a verb that happens to begin a wrapped line could
anchor a spurious verb-name match. Low risk (a name capture still requires a
following capitalized token), but confirm the imported body is paragraph-per-line,
not hard-wrapped, during implementation.

**Capture-group model (adversarial-review finding A):** the name is **capture
group 1 in each single-order regex**, so every `m[1]` read stays valid. We do
**NOT** build a single alternation `(?:‹nv›|‹vn›)` — that would put the name in
group 1 *or* group 2, breaking the five existing `m[1]` reads
(`recover-tagged-lines.ts:108/144/166`, `roster-coverage.ts:195/342`) with
`undefined`. Duplicate named groups `(?<name>…|…)` would fix it but are an
**ES2025 SyntaxError on Node 20** (this project's runtime) → ruled out. The array
model keeps `m[1]` semantics per regex; `en`'s single-element array is the exact
regex of today.

**Regex-model reconciliation (the briefing's "no `g` flag" warning):** that
warning targets the **per-sentence** consumers (`recover-tagged-lines.ts` `.exec`s
a non-global regex once per sentence; a `g` flag would leak `lastIndex` across
sentences). The roster guard is the **body-scan** consumer and legitimately needs
`g`. `tagScanRegexesFor` is documented body-scan-only.

### 3. Stopwords

Scan stopwords = roster-coverage's English `STOPWORDS` ∪ `g.stopwords`.

**Stopword expansion for name-verb mode (adversarial-review finding J).** The
existing `ES_STOPWORDS`/`RU_STOPWORDS` were tuned for **verb-name** detection and
are too thin for name-verb: with name-verb on, `(Capital)\s+verb` matches
sentence-openers — Spanish `Entonces dijo…` → captures `Entonces`. In the roster
guard a non-rostered candidate is *exactly what gets auto-added*, so a thin
stopword set manufactures junk roster entries (later dropped as 0-line, but
wasteful and occasionally line-catching). So **enabling both-orders requires
expanding every multi-order language's stopwords with capitalized
sentence-opener adverbs/pronouns**, not just adding fr/de rows:
- es: + `entonces, luego, después, así, pero, aunque, mientras, cuando` …
- ru: + `тогда, потом, затем, однако, хотя` …
- de (new row): `er, sie, es, dann, da, ich, du, wir, als, doch, aber` …
- fr (new row): `il, elle, je, tu, nous, alors, puis, mais, donc, quand` …

English keeps its `isStopword` de-pluralization; other languages match listed
forms only (partial, documented). The legacy English `STOPWORDS` also suppresses
*role nouns* (`man`, `council`…) at the guard; for the new languages we
deliberately do **not** port an exhaustive role-noun list here — a leaked role
noun is auto-added then **folded by Unit A**. Same outcome via the chosen
backstop.

### 4. Quote-adjacency

Today's `QUOTE_CHARS = /["“”]/` proximity window is **straight + U+201C + U+201D
only** — verified at `77ba6ec1`. It is **blind to the dialogue marks the new
languages actually use**, so it must widen to include (R2-3, exact code points):
- guillemets `«` U+00AB / `»` U+00BB (es/ru),
- German low-opening `„` U+201E (German opens `„…“`; only the *close* U+201C is
  in today's set),
- em/en-dash dialogue openers `—` U+2014 / `–` U+2013.

Looser for dash-dialogue languages, but that's the correct signal there (dialogue
*is* dash-delimited), and the fold backstops over-capture.

### 5. Auto-add: no logic change

Once the verdict goes non-ok for es/ru/fr/de, the existing
`runStage1WithRosterGuard` retry→inject path fires unchanged. `toKebabId` is
already `safeId` (Unicode-safe, plan 219), so Cyrillic/accented auto-added names
get stable ids.

**Gender of auto-adds (R2-5).** A `MissingSpeaker` carries no gender, so a
false-add German noun (`Frau`) folds into the **male** bucket (Unit A's
`pickBucket` defaults non-female → male). Cosmetic — it's a generic background
bucket either way — but noted; we do **not** add gender inference to the roster
guard (out of scope, and the bucket label isn't a per-character voice).

### 6. Both-orders detection (the word-order fix)

`tag-grammar.ts`: replace `order: 'name-verb' | 'verb-name'` with
`orders: readonly ('name-verb' | 'verb-name')[]`. Expose
`tagRegexesFor(g): RegExp[]` — **one regex per order, NOT an alternation** (per
finding A above; each keeps the name in capture group 1). **Remove the singular
`tagRegexFor` entirely (R2-2)** — keeping it as a `tagRegexesFor(g)[0]` shim is a
footgun: a caller using `[0]` silently gets only the *first* order and drops
name-verb detection for es/ru/fr/de. Forcing every caller onto the array makes the
"both orders" contract unskippable. `flipStrategy` is unchanged.

**Consumer fan-out (finding A, full blast radius).** Every consumer that today
does `const m = tagRe.exec(text); … m[1]` must loop over the order regexes
instead. Confirmed consumers on `77ba6ec1`: `recover-tagged-lines.ts` (3 sites:
`taggedSpeakerIds`, both flip branches) and `roster-coverage.ts` (2 sites). `en`
(single order) iterates a one-element array → behavior identical. This edits
#1028's just-merged `recover-tagged-lines.ts`; its existing es/ru assertions are
reviewed and updated to the both-orders expectations.

**`verbBeatRegexFor` also changes (finding D).** It currently reads `g.order`
(`tag-grammar.ts:81–84`) to pick its shape. With `orders[]` it must accept **any**
of the language's orders — a neighbour that is itself a tag must be disqualified
whether it's name-verb or verb-name. Build it as the OR of each order's verb-beat
form (still name-less; Unicode-safe via `(?!\p{L})`, not `\b`).

| lang | orders | rationale |
|---|---|---|
| en | `['name-verb']` | English narration; verb-name is archaic. Byte-identical regex. |
| es | `['verb-name', 'name-verb']` | inversion dominant + `María dijo` form. |
| fr | `['verb-name', 'name-verb']` | inversion dominant + `Marie dit` form. |
| ru | `['verb-name', 'name-verb']` | free word order; both common. |
| de | `['verb-name', 'name-verb']` | free word order; `», sagte Anna` and `Anna sagte:` both common. |

- **Why the flip needs no change:** the `'adjacent'` strategy (es/ru/fr/de)
  already flips **both** the preceding and following neighbor (guarded). A
  name-verb tag `Anna sagte: „…"` has its quote as the *next* sentence; a
  verb-name tag `„…", sagte Anna` has it as the *prev*. `'adjacent'` covers both.
  So once detection finds the tag, the existing flip recovers the quote.
- **Unicode-safe boundaries on BOTH sides (R2-8, verified).** The current
  name-verb shape is `\b(name)\s+(?:verbs)\b`. JS `\b` is ASCII-only, so it fails
  next to non-ASCII letters — and the failure is on **both** ends for ru: the
  leading `\b` before a Cyrillic name *and* the **trailing `\b` after a Cyrillic
  verb** (`сказал` ends in `л`), so `Иван сказал` never matches. The Unicode
  name-verb regex (and its `verbBeatRegexFor` form) must use lookaround
  boundaries (`(?<!\p{L})…(?!\p{L})`), not `\b`, on both sides. de verbs/names are
  ASCII-ish so `\b` would *appear* to work, but the row uses the same Unicode form
  for consistency. **en's name-verb branch keeps its exact ASCII `\b` regex**
  (byte-identity — en stays the single, unchanged regex).

### 7. German capitalized-title skip (the `Frau Schmidt` fix)

`Frau Schmidt` / `Herr Berger` is the normal German dialogue-tag shape, not a
corner case. In verb-name order the lowercase role-token skip
(`(?:\p{Ll}…){0,2}`) doesn't skip a **capitalized** German title, so `sagte Frau
Schmidt` would capture `Frau` instead of `Schmidt`.

- Add an optional `titles?: readonly string[]` field to `TagGrammar`
  (capitalized honorifics).
- the verb-name regex builder (inside `tagRegexesFor`) inserts an **optional
  title-skip** before the name capture *when the row has `titles`*:
  `… {lowercase tokens}{0,2} (?:(?:Frau|Herr|Dr|Doktor|Professor|Prof|Graf|Gräfin|König|Königin|Prinz|Prinzessin|Baron|Baronin|Meister|Hauptmann|Fräulein)\.?\s+)? (NAME)`
  (`\.?` absorbs `Dr.`).
- **de row only carries `titles`.** en/es/ru/fr rows have no `titles` → the regex
  is byte-identical for them (es/ru honorifics are lowercase, already covered by
  the lowercase skip).
- **Regex backtracking handles the degenerate cases:** `sagte Frau Schmidt` →
  captures `Schmidt`; `sagte Anna` → captures `Anna`; lone `sagte Frau.` →
  title-skip can't satisfy a trailing name, backtracks, captures `Frau` → folds
  as a `genericNouns` descriptor. In name-verb order the pre-verb token is the
  surname already (`Frau Schmidt sagte` → single-token capture `Schmidt`), so no
  title-skip needed there.
- **Bonus:** because this lives in `tag-grammar.ts`, it also fixes #1028's flip +
  keep-protection for `Frau Schmidt` once de is mapped.
- **`isQuoteBearing` needs German `„` U+201E (R2-3, second surface).** `QUOTE_GLYPHS`
  (which `isQuoteBearing` tests, and which the flip's `qualifies()` relies on) was
  verified to contain `« » “ ”` + dashes but **not** `„` U+201E. German opens with
  `„` and closes with `“`; only the close is covered, so a German narrator quote
  tagged near its *opening* mark isn't recognized as quote-bearing and the flip
  skips it. Add U+201E to `QUOTE_GLYPHS`.

### Remaining de limit (documented)

Single-token name capture means `sagte Frau von Habsburg`-style multi-token
surnames are partially covered — the capture lands on one token (`Habsburg`),
dropping the `von` particle. Acceptable v1; backstopped. (Note: `von` is **not**
in any descriptor `functionWords` set — those are ru-only per finding B — so this
is purely a tag-capture granularity limit, not a fold-safety issue.)

---

## How the layers compose (ordering)

The roster guard runs at **stage-1** (`runStage1WithRosterGuard`); #1028's
keep-protection + flip run **post-stage-2**. So #1051 **feeds** #1028: once #1051
rosters Berrin, #1028's `taggedSpeakerIds` keeps his slot and the flip pulls his
stranded quote off narrator. Complementary layers — #1051 unlocks #1028's value
on the real analyzer.

Implementation order: **Unit A (#1050) → Unit B (#1051)** (Unit A is the fold
backstop that makes Unit B's fr/de full-parity safe).

## Call sites (verify, don't rewrite)

`server/src/routes/analysis.ts`: `runStage1Guarded` wrapper (~`:529`) and callers
(~`:2783`, ~`:4608`) already thread `bookLanguage` (via
`resolveBookLanguageForManuscript` ~`:2178`/`:4451`), the same path #1028's
consumers use. Implementation must **verify** es/ru/fr/de actually reach the guard
— a quick trace, not a rewrite.

**Also verify `foldMinorCast` gets `language` at BOTH passes (R2-4).** Unit A only
fires for es/fr/de if `opts.language` reaches `foldMinorCast`. The **final**
(post-stage-2) pass already threads it — #1028's keep-protection needs it
(`taggedSpeakerIds(…, language)`). The **interim** (`nameOnly`) cast-write pass is
**unverified**; if it doesn't pass `language`, es/fr/de descriptors fold only at
the final pass (acceptable — the interim cast briefly shows an un-folded
descriptor — but make it a conscious choice, not an accident). Verify both call
sites; thread `language` into the interim pass if cheap.

## Testing strategy

**Unit A (#1050):**
- New `descriptor-grammar.test.ts` — table/matcher unit tests per language.
- `fold-minor-cast.test.ts`: en/ru cases stay green **unedited** (byte-identity) —
  including the ru function-word phrase case (`женщина с двумя овчарками`), which
  must still fold (ru keeps the rule). **Add** es/fr/de descriptor cases —
  article-led (`El Hombre`, `Le Garçon`, `Der Mann`), bare noun (`Desconocido`,
  `Mann`). **Add negative cases (finding B):** a real es/fr/de name carrying a
  particle (`María de la Cruz`, `Charles de Gaulle`, `Otto von Bismarck`) must
  **NOT** fold — proves the function-word rule is off for those languages.

**Unit B (#1051):**
- `roster-coverage.test.ts`: en stays green **unedited**; the de seam-3d gate
  tests (confirmed `:285–287`, `:303–304`, asserting de no-ops) are **inverted to
  detection assertions** — de is now mapped, so they must assert it *flags/adds*,
  not no-op (finding F; this is a rewrite-in-place, never a delete/`.skip`). es/ru/fr
  have no conflicting no-op gate tests there (de-only).
- **Both-orders stopword cases (finding J):** a Spanish sentence-opener
  (`Entonces dijo …`) must **not** produce a roster add — pin the expanded
  stopwords so junk candidates are suppressed.
- **Test the ADD path — the trap #1028 fell into.** Feed a prose-tagged speaker
  **NOT in the roster** and assert recovery: es `«Está bien», dijo Berrin`, ru
  `«…», — сказал Одуван` (+ fr/de analogues) → `validateRosterCoverage` returns
  them in `missingSpeakers`, and `runStage1WithRosterGuard` **auto-adds** them.
  (Not the rostered-input path that hid the bug.)
- **Both-orders cases:** a speaker tagged **only** in name-verb form
  (`Anna sagte`, `María dijo`, `Иван сказал`) is recovered, alongside the
  verb-name form (`sagte Anna`, `dijo María`, `сказал Иван`).
- **German title case:** `sagte Frau Schmidt` recovers **`Schmidt`** (not `Frau`);
  lone `sagte Frau` folds as descriptor.

**`tag-grammar.test.ts`:** add fr/de row tests (verb list, both orders each
capture the name in group 1, German title-skip, `tagScanRegexesFor`
global/multiline array behavior). Pin that **no single alternation regex is
built** (finding A) — e.g. assert `tagRegexesFor(g).length === g.orders.length`.

**Activated #1028 paths (consequence of the all-four choice):** because fr/de
tag-grammar rows + both-orders detection turn on / change the flip +
keep-protection for those languages, **add fr/de coverage** to
`recover-tagged-lines.test.ts` and the fold keep-protection tests, and **review**
existing es/ru assertions there for the both-orders change.

**Drift/integration:** `DIALOGUE_VERBS` is untouched (fr/de verbs live in
`tag-grammar.ts`), so the `dialogue-verbs-drift` test is unaffected — confirm.

## Owed validation (post-merge, on-box — cannot run in this environment)

- **es re-acceptance.** Both-orders detection changes the accepted Spanish render
  → re-run the Gemini e2e (`scratchpad/gateA.mjs` driver, per the briefing) and
  re-confirm operator acceptance. **Pass = Berrin and Ivo appear as their own
  cast members and `«Está bien»` → `berrin` (not `unknown-male`).**
- **ru** equivalent once the background ru pass lands (briefing will append ru
  data to #1051).
- **fr/de** smoke pass at minimum (translated Coalfall fixtures exist:
  `samples/the-coalfall-commission/manuscript.{fr,de}.md`).
- These are flagged here and belong in the plan's per-task gates + the eventual
  Ship notes, not as blocking the unit-test landing.

## Files touched

- `server/src/analyzer/descriptor-grammar.ts` — **new** (Unit A).
- `server/src/analyzer/descriptor-grammar.test.ts` — **new**.
- `server/src/analyzer/fold-minor-cast.ts` — `isDescriptorName` consumes the new
  grammar; inline constants move out.
- `server/src/analyzer/tag-grammar.ts` — `orders[]`, optional `titles`,
  `tagRegexesFor`/`tagScanRegexesFor` (array model, finding A), **`tagRegexFor`
  removed (R2-2)**, `verbBeatRegexFor` multi-order + Unicode boundaries both sides
  (finding D, R2-8), `QUOTE_GLYPHS` += `„` U+201E (R2-3), expanded es/ru stopwords
  + new fr/de rows (finding J), fr/de grammar rows (de articles nominative-only, R2-7).
- `server/src/analyzer/recover-tagged-lines.ts` — **not just a consumer**: its 3
  `m[1]` sites loop over the order-regex array (finding A); en path unchanged.
- `server/src/analyzer/roster-coverage.ts` — gate swap, grammar-driven array scan
  with **per-position match dedupe (R2-1)**, `QUOTE_CHARS` widened to `« » „` +
  dashes (R2-3), stopword union, and **remove the now-orphaned `isNonEnglish`
  import** (finding E).
- Tests: `fold-minor-cast.test.ts`, `tag-grammar.test.ts`,
  `roster-coverage.test.ts`, `recover-tagged-lines.test.ts` (+ fold keep-protection).
- Verify-only: `server/src/routes/analysis.ts` language threading at the three
  call sites.

## Out of scope

- Full helper dedup between `roster-coverage.ts` and `recover-tagged-lines.ts`
  (`rosterTokenSet`/`buildNameToId`, the two `stripPossessive`s) — that's the
  separately-tracked **#1046**. Reuse what's natural via the grammar; don't
  scope-creep the dedup here.
- Languages beyond es/ru/fr/de — stay gated (unmapped → no-op).
- A stemmer for inflected descriptor nouns / verbs — listed surface forms only.
- `scripts/recover-missing-character.mjs` (the manual operator hotfix) carries its
  own literal English verb scan and **stays English-only** (finding G) — it's
  operator-run, not in the analysis pipeline. Localizing it is a separate item if
  ever needed.
