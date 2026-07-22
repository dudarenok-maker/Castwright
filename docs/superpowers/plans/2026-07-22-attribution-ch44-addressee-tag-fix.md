# ch44 addressee-name tag fix + eval corpus hygiene — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the deterministic attribution engine from minting a *strong* `tag-name`
for an **addressee/bystander** name inside a tag clause (`"…," he said to Valkyrie.` →
"Valkyrie"), and clean the ch44 eval corpus so the frozen-raw A/B measures the real
engine lift rather than label noise.

**Architecture:** A new pure `findSubjectName` in `name-matcher.ts` resolves the tag
clause's *subject* by verb position (nearest roster name before the speech/beat verb;
inverted `said X` after it, **rejected** when an addressee preposition, a bystander
conjunction, or a **subject pronoun** intervenes — the pronoun clause is
language-general and makes Russian's caseless dative `сказал он Валери` work).
`parser.ts:applyTag` uses it when the language convention opts in via a new
`addresseePrepositions` field, **populated for all five supported languages**
(en/de/es/fr/ru); an unsupported language resolves to the empty convention table → no
verb → legacy first-match → byte-identical (247 invariant #4). Rule #2 (247 invariant
#2) is untouched — a genuine subject-name tag stays strong. Two scoring-side fixes (a `canonicalId` alias
seam; ch44 label cleanup) de-noise the eval; a frozen-raw A/B measures the delta.

**Tech Stack:** TypeScript (server, ESM NodeNext `.js` specifiers), Vitest (node env),
Ollama `qwen36-cw-iq4-32k` for the on-box acceptance eval.

**Design of record:** `docs/superpowers/specs/2026-07-22-attribution-ch44-addressee-tag-fix-design.md`
**Feature doc updated on ship:** `docs/features/265-attribution-eval-tuning.md`
**Invariant home:** `docs/features/247-dialogue-structure-attribution.md`

## Global Constraints

Every task's requirements implicitly include these:

- **Rule #2 stays intact.** We narrow *evidence* (which name a tag anchors); we never
  weaken `crossExamine`'s strong-`tag-name` force-correction. Do not touch
  `cross-examine.ts` decision logic.
