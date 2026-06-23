# Localized minor-cast tag detection (ES + RU) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the minor-cast keep-protection AND the narrator-flip recovery for Spanish and Russian books — which seam-3d (`f335b0c8`) gated off — via a per-language tag grammar, closing #1028.

**Architecture:** A new pure module `server/src/analyzer/tag-grammar.ts` holds a per-language table (`verbs`, word `order`, Unicode `nameCapture`, `flipStrategy`, `stopwords`) plus the regex builders derived from it. `server/src/analyzer/recover-tagged-lines.ts` swaps its `isNonEnglish` no-op for `grammarFor(language)`: English stays byte-identical, `es`/`ru` come alive, and any unmapped language (fr/de/…) keeps the existing gated no-op. No call-site changes — seam-3d already threads the book language into both consumers.

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+, Vitest (server, node env).

**Design spec:** `docs/superpowers/specs/2026-06-23-localized-minor-cast-tag-detection-design.md` (read it — it carries three rounds of adversarial review and the rationale for every guard below).

## Global Constraints

- **English behaviour byte-identical.** Every existing assertion in `recover-tagged-lines.test.ts` and `fold-minor-cast.test.ts` stays green, untouched. The `en` grammar row + its `name-verb` regex reproduce today's `makeTagRegex` exactly, including **no `u` flag**.
- **No `g` flag on any tag regex.** `.exec` is reused across sentences in a loop; a global flag makes `lastIndex` stateful and skips matches (spec F3).
- **`DIALOGUE_VERBS` + the `.mjs` hotfix copy + `dialogue-verbs-drift.test.mjs` are untouched.** `en` reuses `DIALOGUE_VERBS`; ES/RU verb lists live only in `tag-grammar.ts`.
- **Stopword union is per-call, never mutates the module `STOPWORDS` set** (spec C/round-2).
- **Gate predicate is `grammarFor(language)`** (keyed by `normaliseBookLanguage`): `en`/`es`/`ru` resolve a row; everything else resolves `null` → existing no-op.
- **Two-phase release (spec R7):** Tasks 1–2 (keep-protection) close #1028 and merge on green tests. Tasks 3–5 (the flip) are gated on an on-box segmentation observation AND Spanish-canary re-acceptance, because the flip changes the attribution of an already-operator-accepted render.
- ESM `.js` imports. Commit `<type>(<scope>): <subject>` (husky `commit-msg` enforces it). Husky pre-commit (`verify:fast:scoped`) runs the server leg — keep it green, never `--no-verify`.
- **Work from the worktree** `C:/Claude/Audiobook-Generator-wt-1028`, branch `docs/docs-srv-1028-localized-tag-detection` (already created, `node_modules` junctioned). Run server tests with `cd server && npx vitest run <path>`.

---

### Task 1: `tag-grammar.ts` — the per-language grammar table + regex builders

Pure, dependency-free, fully unit-testable. No behaviour change to any consumer yet.

**Files:**
- Create: `server/src/analyzer/tag-grammar.ts`
- Test: `server/src/analyzer/tag-grammar.test.ts`

**Interfaces:**
- Consumes: `DIALOGUE_VERBS` from `./dialogue-verbs.js`; `normaliseBookLanguage` from `../tts/language.js`.
- Produces:
  - `interface TagGrammar { verbs: readonly string[]; order: 'name-verb' | 'verb-name'; nameCapture: string; flipStrategy: 'preceding' | 'adjacent'; stopwords?: readonly string[]; }`
  - `grammarFor(language: string): TagGrammar | null`
  - `tagRegexFor(g: TagGrammar): RegExp` — one capturing group = the speaker name; no `g` flag; `u` flag only for `verb-name`.
  - `verbBeatRegexFor(g: TagGrammar): RegExp` — verb-on-a-beat, name NOT required (used by the flip to detect a neighbour that is itself a tag, incl. pronoun tags); no `g` flag.
  - `isQuoteBearing(text: string): boolean`