- **Language-general logic; per-language markers; unsupported byte-identical.** The
  subject-position path is gated on the convention carrying `addresseePrepositions`,
  populated for all five supported languages. An **unsupported/unknown** language
  resolves to the empty convention table (no verb stems), so `findSubjectName` finds no
  verb and returns the first name = legacy `findRosterName` parity → byte-identical (247
  invariant #4). The **existing dialogue-structure suite must stay green** (RU dash
  fixture + DE #1598 cases use only clean subject/inverted tags) — that is the ru/de
  regression guard, since the eval corpus is English-only.
- **Token-boundary matching, never substring.** Verb / preposition / conjunction /
  pronoun / name detection keys on tokenized words, not `String.includes` (`say`⊄"essay",
  `call`⊄"recalled", `add`⊄"saddle").
- **Closed per-language preposition sets** (below). English: `to`, `at`, `toward`,
  `towards`, `for` — **explicitly NOT** `from` / `of` / `with` (they precede real
  inverted subjects, `came a shout from Skulduggery`). de: `zu`, `an`. es: `a`. fr: `à`.
  ru: `к`. Conjunction sets: en `and`/`but`, de `und`/`aber`, es `y`/`pero`, fr
  `et`/`mais`, ru `и`/`но`.
- **Do not delete the `the_torment` roster id and do not mutate the name index.** The
  duplicate-id equivalence is handled scorer-side via an optional `canonicalId` field.
- **Measurement is frozen-raw A/B**, not staged model re-runs (see Acceptance).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `server/src/analyzer/dialogue-structure/types.ts` | `LanguageConventions` gains optional `addresseePrepositions` / `tagClauseConjunctions` | 1 |
| `server/src/analyzer/dialogue-structure/lang/{en,de,es,fr,ru}.ts` | populate each language's two marker lists | 1 |
| `server/src/analyzer/dialogue-structure/name-matcher.ts` | new pure `findSubjectName(text, index)` (verb-position + pronoun-between) | 1 |
| `server/src/analyzer/dialogue-structure/name-matcher.test.ts` | `findSubjectName` matrix | 1 |
| `server/src/analyzer/dialogue-structure/parser.ts` | `applyTag` uses `findSubjectName` when opted in | 2 |
| `server/src/analyzer/dialogue-structure/parser.test.ts` | reject / keep-strong / non-en byte-identical | 2 |
| `server/src/analyzer/attribution-eval/roster-schema.ts` | optional `canonicalId` on a roster character | 3 |
| `server/src/analyzer/attribution-eval/run-eval.ts` | build alias map from `canonicalId`, thread into scoring | 3 |
| `server/src/analyzer/attribution-eval/scorer.test.ts` | `aliasMap` canonicalization case | 3 |
| `server/src/analyzer/attribution-eval/run-eval.test.ts` | `rosterAliasMap` from `canonicalId` | 3 |

Git-ignored corpus data edits (`playing-with-fire.roster.json`, `…-ch44.en.labelled.json`)
and the frozen-raw A/B are **controller-run acceptance**, not subagent tasks — a fresh
worktree has no corpus.

---

### Task 1: `findSubjectName` — subject-by-verb-position + convention opt-in

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/types.ts` (`LanguageConventions`)
- Modify: `server/src/analyzer/dialogue-structure/lang/{en,de,es,fr,ru}.ts`
- Modify: `server/src/analyzer/dialogue-structure/name-matcher.ts`
- Test: `server/src/analyzer/dialogue-structure/name-matcher.test.ts`

**Interfaces:**
- Produces: `findSubjectName(text: string, index: NameIndex): { id: string; tokenStart: number } | null`
  — the first subject-positioned roster name in a tag clause, or `null` when the only
  match is an addressee/bystander. Consumed by Task 2.
- Produces (types): `LanguageConventions.addresseePrepositions?: string[]`,
  `LanguageConventions.tagClauseConjunctions?: string[]`. Presence of
  `addresseePrepositions` is the opt-in signal Task 2 gates on.

- [ ] **Step 1: Add the convention fields (types.ts).** After `pronouns` in the
  interface:

```ts
  /** English-only opt-in: post-verb names preceded by one of these are the
      ADDRESSEE, not the speaker (`he said to Valkyrie`). PRESENCE of this field
      opts the language into subject-position tag resolution (findSubjectName);
      absence → legacy first-match (findRosterName), byte-identical. Closed set —
      never include `from`/`of` (they precede real inverted subjects). */
  addresseePrepositions?: string[];
  /** Coordinating conjunctions introducing a bystander clause after the verb
      (`a voice said and Valkyrie turned`). */
  tagClauseConjunctions?: string[];
```

- [ ] **Step 2: Populate all five languages.** After `pronouns: { … },` in each table:

```ts
// en.ts
  addresseePrepositions: ['to', 'at', 'toward', 'towards', 'for'],
  tagClauseConjunctions: ['and', 'but'],
// de.ts
  addresseePrepositions: ['zu', 'an'],
  tagClauseConjunctions: ['und', 'aber'],
// es.ts
  addresseePrepositions: ['a'],
  tagClauseConjunctions: ['y', 'pero'],
// fr.ts
  addresseePrepositions: ['à'],
  tagClauseConjunctions: ['et', 'mais'],
// ru.ts  (bare-dative addressees are caught by the pronoun-between clause, not a prep)
  addresseePrepositions: ['к'],
  tagClauseConjunctions: ['и', 'но'],
```

- [ ] **Step 3: Write failing tests (name-matcher.test.ts).** Add a suite building an
  index from a small English roster via `buildNameIndex(roster, en)`. Roster:
  `Anton` (id `anton`), `Boris` (id `boris`), `Valkyrie` (id `valkyrie`),
  `Skulduggery` (id `skulduggery`).

```ts
import { en } from './lang/en.js';
import { de } from './lang/de.js';
import { es } from './lang/es.js';
import { ru } from './lang/ru.js';
import { buildNameIndex, findSubjectName } from './name-matcher.js';

const idx = buildNameIndex(
  [
    { id: 'anton', name: 'Anton' },
    { id: 'boris', name: 'Boris' },
    { id: 'valkyrie', name: 'Valkyrie' },
    { id: 'skulduggery', name: 'Skulduggery' },
  ],
  en,
);
const subj = (t: string) => findSubjectName(t, idx)?.id ?? null;

describe('findSubjectName', () => {
  it('before-verb subject', () => {
    expect(subj('Anton said')).toBe('anton');
    expect(subj('Sanguine said, shaking his head')).toBe(null); // Sanguine not in roster → no name
    expect(subj('Anton said, folding his arms')).toBe('anton');
  });
  it('inverted subject (said X)', () => {
    expect(subj('said Anton')).toBe('anton');
    expect(subj('said Anton to Boris')).toBe('anton'); // addressee Boris ignored
  });
  it('rejects addressee after a preposition → null (pronoun fallthrough)', () => {
    expect(subj('he said to Valkyrie')).toBe(null);
    expect(subj('she shouted at Valkyrie')).toBe(null);
  });
  it('rejects bystander after a conjunction → null', () => {
    expect(subj('a voice said and Valkyrie turned')).toBe(null);
  });
  it('picks the earlier subject when both subject and addressee are named', () => {
    expect(subj('Skulduggery said to Valkyrie')).toBe('skulduggery');
  });
  it('nearest-before-verb resolves a perception frame', () => {
    // "say" is the only verb; nearest name before it is Skulduggery, not Valkyrie
    expect(subj('Valkyrie heard Skulduggery say')).toBe('skulduggery');
  });
  it('does NOT treat `from` as an addressee marker', () => {
    expect(subj('came a shout from Skulduggery')).toBe('skulduggery');
  });
  it('substring is not a verb match', () => {
    // "essay" must not register as the verb "say"; no verb, single name → that name
    expect(subj('Anton essay')).toBe('anton');
  });
});

describe('findSubjectName — other languages', () => {
  const ruIdx = buildNameIndex(
    [{ id: 'anton', name: 'Антон' }, { id: 'valeri', name: 'Валери' }, { id: 'olga', name: 'Ольга' }],
    ru,
  );
  const ruSubj = (t: string) => findSubjectName(t, ruIdx)?.id ?? null;
  it('ru inverted subject accepts (сказал Антон)', () => {
    expect(ruSubj('сказал Антон')).toBe('anton');
    expect(ruSubj('сказала Ольга')).toBe('olga');
  });
  it('ru caseless dative addressee rejected via pronoun-between (сказал он Валери)', () => {
    // no preposition — `он` between verb and Валери marks Валери as the dative addressee
    expect(ruSubj('сказал он Валери')).toBe(null);
  });
  it('ru «к» preposition marks an addressee (mechanism; recognized verb + к + name)', () => {
    // synthetic phrasing to isolate the preposition clause: `к` before the name → reject
    expect(ruSubj('сказал что-то к Антону')).toBe(null);
  });

  const deIdx = buildNameIndex([{ id: 'oduvan', name: 'Oduvan' }, { id: 'maerin', name: 'Maerin' }], de);
  it('de inverted subject with title accepts; `zu` addressee rejected', () => {
    expect(findSubjectName('sagte Meister Oduvan', deIdx)?.id).toBe('oduvan');
    expect(findSubjectName('sagte er zu Maerin', deIdx)).toBeNull();
  });

  const esIdx = buildNameIndex([{ id: 'boris', name: 'Boris' }, { id: 'ana', name: 'Ana' }], es);
  it('es `a` addressee rejected; nearer inverted subject wins', () => {
    expect(findSubjectName('dijo a Ana', esIdx)).toBeNull();
    expect(findSubjectName('dijo Boris a Ana', esIdx)?.id).toBe('boris'); // Boris nearer, Ana is addressee
  });
});
```

- [ ] **Step 4: Run — expect FAIL** (`findSubjectName` undefined):
  `npm --prefix server test -- name-matcher`

- [ ] **Step 5: Implement `findSubjectName` (name-matcher.ts).** Append:

```ts
/** Lowercased word tokens with their start offsets in `text`. */
function tokenizeWithOffsets(text: string): Array<{ tok: string; start: number }> {
  const out: Array<{ tok: string; start: number }> = [];
  const re = /\p{L}+/gu;
  const lower = text.toLowerCase();
  for (let m = re.exec(lower); m; m = re.exec(lower)) out.push({ tok: m[0], start: m.index });
  return out;
}

/** A token is a speech/beat verb when a convention stem is its PREFIX (stems are
    word-initial). Prefix, not substring — `essay`.startsWith('say') is false. */
function isVerbToken(tok: string, index: NameIndex): boolean {
  const { speechVerbStems, beatVerbStems } = index.conventions;
  return [...speechVerbStems, ...beatVerbStems].some((s) => tok.startsWith(s));
}

function rosterIdOf(tok: string, index: NameIndex): string | null {
  const stem = index.conventions.nameStemmer(tok);
  if (stem.length < index.conventions.minStemLength) return null;
  return index.stems.get(stem) ?? null;
}

/** A subject pronoun (per the language's `pronouns` regexes) — used to detect
    that an after-verb name is NOT the inverted subject (`сказал он Валери`,
    `sagte er zu X`, `dit-il à X`). The regexes want boundary context, so test
    the token wrapped in spaces. */
function isPronounToken(tok: string, index: NameIndex): boolean {
  const p = index.conventions.pronouns;
  const w = ` ${tok} `;
  return [p.firstPerson, p.male, p.female].some((re) => re != null && re.test(w));
}

/** The subject-positioned roster name of a tag clause, or null when the only
    roster match is an addressee (after an addressee preposition or the subject
    pronoun) or a bystander (after a clause conjunction). Language-general:
    keyed on per-language markers + the shared pronouns. Non-CJK opt-in path. */
export function findSubjectName(text: string, index: NameIndex): { id: string; tokenStart: number } | null {
  const toks = tokenizeWithOffsets(text);
  const nameHits = toks
    .map((t) => ({ start: t.start, id: rosterIdOf(t.tok, index) }))
    .filter((t): t is { start: number; id: string } => t.id !== null);
  if (nameHits.length === 0) return null;

  const verbIdx = toks.findIndex((t) => isVerbToken(t.tok, index));
  if (verbIdx < 0) return { id: nameHits[0].id, tokenStart: nameHits[0].start }; // no verb → legacy first-match parity
  const verbStart = toks[verbIdx].start;

  const before = nameHits.filter((n) => n.start < verbStart);
  if (before.length) {
    const nearest = before[before.length - 1]; // token order → last before the verb
    return { id: nearest.id, tokenStart: nearest.start };
  }

  const cand = nameHits.find((n) => n.start > verbStart);
  if (!cand) return null;
  const between = toks.filter((t) => t.start > verbStart && t.start < cand.start);
  const preps = new Set(index.conventions.addresseePrepositions ?? []);
  const conjs = new Set(index.conventions.tagClauseConjunctions ?? []);
  // addressee (preposition), bystander (conjunction), OR a subject pronoun between
  // the verb and the name (caseless-dative addressee) → the name is not the subject.
  if (between.some((t) => preps.has(t.tok) || conjs.has(t.tok) || isPronounToken(t.tok, index))) return null;
  return { id: cand.id, tokenStart: cand.start };
}
```

- [ ] **Step 6: Run — expect PASS:** `npm --prefix server test -- name-matcher`
- [ ] **Step 7: Commit:** `feat(server): findSubjectName resolves tag subject by verb position`

---

### Task 2: Wire `applyTag` to reject addressee/bystander names

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/parser.ts` (`applyTag`)
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:**
- Consumes: `findSubjectName` (Task 1); `LanguageConventions.addresseePrepositions`
  (Task 1) as the opt-in gate.
- Produces: no new export. Behaviour: an opted-in language mints `tag-name` only for a
  subject-positioned name; a rejected name falls through to `classifyPronoun`, exactly
  as if no name were found (`pendingPronoun` or nothing). Non-opted-in languages
  unchanged.

- [ ] **Step 1: Write failing tests (parser.test.ts).** Add end-to-end paragraph cases
  through `parseChapterStructure(body, buildNameIndex(roster, en))`. Assert the SPEECH
  span's `speaker`:

```ts
// helper: first speech span of the single paragraph
const speech = (body: string, idx: NameIndex) =>
  parseChapterStructure(body, idx)[0].spans.find((s) => s.kind === 'speech');

it('addressee name does not become a tag-name speaker (en)', () => {
  const idx = buildNameIndex([
    { id: 'skulduggery', name: 'Skulduggery' },
    { id: 'valkyrie', name: 'Valkyrie' },
  ], en);
  const sp = speech('“Fireball,” he said to Valkyrie.', idx);
  expect(sp?.speaker).toBeUndefined();                 // not force-anchored to Valkyrie
  expect((sp as any)?.pendingPronoun).toBe('male');    // falls through to pronoun `he`
});

it('subject name still anchors strong (en)', () => {
  const idx = buildNameIndex([{ id: 'sanguine', name: 'Sanguine', aliases: ['Sanguine'] }], en);
  const sp = speech('“Curse you,” Sanguine said.', idx);
  expect(sp?.speaker).toEqual({ characterId: 'sanguine', source: 'tag-name' });
});
```

  Plus an **opt-in-gate guard** (the unsupported/empty-table byte-identical path): build
  an index with a convention lacking `addresseePrepositions` — a stub
  `{ ...en, addresseePrepositions: undefined, tagClauseConjunctions: undefined }` — and
  assert `applyTag` still takes the legacy `findRosterName` route (a post-verb addressee
  name still anchors). This proves the gate is real, so an unsupported language (empty
  convention table) stays byte-identical (247 invariant #4). The five *supported*
  languages opting in is covered by Step 5's full-suite run (RU/DE fixtures stay green).

- [ ] **Step 2: Run — expect FAIL:** `npm --prefix server test -- parser`

- [ ] **Step 3: Implement the gate (parser.ts).** In `applyTag`, replace
  `const name = findRosterName(text, index);` with:

```ts
    const name = conv.addresseePrepositions
      ? (findSubjectName(text, index)?.id ?? null)
      : findRosterName(text, index);
```

  Add `findSubjectName` to the existing name-matcher import. Everything below `if (name)`
  is unchanged — a rejected name yields `null`, so control flows to the existing
  `classifyPronoun` branch.

- [ ] **Step 4: Run — expect PASS:** `npm --prefix server test -- parser`
- [ ] **Step 5: Run the whole dialogue-structure suite** to confirm no RU/DE/parser
  regression: `npm --prefix server test -- dialogue-structure`
- [ ] **Step 6: Commit:** `fix(server): reject addressee/bystander tag names in opted-in languages`

---

### Task 3: Scorer alias canonicalization (`canonicalId`) — de-noise the duplicate id

**Files:**
- Modify: `server/src/analyzer/attribution-eval/roster-schema.ts`
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts`
- Test: `server/src/analyzer/attribution-eval/scorer.test.ts`,
  `server/src/analyzer/attribution-eval/run-eval.test.ts`

**Interfaces:**
- Consumes: `scoreAttribution(truth, predicted, aliasMap?)` (already exists,
  `scorer.ts:35-38`), currently called with no map.
- Produces: `RosterSnapshot.characters[].canonicalId?: string`; a `rosterAliasMap(roster)`
  in `run-eval.ts` threaded into both `scoreAttribution` calls inside `scoreStage`.

- [ ] **Step 1: Write failing scorer test (scorer.test.ts).** `scoreAttribution` with an
  `aliasMap` counts a canonical-equivalent prediction as a true positive:

```ts
it('aliasMap canonicalizes equivalent ids', () => {
  const truth = { chapterText: '', lines: [{ text: 'Leave.', speakerId: 'unknown-male' }] };
  const map = new Map([['the_torment', 'unknown-male']]);
  const s = scoreAttribution(truth, [{ text: 'Leave.', characterId: 'the_torment' }], map);
  expect(s.truePositive).toBe(1);
  expect(s.falseNegative).toBe(0);
});
```

- [ ] **Step 2: Write failing run-eval test (run-eval.test.ts).** `rosterAliasMap` builds
  from `canonicalId`:

```ts
it('rosterAliasMap maps canonicalId', () => {
  const map = rosterAliasMap({ characters: [
    { id: 'the_torment', name: 'Torment', canonicalId: 'unknown-male' },
    { id: 'unknown-male', name: 'Unknown male' },
  ]});
  expect(map.get('the_torment')).toBe('unknown-male');
  expect(map.has('unknown-male')).toBe(false);
});
```

- [ ] **Step 3: Run — expect FAIL** (`canonicalId` stripped by schema; `rosterAliasMap`
  undefined): `npm --prefix server test -- attribution-eval`

- [ ] **Step 4: Add `canonicalId` to the schema (roster-schema.ts).** In the character
  object: `canonicalId: z.string().optional(),`.

- [ ] **Step 5: Add `rosterAliasMap` + thread it (run-eval.ts).**

```ts
export function rosterAliasMap(roster: RosterSnapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of roster.characters) if (c.canonicalId) m.set(c.id, c.canonicalId);
  return m;
}
```

  Widen `scoreStage` to accept an `aliasMap?: Map<string, string>` and pass it into
  `scoreAttribution(truth, toPredicted(sentences), aliasMap)`. In `evalFixture`, compute
  `const aliasMap = rosterAliasMap(opts.roster);` once and pass it to all three
  `scoreStage` calls (raw / deterministic / final). `familyBreakdown` already reads the
  returned `perLine`, so canonicalization flows through unchanged.

- [ ] **Step 6: Run — expect PASS:** `npm --prefix server test -- attribution-eval`
- [ ] **Step 7: Commit:** `test(server): canonicalId alias seam de-dupes the_torment in eval scoring`

---

## Controller-run acceptance (on-box, main checkout — git-ignored corpus)

Not subagent tasks: a fresh worktree has no corpus. Run these in the main checkout after
Tasks 1–3 land on the branch.

**A. Corpus data edits (recorded for reviewability):**
1. `playing-with-fire.roster.json`: add `"canonicalId": "unknown-male"` to the
   `the_torment` entry. (Do NOT remove the entry.)
2. `playing-with-fire-ch44.en.labelled.json`: relabel the continuation-as-`narrator`
   lines to their speaker. **Scope: only own-text-quoted lines inside an uninterrupted
   single-speaker quoted run.** The confirmed set from the diagnostic, each recorded
   with its quotation for reviewer verification without the book:

   | Quoted line (own text) | Speaker (was `narrator`) | Enclosing turn |
   |---|---|---|
   | `"You have emerged triumphant and victorious."` | `billy-ray-sanguine` | `"Look at what you've done," Sanguine said…` |
   | `"Curse you."` | `billy-ray-sanguine` | same Sanguine turn |
   | `"You actually think this is finished?"` | `billy-ray-sanguine` | same Sanguine turn |
   | `"Leave me to take care of this creature."` | `unknown-male` | `"Leave," the old man said…` |
   | `"It's our last chance."` | `skulduggery-pleasant` | `"Fireball," he said to Valkyrie…` |

   Re-verify each against the ch44 text before flipping; skip any the surrounding run
   does not unambiguously assign, and note the skip.

**B. Frozen-raw A/B (the load-bearing measurement).** A scratch script (delete after;
record numbers in 265), mirroring the deterministic block at
`server/src/routes/analysis.ts:1894-1906`:
1. Capture raw ONCE per fixture (N≥3 runs, real `qwen36-cw-iq4-32k`) via a mock/real
   `attributeChapterStage2` with `onStages`; persist each run's `raw` `SentenceOutput[]`.
2. For each frozen raw run, run `buildNameIndex → parseChapterStructure → resolveWindows
   → alignSentences → crossExamine` with two conventions over the SAME raw:
   **baseline** = `{ ...en, addresseePrepositions: undefined, tagClauseConjunctions:
   undefined }` (legacy path), **treatment** = `en`. Score both with the cleaned labels +
   `rosterAliasMap`.
3. Report, over identical raw: **(①+②)** = baseline-vs-cleaned-labels/alias delta (the
   *noise* share); **(③)** = baseline→treatment delta under cleaned labels (the *real
   engine lift*); `diff-runs.ts` for the changed-line list.

**C. No-regression guard.** Same frozen-raw replay on ch43/45/46 + the committed Coalfall
guardrail: report each fixture's baseline→treatment changed-line count; **name and assert
the specific Coalfall assertion(s) that must not move** (cite them in the 265 update). Add
a male–male-window non-regression check on the ch44 rejected lines (per the spec risk).

**D. Residual checklist:** confirm whether `"Hey," → melissa-edgley` and the
perception-verb frame survive the treatment replay; record outcomes (do not fix blind).

## Before-shipping

- [ ] Update `docs/features/265-attribution-eval-tuning.md`: append the frozen-raw A/B
  section (noise share vs. engine lift, changed-line counts, Coalfall assertion cited).
  **State the measurement scope explicitly:** the quantified lift is English (the only
  eval corpus); ru/de/es/fr ship the same fix + per-language unit tests with the existing
  suite green, and their *quantified* real-book acceptance is deferred to `#1759`'s
  fixtures — note this so it isn't mistaken for "measured across all languages."
- [ ] Release notes **required** (unlike #1758 — this changes real-book attribution):
  append to `docs/release-notes-next.md` (technical) + a brand-voice line to the
  in-progress section of `RELEASE_NOTES.md` (e.g. "Fewer lines mis-cast to the person
  being *spoken to* instead of the speaker").
- [ ] File the GitHub issue (`srv-…`, `bug` label — a real wrong-voice defect); PR body
  `Closes #NN`.
- [ ] `npm run verify:fast:branch`; open PR; mandatory `code-review` (medium — single-
  scope `fix`) before merge.

## Self-Review

- **Spec coverage:** ③ parser fix = Tasks 1–2; ② alias seam = Task 3; ① label cleanup =
  Acceptance A; frozen-raw A/B = Acceptance B; guards = Acceptance C; residuals = D. ✓
- **Type consistency:** `findSubjectName` returns `{id, tokenStart}` (Task 1) and is
  consumed as `?.id` (Task 2). `rosterAliasMap` / `canonicalId` consistent across Task 3
  + Acceptance A. `aliasMap: Map<string,string>` matches `scoreAttribution`'s signature. ✓
- **Placeholder scan:** none — every step carries real code or a concrete command. ✓