- [ ] **Step 1: Write the failing test** — create `server/src/analyzer/tag-grammar.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { grammarFor, tagRegexFor, verbBeatRegexFor, isQuoteBearing } from './tag-grammar.js';
import { DIALOGUE_VERBS } from './dialogue-verbs.js';

describe('grammarFor', () => {
  it('maps en/es/ru and normalises region subtags', () => {
    expect(grammarFor('en')?.order).toBe('name-verb');
    expect(grammarFor('es-ES')?.order).toBe('verb-name');
    expect(grammarFor('ru-RU')?.flipStrategy).toBe('adjacent');
  });
  it('returns null for unmapped languages (still gated) and empty input', () => {
    expect(grammarFor('de')).toBeNull();
    expect(grammarFor('fr')).toBeNull();
    expect(grammarFor('')).toBe(grammarFor('en')); // '' normalises to en
  });
});

describe('tagRegexFor — English is byte-identical to the historical regex', () => {
  it('reproduces makeTagRegex source with no u/g flag', () => {
    const re = tagRegexFor(grammarFor('en')!);
    expect(re.source).toBe(`\\b([A-Z][A-Za-z’'-]+)\\s+(?:${DIALOGUE_VERBS.join('|')})\\b`);
    expect(re.flags).toBe('');
  });
  it('captures the name before the verb', () => {
    expect(tagRegexFor(grammarFor('en')!).exec('Behnam noted.')?.[1]).toBe('Behnam');
  });
});

describe('tagRegexFor — Spanish (verb-name)', () => {
  const re = () => tagRegexFor(grammarFor('es')!);
  it('uses the u flag', () => expect(re().flags).toBe('u'));
  it('captures the name after the verb on a quote beat', () => {
    expect(re().exec('«Está bien», dijo Berrin.')?.[1]).toBe('Berrin');
  });
  it('skips a lowercase role noun between verb and name', () => {
    expect(re().exec('—dijo el viejo Berrin.')?.[1]).toBe('Berrin');
  });
  it('does NOT match a polysemous verb mid-narration (no bare-whitespace anchor)', () => {
    expect(re().exec('Coalfall llamó a la puerta.')).toBeNull();
  });
  it('does NOT capture a pronoun', () => {
    expect(re().exec('—dijo él.')).toBeNull();
  });
});

describe('tagRegexFor — Russian (verb-name)', () => {
  const re = () => tagRegexFor(grammarFor('ru')!);
  it('captures the name after a gendered verb', () => {
    expect(re().exec('«…», — сказала Рен.')?.[1]).toBe('Рен');
  });
  it('skips a lowercase role noun (— сказал мастер Одуван)', () => {
    expect(re().exec('— сказал мастер Одуван, не поднимая глаз.')?.[1]).toBe('Одуван');
  });
  it('matches an interrupted-quote inline tag', () => {
    expect(re().exec('«Если я залью огонь, — сказал Одуван, — то потеряю сварку».')?.[1]).toBe('Одуван');
  });
  it('does NOT capture a pronoun or a lowercase common noun', () => {
    expect(re().exec('— сказал он.')).toBeNull();
    expect(re().exec('— сказал дракон.')).toBeNull();
  });
});

describe('verbBeatRegexFor', () => {
  it('detects a pronoun-tagged beat (no name) for the flip disqualifier', () => {
    expect(verbBeatRegexFor(grammarFor('ru')!).test('— добавил он.')).toBe(true);
  });
  it('is false for a bare quote fragment', () => {
    expect(verbBeatRegexFor(grammarFor('ru')!).test('«Если я залью огонь,')).toBe(false);
  });
});

describe('isQuoteBearing', () => {
  it('is true for guillemets and a leading em-dash, false for plain narration', () => {
    expect(isQuoteBearing('«Если я залью огонь,')).toBe(true);
    expect(isQuoteBearing('—Está bien')).toBe(true);
    expect(isQuoteBearing('то потеряю сварку».')).toBe(true);
    expect(isQuoteBearing('La viuda asesoró sin piedad.')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/analyzer/tag-grammar.test.ts`
Expected: FAIL — `Cannot find module './tag-grammar.js'`.

- [ ] **Step 3: Implement `tag-grammar.ts`** — create `server/src/analyzer/tag-grammar.ts`:

```typescript
/* Per-language dialogue-tag grammar (fs-41/fs-50 §4.3 localisation, #1028).
   Single source of truth for how a language tags a quote's speaker, feeding the
   tag detection in recover-tagged-lines.ts. English reproduces the historical
   makeTagRegex exactly; es/ru add verb-before-name order + Unicode names; any
   other language has no row and stays gated (caller returns the no-op). */

import { DIALOGUE_VERBS } from './dialogue-verbs.js';
import { normaliseBookLanguage } from '../tts/language.js';

export interface TagGrammar {
  /** Localized dialogue verbs. All gendered/inflected surface forms listed
      explicitly (not stemmed): RU 'сказал' AND 'сказала'. Inclusion-biased. */
  verbs: readonly string[];
  /** Word order of the tag relative to the name. Also selects the regex flag
      set: 'name-verb' is ASCII (no `u`), 'verb-name' uses `u` for \p{Lu}/\p{L}. */
  order: 'name-verb' | 'verb-name';
  /** Regex source (no flags) capturing one capitalized name token. */
  nameCapture: string;
  /** Flip target: 'preceding' (en, the prior sentence) or 'adjacent' (es/ru,
      guarded neighbours — see recover-tagged-lines.ts). */
  flipStrategy: 'preceding' | 'adjacent';
  /** Pronouns/articles that look like a name in verb-name order but aren't. */
  stopwords?: readonly string[];
}

// Curated, inclusion-biased (a missing verb silently drops a real speaker; an
// over-broad one is filtered by the roster-resolution gate). Extend by adding here.
const ES_VERBS = [
  'dijo', 'preguntó', 'respondió', 'contestó', 'añadió', 'gritó', 'murmuró',
  'susurró', 'exclamó', 'replicó', 'repitió', 'insistió', 'continuó', 'pidió',
  'ordenó', 'suspiró',
] as const;
const RU_VERBS = [
  'сказал', 'сказала', 'спросил', 'спросила', 'ответил', 'ответила',
  'отозвался', 'отозвалась', 'проговорил', 'проговорила', 'пробормотал',
  'пробормотала', 'воскликнул', 'воскликнула', 'прошептал', 'прошептала',
  'продолжил', 'продолжила', 'добавил', 'добавила', 'крикнул', 'крикнула',
] as const;
const ES_STOPWORDS = [
  'él', 'ella', 'ellos', 'ellas', 'este', 'esta', 'eso', 'que', 'quien', 'aquí', 'allí',
] as const;
const RU_STOPWORDS = [
  'он', 'она', 'оно', 'они', 'это', 'тот', 'та', 'кто', 'что', 'там', 'тут', 'так', 'вот',
] as const;

// English name token — IDENTICAL to the historical makeTagRegex character class.
const EN_NAME = "[A-Z][A-Za-z’'-]+";
// Unicode name token (es/ru): a capital letter + letters/apostrophes/hyphens.
const UNI_NAME = "\\p{Lu}[\\p{L}’'-]+";

const TAG_GRAMMARS: Record<string, TagGrammar> = {
  en: { verbs: DIALOGUE_VERBS, order: 'name-verb', nameCapture: EN_NAME, flipStrategy: 'preceding' },
  es: { verbs: ES_VERBS, order: 'verb-name', nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, order: 'verb-name', nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: RU_STOPWORDS },
};

/** Grammar row for a book language, or null when unmapped (caller stays gated). */
export function grammarFor(language: string): TagGrammar | null {
  return TAG_GRAMMARS[normaliseBookLanguage(language)] ?? null;
}

// A dialogue "beat" the verb anchors to in verb-name order: start-of-string or a
// quote-close / em-dash / en-dash / hyphen / comma / colon. NO bare-whitespace
// alternative (else a narrative polysemous verb false-matches — spec C).
const VERB_BEAT = '(?:^|[—–\\-«»"“”,:]\\s*)';

/** Full tag regex: one capture group = the speaker name. No `g` flag. */
export function tagRegexFor(g: TagGrammar): RegExp {
  const verbs = g.verbs.join('|');
  if (g.order === 'name-verb') {
    // Byte-identical to the historical makeTagRegex (no `u`, no `g`).
    return new RegExp(`\\b(${g.nameCapture})\\s+(?:${verbs})\\b`);
  }
  // verb-name: beat + verb + up to two lowercase role tokens + the name.
  return new RegExp(`${VERB_BEAT}(?:${verbs})\\s+(?:\\p{Ll}[\\p{L}’'-]*\\s+){0,2}(${g.nameCapture})`, 'u');
}

/** "This text carries a dialogue verb on a beat" — name NOT required. Used to
    disqualify a flip neighbour that is itself a tag (resolvable OR pronoun). */
export function verbBeatRegexFor(g: TagGrammar): RegExp {
  const verbs = g.verbs.join('|');
  if (g.order === 'name-verb') return new RegExp(`\\b(?:${verbs})\\b`);
  return new RegExp(`${VERB_BEAT}(?:${verbs})\\b`, 'u');
}

const QUOTE_GLYPHS = /[«»“”"]|^\s*[—–]/u;
/** True if the sentence looks like (part of) a quote: a guillemet/curly/straight
    quote glyph, or a leading em/en-dash (ES/RU dialogue opener). */
export function isQuoteBearing(text: string): boolean {
  return QUOTE_GLYPHS.test(text);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/analyzer/tag-grammar.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/tag-grammar.ts server/src/analyzer/tag-grammar.test.ts
git commit -m "feat(server): per-language dialogue-tag grammar table (es/ru, #1028)"
```

---

### Task 2: Localize `taggedSpeakerIds` (keep-protection) — closes #1028

This is the bug fix. It is segmentation-agnostic and safe to merge on green tests.

**Files:**
- Modify: `server/src/analyzer/recover-tagged-lines.ts` (`buildNameToId`, `resolveNameToId`, `taggedSpeakerIds`; add `stopwordsFor`; remove the `isNonEnglish` import once Task 4 also lands — for now it is still used by `recoverTaggedNarratorLines`, so leave it)
- Test: `server/src/analyzer/recover-tagged-lines.test.ts` (extend), `server/src/analyzer/fold-minor-cast.test.ts` (extend)

**Interfaces:**
- Consumes: `grammarFor`, `tagRegexFor` from `./tag-grammar.js`.
- Produces: `taggedSpeakerIds(sentences, roster, language = 'en'): Set<string>` — unchanged signature; now returns es/ru ids.

- [ ] **Step 1: Write the failing tests** — append to `server/src/analyzer/recover-tagged-lines.test.ts`:

```typescript
describe('taggedSpeakerIds — localized (es/ru, #1028)', () => {
  const esRoster = [{ id: 'berrin', name: 'Berrin Weir' }, { id: 'brann', name: 'Brann Weir' }];
  const ruRoster = [{ id: 'oduvan', name: 'Одуван' }, { id: 'wren', name: 'Рен' }];

  it('resolves a Spanish verb-before-name tag', () => {
    const ids = taggedSpeakerIds([s(1, 1, 'narrator', '«Está bien», dijo Berrin.')], esRoster, 'es');
    expect([...ids]).toEqual(['berrin']);
  });
  it('resolves a Russian verb-before-name tag (gendered + role noun)', () => {
    const ids = taggedSpeakerIds(
      [s(1, 1, 'narrator', '«Оставь, — сказал мастер Одуван, не поднимая глаз».')],
      ruRoster, 'ru',
    );
    expect([...ids]).toEqual(['oduvan']);
  });
  it('still returns ∅ for an unmapped non-English language (de stays gated)', () => {
    expect(taggedSpeakerIds([s(1, 1, 'narrator', 'dijo Berrin.')], esRoster, 'de').size).toBe(0);
  });
});
```

Append to `server/src/analyzer/fold-minor-cast.test.ts` (the direct #1028 regression — a 0-line Spanish speaker the prose tags must be KEPT, not dropped):

```typescript
describe('foldMinorCast — keeps a prose-tagged Spanish minor speaker (#1028)', () => {
  it('does not drop a 0-line speaker whose quote the prose tags (es)', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('berrin', { name: 'Berrin', gender: 'male' }), // 0 attributed lines
    ];
    const sentences = makeSentences([
      [1, 'narrator'], [1, 'wren'], [1, 'wren'], [2, 'wren'],
    ]);
    // A narrator-attributed sentence whose TEXT tags Berrin (stage-2 stranded the quote).
    sentences.push({ id: sentences.length + 1, chapterId: 1, characterId: 'narrator', text: '«Está bien», dijo Berrin.' });

    const result = foldMinorCast(chars, sentences, { minLines: 3, language: 'es' });

    expect(result.characters.find((c) => c.id === 'berrin')).toBeDefined(); // kept
    expect(result.dropped).not.toContain('Berrin');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/analyzer/recover-tagged-lines.test.ts src/analyzer/fold-minor-cast.test.ts`
Expected: FAIL — `taggedSpeakerIds(..., 'es')` returns ∅ today (gated), so the es/ru ids are empty and Berrin is dropped.

- [ ] **Step 3: Implement the localization** — in `server/src/analyzer/recover-tagged-lines.ts`:

(a) Replace the import line `import { isNonEnglish } from '../tts/language.js';` with:

```typescript
import { grammarFor, tagRegexFor, verbBeatRegexFor, isQuoteBearing } from './tag-grammar.js';
```

(`verbBeatRegexFor`/`isQuoteBearing` are used by Task 4; importing them now is harmless. `isNonEnglish` is no longer used after Task 4 replaces the flip gate — but `recoverTaggedNarratorLines` still references it until then, so KEEP a second import line `import { isNonEnglish } from '../tts/language.js';` for now and delete it in Task 4.)

(b) Add a per-call stopword union helper (no mutation of the module set) near `STOPWORDS`:

```typescript
/** Module STOPWORDS unioned with a grammar's language stopwords. Returns the
    shared set unchanged when there are no extras (English path stays identical). */
function stopwordsFor(extra?: readonly string[]): Set<string> {
  return extra && extra.length ? new Set([...STOPWORDS, ...extra]) : STOPWORDS;
}
```

(c) Thread the stopword set through the two helpers. Change `buildNameToId(roster: RosterChar[])` to `buildNameToId(roster: RosterChar[], stop: Set<string> = STOPWORDS)` and replace its internal `STOPWORDS.has(tok)` with `stop.has(tok)`. Change `resolveNameToId(rawName, nameToId)` to `resolveNameToId(rawName: string, nameToId: Map<string, string | null>, stop: Set<string> = STOPWORDS)` and replace `if (STOPWORDS.has(key)) return null;` with `if (stop.has(key)) return null;`.

(d) Replace the body of `taggedSpeakerIds`:

```typescript
export function taggedSpeakerIds(
  sentences: Sentence[],
  roster: RosterChar[],
  language: string = 'en',
): Set<string> {
  const g = grammarFor(language);
  if (!g) return new Set<string>(); // unmapped language → stay gated
  const stop = stopwordsFor(g.stopwords);
  const nameToId = buildNameToId(roster, stop);
  const tagRe = tagRegexFor(g);
  const ids = new Set<string>();
  for (const s of sentences) {
    const m = tagRe.exec(s.text);
    if (!m) continue;
    const id = resolveNameToId(m[1], nameToId, stop);
    if (id) ids.add(id);
  }
  return ids;
}
```

(`makeTagRegex` is now unused — delete it. `recoverTaggedNarratorLines` is updated in Task 4; for now point its existing `makeTagRegex()` call at `tagRegexFor(grammarFor('en')!)` so the file compiles AND English behaviour is unchanged.)

- [ ] **Step 4: Run to verify pass — localized cases + the full English suites**

Run: `cd server && npx vitest run src/analyzer/recover-tagged-lines.test.ts src/analyzer/fold-minor-cast.test.ts`
Expected: PASS — es/ru keep + Berrin kept, AND every pre-existing English/RU-fold assertion unchanged.

- [ ] **Step 5: Typecheck**

Run: `cd server && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/recover-tagged-lines.ts server/src/analyzer/recover-tagged-lines.test.ts server/src/analyzer/fold-minor-cast.test.ts
git commit -m "fix(server): localize the minor-cast keep-protection for es/ru (#1028)"
```

> **#1028 is now closed by Tasks 1–2.** This is a valid merge point: open the PR with `Closes #1028`, run `npm run verify` (Task 6 below), and ship. Tasks 3–5 add the flip as a follow-up.

---

### Task 3: Empirical segmentation check (on-box) — informs the flip fixtures

Investigation, not code. Resolves the spec's open question: does stage-2 keep an inline `quote + tag + narration` sentence whole, or split the quote from the tag? The answer confirms the `'adjacent'` flip fixtures in Task 4.

**Files:**
- Create: `docs/superpowers/notes/2026-06-23-1028-es-ru-segmentation.md` (a short recorded observation)

- [ ] **Step 1: Run stage-2 over ES + RU dialogue prose.** With a box that has the analyzer available (`ANALYZER=gemini` + `GEMINI_API_KEY`, or local Ollama), analyse `samples/the-coalfall-commission/manuscript.es.md` (chapter 1) and `server/src/__fixtures__/the-coalfall-commission.ru.md`. Easiest path: `cd server && npm run dev`, POST the manuscript through the analysis route the app uses, OR reuse the attribution-eval harness (`scripts/tests/eval-attribution.test.mjs`, which already drives ES Coalfall) and dump the stage-2 `sentences` array.

- [ ] **Step 2: Record the observation** in the notes file: for `«Está bien», dijo Berrin` (es) and `«…», — сказала Рен` / the interrupted `«Если я залью огонь, — сказал Одуван, — …»` (ru), capture (a) whether the quote and tag are one sentence or split, (b) which fragment(s) carry `characterId: narrator`. Confirm: the `'adjacent'` flip's preceding/following guards match the observed shape. If the model keeps inline quote+tag whole and attributes it correctly, note that the flip rarely fires and Task 2's keep-protection carries the fix.

- [ ] **Step 3: Commit the note**

```bash
git add docs/superpowers/notes/2026-06-23-1028-es-ru-segmentation.md
git commit -m "docs(server): record es/ru stage-2 segmentation for the #1028 flip"
```

> If no analyzer box is available, build Task 4's fixtures from the documented expected segmentation (split quote/tag, quote on narrator) and mark on-box confirmation as owed in the Task 5 ship notes. Do NOT block Task 2's merge on this.

---

### Task 4: Localize `recoverTaggedNarratorLines` (the flip) — preceding + guarded adjacent

**Files:**
- Modify: `server/src/analyzer/recover-tagged-lines.ts` (`recoverTaggedNarratorLines`; remove the now-orphaned `isNonEnglish` import)
- Test: `server/src/analyzer/recover-tagged-lines.test.ts` (extend)

**Interfaces:**
- Consumes: `grammarFor`, `tagRegexFor`, `verbBeatRegexFor`, `isQuoteBearing` from `./tag-grammar.js` (imported in Task 2).
- Produces: `recoverTaggedNarratorLines(sentences, roster, language = 'en'): { sentences, flipped, byId }` — unchanged signature; now flips es/ru.

- [ ] **Step 1: Write the failing tests** — append to `server/src/analyzer/recover-tagged-lines.test.ts`:

```typescript
describe('recoverTaggedNarratorLines — localized adjacency (es/ru)', () => {
  const ruRoster = [{ id: 'oduvan', name: 'Одуван' }, { id: 'wren', name: 'Рен' }];

  it('flips a stranded preceding quote onto the speaker (ru «…», — сказала Рен)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Я никогда не вздыхаю»,'),
      s(2, 1, 'narrator', '— сказала Рен.'),
    ];
    const out = recoverTaggedNarratorLines(sentences, ruRoster, 'ru');
    expect(out.sentences[0].characterId).toBe('wren');
    expect(out.flipped).toBe(1);
  });

  it('flips BOTH sides of an interrupted quote (preceding + following)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Если я залью огонь,'),
      s(2, 1, 'narrator', '— сказал Одуван, —'),
      s(3, 1, 'narrator', 'то потеряю сварку».'),
    ];
    const out = recoverTaggedNarratorLines(sentences, ruRoster, 'ru');
    expect(out.sentences[0].characterId).toBe('oduvan');
    expect(out.sentences[2].characterId).toBe('oduvan');
    expect(out.flipped).toBe(2);
  });

  it('does NOT steal the next speaker\'s quote in a rapid exchange (R23)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Первый».'),
      s(2, 1, 'narrator', '— сказал Одуван.'),
      s(3, 1, 'narrator', '«Второй».'),     // belongs to Рен — its own tag is next
      s(4, 1, 'narrator', '— сказала Рен.'),
    ];
    const out = recoverTaggedNarratorLines(sentences, ruRoster, 'ru');
    expect(out.sentences[0].characterId).toBe('oduvan'); // preceding of S2 → Одуван
    expect(out.sentences[2].characterId).toBe('wren');   // NOT stolen by Одуван; flipped by S4
  });

  it('does NOT flip an inline quote+tag+narration sentence (no re-voiced narration)', () => {
    const sentences = [
      s(1, 1, 'narrator', '«Está bien», dijo Berrin, plano como un estante.'),
    ];
    const esRoster = [{ id: 'berrin', name: 'Berrin' }];
    const out = recoverTaggedNarratorLines(sentences, esRoster, 'es');
    expect(out.sentences[0].characterId).toBe('narrator'); // S itself never flips
    expect(out.flipped).toBe(0);
  });

  it('stays a no-op for an unmapped language (de)', () => {
    const sentences = [s(1, 1, 'narrator', '«…»,'), s(2, 1, 'narrator', '— сказала Рен.')];
    expect(recoverTaggedNarratorLines(sentences, ruRoster, 'de').flipped).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/analyzer/recover-tagged-lines.test.ts`
Expected: FAIL — `recoverTaggedNarratorLines(..., 'ru')` is the English-`tagRegexFor` no-match path today (Russian prose doesn't match English verbs) so nothing flips.

- [ ] **Step 3: Implement the strategy branch** — replace the body of `recoverTaggedNarratorLines` in `server/src/analyzer/recover-tagged-lines.ts`:

```typescript
export function recoverTaggedNarratorLines<T extends Sentence>(
  sentences: T[],
  roster: RosterChar[],
  language: string = 'en',
): { sentences: T[]; flipped: number; byId: Map<string, number> } {
  const g = grammarFor(language);
  if (!g) return { sentences, flipped: 0, byId: new Map() }; // unmapped → no-op
  const stop = stopwordsFor(g.stopwords);
  const nameToId = buildNameToId(roster, stop);
  const tagRe = tagRegexFor(g);
  const out = sentences.map((s) => ({ ...s }));
  const byId = new Map<string, number>();
  let flipped = 0;

  const flipQ = (q: T, id: string) => {
    if (q.characterId !== NARRATOR_ID || q.characterId === id) return;
    q.characterId = id;
    byId.set(id, (byId.get(id) ?? 0) + 1);
    flipped += 1;
  };

  if (g.flipStrategy === 'preceding') {
    // English — UNCHANGED behaviour: the tag is its own beat; flip the prior sentence.
    for (let i = 1; i < out.length; i++) {
      const m = tagRe.exec(out[i].text);
      if (!m) continue;
      const id = resolveNameToId(m[1], nameToId, stop);
      if (!id) continue;
      const prev = out[i - 1];
      if (prev.chapterId !== out[i].chapterId) continue;
      flipQ(prev, id);
    }
    return { sentences: out, flipped, byId };
  }

  // 'adjacent' (es/ru) — preceding-first; following only under the interrupted
  // signature (S+1 not itself immediately followed by its own tag). Never flip S.
  const verbBeat = verbBeatRegexFor(g);
  const qualifies = (q: T | undefined, chapterId: number): boolean =>
    !!q &&
    q.chapterId === chapterId &&
    q.characterId === NARRATOR_ID &&
    isQuoteBearing(q.text) &&
    !verbBeat.test(q.text); // a neighbour that is itself a tag is never stolen

  for (let i = 0; i < out.length; i++) {
    const m = tagRe.exec(out[i].text);
    if (!m) continue;
    const id = resolveNameToId(m[1], nameToId, stop);
    if (!id) continue;
    const chapterId = out[i].chapterId;
    const prev = out[i - 1];
    const next = out[i + 1];
    if (qualifies(prev, chapterId)) flipQ(prev, id);
    if (qualifies(next, chapterId)) {
      const after = out[i + 2];
      const afterIsTag = !!after && after.chapterId === chapterId && verbBeat.test(after.text);
      if (!afterIsTag) flipQ(next, id);
    }
  }
  return { sentences: out, flipped, byId };
}
```

(b) Now remove the orphaned `import { isNonEnglish } from '../tts/language.js';` line (no longer referenced) and revert Task 2's temporary `tagRegexFor(grammarFor('en')!)` shim — `recoverTaggedNarratorLines` no longer uses a standalone English regex.

- [ ] **Step 4: Run to verify pass — flip + the full suite**

Run: `cd server && npx vitest run src/analyzer/recover-tagged-lines.test.ts src/analyzer/fold-minor-cast.test.ts`
Expected: PASS — es/ru flips + R23 exchange + inline-not-flipped + de no-op, AND every existing English assertion (`Behnam`/`Wren`/ambiguous/chapter-boundary) unchanged.

- [ ] **Step 5: Typecheck + the broader analyzer suite**

Run: `cd server && npm run typecheck && npx vitest run src/analyzer`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/recover-tagged-lines.ts server/src/analyzer/recover-tagged-lines.test.ts
git commit -m "feat(server): localize narrator-flip recovery for es/ru (guarded adjacency, #1028)"
```

---

### Task 5: Release gate — Spanish re-acceptance, follow-up issues, plan status

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-localized-minor-cast-tag-detection-design.md` (`status:` + Ship notes)
- Modify: `docs/features/INDEX.md` (if the spec graduates to a plan entry per the repo convention)

- [ ] **Step 1: Run the full local battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build).

- [ ] **Step 2: Spanish-canary re-acceptance (BLOCKING for the flip — spec R7).** Re-render the Spanish Coalfall canary (`samples/the-coalfall-commission/manuscript.es.md`) on-box and confirm: (a) Berrin/Ivo keep their own voices (not folded into `unknown-male`); (b) no previously-correct line regressed to the wrong speaker. Record the render SHA + date.

- [ ] **Step 3: File the two scope-boundary follow-ups** (spec "Scope boundaries"), each a Backlog-item GitHub issue + a thin `docs/BACKLOG.md` row:
  - **F1** — `isDescriptorName` has no Spanish branch (ES background descriptors `el viejo`/`la mujer` don't fold into buckets).
  - **F2** — localize the roster-coverage guard (seam-3d Task 1) for es/ru so a stage-1-dropped speaker can be re-added (today recover/keep is rostered-only).

- [ ] **Step 4: Update the spec `status:` → `stable`, fill Ship notes** (shipped date, the keep-protection commit SHA, the flip commit SHA, the Spanish re-acceptance SHA). Per the repo "Before-shipping checklist", `git mv` the spec under `docs/features/archive/` only when fully shipped; otherwise leave it and update `docs/features/INDEX.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-localized-minor-cast-tag-detection-design.md docs/features/INDEX.md docs/BACKLOG.md
git commit -m "docs(server): ship notes + follow-ups for #1028 localized tag detection"
```

---

## Self-Review

**Spec coverage:**
- Per-language grammar table (`verbs`/`order`/`nameCapture`/`flipStrategy`/`stopwords`) → Task 1. ✓
- `en` byte-identical (no `u`, no `g`); `DIALOGUE_VERBS`/`.mjs` untouched → Task 1 (regex-source assertion) + Global Constraints. ✓
- verb-name anchor (no bare `\s`) + role-noun skip (spec B/C) → Task 1 regex + tests. ✓
- Keep-protection localization (the #1028 fix) → Task 2 + the fold regression test. ✓
- Per-call stopword union, no mutation → Task 2 `stopwordsFor`. ✓
- Flip: `preceding` unchanged for en; guarded `adjacent` for es/ru with R23 following-guard + inline-not-flipped + interrupted bidirectional → Task 4 + tests. ✓
- Unmapped languages stay gated → Task 1 `grammarFor` null + de no-op tests in Tasks 2 & 4. ✓
- Empirical segmentation check (spec Task 0) → Task 3. ✓
- R7 release gating (keep ships first; flip gated on segmentation + Spanish re-acceptance) → Task 2 merge note + Task 5. ✓
- Scope-boundary follow-ups F1/F2 → Task 5 Step 3. ✓
- F3 (no `g` flag) / F4 (drop `isNonEnglish` import) → Task 1 builders + Task 4 Step 3(b). ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; the only "if no box" branch (Task 3) has an explicit documented fallback. ✓

**Type consistency:** `grammarFor`/`tagRegexFor`/`verbBeatRegexFor`/`isQuoteBearing`/`stopwordsFor` signatures are identical across Tasks 1, 2, 4; `taggedSpeakerIds`/`recoverTaggedNarratorLines` keep their existing public signatures; `buildNameToId`/`resolveNameToId` gain a defaulted `stop: Set<string>` param used consistently. ✓
