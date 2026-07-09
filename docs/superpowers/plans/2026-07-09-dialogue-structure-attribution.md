# Dialogue-Structure Attribution Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic dialogue-structure engine that corrects/flags stage-2 speaker attributions and replaces model-self-reported confidence with derived confidence, plus a default-on local escalation pass and script-review evidence injection.

**Spec:** `docs/superpowers/specs/2026-07-09-dialogue-structure-attribution-design.md` — READ IT FIRST. Decision authority: where this plan and the spec disagree, the spec wins.

**Architecture:** Three pure units under `server/src/analyzer/dialogue-structure/` (structure parser ①, sentence↔evidence aligner, cross-examiner ②) wired into `attributeChapterStage2` (replacing the `applyNarratorDefault` call), plus a model-calling escalation unit ③ and a read-only evidence annotation in the script-review inbox. All confidence values are derived in code; the model's numbers are discarded.

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import suffixes), Vitest (server config), Zod schemas already exist in `server/src/handoff/schemas.ts`. No new dependencies.

## Global Constraints

- **Language must never be hardcoded in pipeline logic** — all language behaviour lives in convention tables under `dialogue-structure/lang/`. Supported: en, ru, es, fr, de; anything else → empty table → byte-identical current behaviour.
- **Demote/correct rules:** `tag-name` evidence outranks everything (never overridden by model, alternation, or escalation). The engine never guesses: ambiguous structure → `unanchored` → flag, not correct.
- **Sentence schema unchanged.** Corrections mutate `characterId`/`confidence` only. `SentenceOutput` from `server/src/handoff/schemas.ts` is the shape everywhere.
- **Derived confidence bands (spec §5.3)** — the ordering is invariant; exact values live in ONE constants block (`cross-examine.ts`) so tuning is a one-line diff. Flag threshold used by the UI is `< 0.75` (do not change the UI).
- **Registry knobs**: every new knob follows the existing `ConfigKnob` shape in `server/src/config/registry.ts` (key/env/group/label/help/type/default/apply/risk) AND gets a row in the wiki's Advanced-Settings page in the delivering PR.
- **Commit convention:** `<type>(<scope>): <subject>` — scope `server` for all code tasks here, `docs` for docs. Branch: `feat/server-dialogue-structure-attribution` off latest `main`. Fresh `git commit` every time — NEVER `--amend` (a prior SDD run squashed two tasks that way).
- **Worktree:** implement in an isolated worktree off `origin/main` (`superpowers:using-git-worktrees`); run `npm install` in it so husky hooks fire; junction `node_modules` if the main checkout is busy (see memory/CONTRIBUTING).
- **Concurrency guard:** a concurrent thread ("Script Review — persist findings", spec
  `2026-07-09-script-review-persistence-design.md`) rewrites the `script-review.ts` route layer and
  may touch `config/registry.ts`. **Before starting Task 10 (and before adding the registry knobs in
  Task 8), check whether that work has merged; if it has, rebase onto latest `main` first.** If it
  is still unmerged when you reach Task 10, pause and coordinate — do not race it on the same file.
- **Tests:** server Vitest — `cd server && npx vitest run src/analyzer/dialogue-structure/<file>.test.ts`. Full battery before PR: `npm run verify:fast:branch` from repo root.
- **Every ru parser test states which dialogue convention it targets** (dash-dialogue vs guillemet) in its test name.

## File Structure (locked decomposition)

```
server/src/analyzer/dialogue-structure/
  types.ts                 — shared types (SpanEvidence, ParagraphEvidence, LanguageConventions, EngineReport)
  lang/ru.ts, en.ts, es.ts, fr.ts, de.ts, index.ts   — convention tables + conventionsFor(language)
  name-matcher.ts          — roster name/alias stem matching (RU case-stripping)
  parser.ts                — ① paragraph classification + span segmentation + tag speaker extraction
  windows.ts               — conversation windows, participants, alternation, pronoun resolution
  aligner.ts               — sentence↔span two-pointer alignment + normalization + alignment-rate
  cross-examine.ts         — ② decision matrix, derived confidence, corrections + flags + report
  escalation.ts            — ③ window selection, focused re-query, acceptance rules, budgets
server/src/analyzer/narrator-default.ts  — absorbed: forwarding shim (kept so old imports/tests compile)
server/src/routes/analysis.ts            — wiring at attributeChapterStage2 + provenance + budget accumulator
server/src/routes/script-review.ts       — inbox evidence annotation
skills/audiobook-script-review.md        — attribution-audit section
server/src/config/registry.ts            — knobs: analyzer.structure.enabled, analyzer.structure.escalation,
                                            analyzer.structure.maxWindowsPerChapter, analyzer.structure.maxWindowsPerBook
server/src/__fixtures__/the-coalfall-commission.ru-dash.md  — NEW dash-dialogue ru fixture (Castwright-owned)
docs/features/247-dialogue-structure-attribution.md          — regression plan (from TEMPLATE.md)
```

---

### Task 1: Types + language convention tables

**Files:**
- Create: `server/src/analyzer/dialogue-structure/types.ts`
- Create: `server/src/analyzer/dialogue-structure/lang/ru.ts`, `lang/en.ts`, `lang/es.ts`, `lang/fr.ts`, `lang/de.ts`, `lang/index.ts`
- Test: `server/src/analyzer/dialogue-structure/lang/index.test.ts`

**Interfaces:**
- Produces: `LanguageConventions`, `SpanEvidence`, `ParagraphEvidence`, `EngineReport`, `EvidenceSource` (types.ts); `conventionsFor(language: string | undefined): LanguageConventions | null` (lang/index.ts). Every later task imports these.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/dialogue-structure/lang/index.test.ts
import { describe, expect, it } from 'vitest';
import { conventionsFor } from './index.js';

describe('conventionsFor', () => {
  it('returns a populated table for each supported language', () => {
    for (const lang of ['ru', 'en', 'es', 'fr', 'de']) {
      const c = conventionsFor(lang);
      expect(c, lang).not.toBeNull();
      expect(c!.speechVerbStems.length, lang).toBeGreaterThan(10);
    }
  });
  it('returns null for unsupported/absent language (engine no-op path)', () => {
    expect(conventionsFor('ja')).toBeNull();
    expect(conventionsFor(undefined)).toBeNull();
  });
  it('ru stemmer strips case endings so Антона/Антону/Антоном share a stem', () => {
    const ru = conventionsFor('ru')!;
    const stems = new Set(['Антона', 'Антону', 'Антоном', 'Антоне', 'Антон'].map((t) => ru.nameStemmer(t.toLowerCase())));
    expect(stems.size).toBe(1);
  });
  it('en stemmer strips possessive only', () => {
    const en = conventionsFor('en')!;
    expect(en.nameStemmer("halloran's")).toBe('halloran');
    expect(en.nameStemmer('halloran')).toBe('halloran');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd server && npx vitest run src/analyzer/dialogue-structure/lang/index.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement types + tables**

```ts
// server/src/analyzer/dialogue-structure/types.ts
export type EvidenceSource = 'tag-name' | 'tag-pronoun' | 'alternation' | 'unanchored';

export interface SpanEvidence {
  kind: 'speech' | 'tag' | 'narration';
  /** absolute offsets into the chapter body */
  start: number;
  end: number;
  /** set on speech spans only */
  speaker?: { characterId: string; source: EvidenceSource };
  windowId?: number;
  turnIndex?: number;
}

export interface ParagraphEvidence {
  start: number;
  end: number;
  kind: 'dialogue' | 'narration';
  spans: SpanEvidence[];
}

export interface LanguageConventions {
  language: string;
  /** paragraph-start markers that open a dialogue paragraph (null = quote-only language) */
  dialogueOpen: RegExp | null;
  /** ordered open/close quote pairs for embedded speech */
  quotePairs: Array<[string, string]>;
  /** lowercase stems: a tag clause must contain one to count as a tag */
  speechVerbStems: string[];
  /** action-beat stems that also anchor a speaker ("— Да, — кивнул Антон") */
  beatVerbStems: string[];
  nameStemmer: (lowerToken: string) => string;
  minStemLength: number;
  pronouns: { firstPerson: RegExp | null; male: RegExp | null; female: RegExp | null };
}

export interface EngineReport {
  language: string | null;
  alignedPct: number;
  confirmed: number;
  corrected: number;
  flagged: number;
  lumped: number;
  escalated: number;
  escalationAccepted: number;
  /** true when alignment fell below the floor and correction was disabled */
  flagOnly: boolean;
}
```

```ts
// server/src/analyzer/dialogue-structure/lang/ru.ts
import type { LanguageConventions } from '../types.js';

/* Russian dash-dialogue: „— speech, — tag. — speech." Case endings are stripped
   so roster names match their inflected forms. Verb stems are lowercase prefixes. */
const CASE_ENDINGS = /(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ам|ям|ой|ей|ом|ем|ов|ев|ы|и|у|ю|а|я|е|о|ь)$/u;

export const ru: LanguageConventions = {
  language: 'ru',
  dialogueOpen: /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu,
  quotePairs: [['«', '»'], ['„', '“'], ['“', '”'], ['"', '"']],
  speechVerbStems: [
    'сказа', 'говор', 'ответ', 'спрос', 'переспрос', 'прошепта', 'шепн', 'шепта', 'крикн', 'крича',
    'воскликн', 'произнес', 'произнос', 'поинтерес', 'пробормота', 'бормота', 'буркн', 'отрез',
    'замети', 'добави', 'продолжи', 'протян', 'оборва', 'согласи', 'возрази', 'предложи', 'попроси',
    'прошипе', 'рявкн', 'отозва', 'откликн', 'подтверди', 'объясни', 'поясни', 'промолви', 'заяви',
    'осведоми', 'уточни', 'отмахн', 'проворча', 'ворча', 'промямли', 'выдохн', 'повтори', 'напомни',
    'поправи', 'перебил', 'вмеша', 'призна', 'усмехн', 'хмыкн', 'фыркн', 'засмея', 'смеял',
  ],
  beatVerbStems: ['кивн', 'улыбн', 'вздохн', 'нахмур', 'помолча', 'пожа', 'покача'],
  nameStemmer: (t) => t.replace(CASE_ENDINGS, ''),
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^\p{L}])я([^\p{L}]|$)/iu,
    male: /(^|[^\p{L}])он([^\p{L}]|$)/iu,
    female: /(^|[^\p{L}])она([^\p{L}]|$)/iu,
  },
};
```

```ts
// server/src/analyzer/dialogue-structure/lang/en.ts
import type { LanguageConventions } from '../types.js';

export const en: LanguageConventions = {
  language: 'en',
  dialogueOpen: null, // English opens with quotes, not paragraph dashes
  quotePairs: [['“', '”'], ['"', '"'], ['‘', '’']],
  speechVerbStems: [
    'said', 'say', 'ask', 'repli', 'whisper', 'shout', 'mutter', 'murmur', 'call', 'answer',
    'snap', 'sigh', 'groan', 'growl', 'hiss', 'yell', 'cried', 'cry', 'added', 'add', 'agree',
    'insist', 'demand', 'wonder', 'continu', 'interrupt', 'observ', 'remark', 'promis', 'warn',
  ],
  beatVerbStems: ['nod', 'smil', 'shrug', 'frown', 'laugh', 'grin'],
  nameStemmer: (t) => t.replace(/'s$/u, '').replace(/'$/u, ''),
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^a-z])i([^a-z]|$)/iu,
    male: /(^|[^a-z])he([^a-z]|$)/iu,
    female: /(^|[^a-z])she([^a-z]|$)/iu,
  },
};
```

es.ts / fr.ts / de.ts follow the identical shape; fill from the spec §5.1 table:
- **es**: `dialogueOpen: /^\s*(?:&mdash;|[-–—])\s*/iu` (raya), quotePairs `[['«','»'],['“','”']]`, verbs `dijo/pregunt/respond/susurr/grit/murmur/exclam/contest/añad/insist/coment/…` (stems), identity stemmer, pronouns yo/él/ella.
- **fr**: `dialogueOpen: /^\s*(?:&mdash;|[-–—])\s*/iu`, quotePairs `[['«','»']]`, verbs `dit/demand/répond/murmur/cri/soupir/ajout/repri/lanc/…`, identity stemmer, pronouns je/il/elle.
- **de**: `dialogueOpen: null`, quotePairs `[['„','“'],['»','«']]`, verbs `sagte/fragte/antwortete/flüsterte/rief/murmelte/erwiderte/ergänzte/…` (lowercased stems `sagt/fragt/antwortet/flüstert/rief/murmelt/erwidert`), identity stemmer, pronouns ich/er/sie.

```ts
// server/src/analyzer/dialogue-structure/lang/index.ts
import type { LanguageConventions } from '../types.js';
import { ru } from './ru.js';
import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { de } from './de.js';

const TABLES: Record<string, LanguageConventions> = { ru, en, es, fr, de };

/** Normalizes 'ru-RU' → 'ru'. Returns null when the language has no table —
    callers treat null as "engine disabled, current behaviour". */
export function conventionsFor(language: string | undefined | null): LanguageConventions | null {
  if (!language) return null;
  return TABLES[language.toLowerCase().split(/[-_]/u)[0]] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): dialogue-structure types + language convention tables"`

---

### Task 2: Name matcher

**Files:**
- Create: `server/src/analyzer/dialogue-structure/name-matcher.ts`
- Test: `server/src/analyzer/dialogue-structure/name-matcher.test.ts`

**Interfaces:**
- Consumes: `LanguageConventions` (Task 1); roster shape `{ id: string; name: string; aliases?: string[] }` (subset of stage-1 `CharacterOutput` — accept the minimal structural type, do not import the full schema).
- Produces: `buildNameIndex(roster, conventions): NameIndex` and `findRosterName(text: string, index: NameIndex): string | null` (returns characterId). `NameIndex` is opaque (`Map<string, string>` stem→id internally).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/dialogue-structure/name-matcher.test.ts
import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex, findRosterName } from './name-matcher.js';

const ru = conventionsFor('ru')!;
const roster = [
  { id: 'anton', name: 'Антон', aliases: ['я'] },
  { id: 'boris-ignatyevich', name: 'Борис Игнатьевич', aliases: ['шеф'] },
  { id: 'olga', name: 'Ольга' },
];

describe('name-matcher (ru)', () => {
  const idx = buildNameIndex(roster, ru);
  it('matches inflected case forms', () => {
    expect(findRosterName('— сказал Антону вслед', idx)).toBe('anton');
    expect(findRosterName('ответила Ольге', idx)).toBe('olga');
  });
  it('matches multi-token names and aliases by any token', () => {
    expect(findRosterName('проворчал Борис Игнатьевич', idx)).toBe('boris-ignatyevich');
    expect(findRosterName('заметил шеф', idx)).toBe('boris-ignatyevich');
  });
  it('does NOT match substrings inside unrelated words', () => {
    // "Антенна" must not hit the "Ант..." stem — token-boundary + full-stem equality only
    expect(findRosterName('антенна на крыше дрожала', idx)).toBeNull();
  });
  it('ignores stems shorter than minStemLength (the "я" alias never text-matches)', () => {
    expect(findRosterName('я не знаю', idx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement**

```ts
// server/src/analyzer/dialogue-structure/name-matcher.ts
import type { LanguageConventions } from './types.js';

export interface RosterEntry { id: string; name: string; aliases?: string[] }
export type NameIndex = { stems: Map<string, string>; conventions: LanguageConventions };

/** Index roster name+alias TOKENS by stem. Ambiguous stems (two characters
    sharing a stem) are dropped — a match must be unique to anchor. */
export function buildNameIndex(roster: RosterEntry[], conventions: LanguageConventions): NameIndex {
  const stems = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const c of roster) {
    if (c.id === 'narrator') continue;
    const tokens = [c.name, ...(c.aliases ?? [])].flatMap((n) => String(n).split(/[\s-]+/u));
    for (const tok of tokens) {
      const stem = conventions.nameStemmer(tok.toLowerCase());
      if (stem.length < conventions.minStemLength) continue;
      const prev = stems.get(stem);
      if (prev && prev !== c.id) ambiguous.add(stem);
      else stems.set(stem, c.id);
    }
  }
  for (const s of ambiguous) stems.delete(s);
  return { stems, conventions };
}

/** First unique roster match among the text's word tokens, or null. */
export function findRosterName(text: string, index: NameIndex): string | null {
  for (const tok of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (!tok) continue;
    const stem = index.conventions.nameStemmer(tok);
    if (stem.length < index.conventions.minStemLength) continue;
    const id = index.stems.get(stem);
    if (id) return id;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): roster name matcher with per-language stemming"`

---

### Task 3: Structure parser — dash-dialogue path

**Files:**
- Create: `server/src/analyzer/dialogue-structure/parser.ts`
- Test: `server/src/analyzer/dialogue-structure/parser.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `NameIndex`.
- Produces: `parseChapterStructure(body: string, index: NameIndex): ParagraphEvidence[]`. Speech spans carry `speaker` when a tag anchors them (source `tag-name`); tag/beat spans have `kind: 'tag'`; pronoun/alternation resolution is Task 5's job (parser leaves those spans `unanchored` with the tag's pronoun recorded — see `pendingPronoun` below).
- Also produces (exported for Task 5): `interface ParsedTag { pronoun?: 'first' | 'male' | 'female' }` attached as `SpanEvidence & { pendingPronoun?: 'first' | 'male' | 'female' }` on speech spans whose tag had a pronoun but no name.

- [ ] **Step 1: Write the failing tests** (each name states the convention)

```ts
// server/src/analyzer/dialogue-structure/parser.test.ts
import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';

const ru = conventionsFor('ru')!;
const idx = buildNameIndex([{ id: 'anton', name: 'Антон' }, { id: 'olga', name: 'Ольга' }], ru);
const spansOf = (paras: ReturnType<typeof parseChapterStructure>) => paras.flatMap((p) => p.spans);

describe('parser — ru dash-dialogue', () => {
  it('dash-dialogue: paragraph-leading dash opens speech; plain paragraph is narration', () => {
    const paras = parseChapterStructure('— Привет.\nОн вошёл в комнату.', idx);
    expect(paras[0].kind).toBe('dialogue');
    expect(paras[1].kind).toBe('narration');
  });
  it('dash-dialogue: ", — сказал Антон." closes speech, opens tag, anchors speaker', () => {
    const paras = parseChapterStructure('— Привет, — сказал Антон.', idx);
    const spans = spansOf(paras);
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
  });
  it('dash-dialogue: ". — Речь" after a tag resumes speech with the SAME speaker (continuation)', () => {
    const paras = parseChapterStructure('— Привет, — сказал Антон. — Как дела?', idx);
    const spans = spansOf(paras);
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag', 'speech']);
    expect(spans[2].speaker?.characterId).toBe('anton');
  });
  it('dash-dialogue: multi-sentence speech stays ONE speech span (no dash on 2nd sentence)', () => {
    const paras = parseChapterStructure('— Привет. Давно не виделись.', idx);
    expect(spansOf(paras).map((s) => s.kind)).toEqual(['speech']);
  });
  it('dash-dialogue: interior punctuation dash does NOT toggle (X — это Y)', () => {
    const paras = parseChapterStructure('— Сумрак — это не место, а состояние.', idx);
    expect(spansOf(paras).map((s) => s.kind)).toEqual(['speech']);
  });
  it('dash-dialogue: candidate tag clause with NO verb match → remainder unanchored, never split', () => {
    const paras = parseChapterStructure('— Привет, — Ольга насмешливо посмотрела в окно.', idx);
    const speech = spansOf(paras).filter((s) => s.kind === 'speech');
    expect(speech[0].speaker?.source ?? 'unanchored').toBe('unanchored');
  });
  it('dash-dialogue: beat verb also anchors ("— Да, — кивнула Ольга.")', () => {
    const paras = parseChapterStructure('— Да, — кивнула Ольга.', idx);
    expect(spansOf(paras)[0].speaker).toEqual({ characterId: 'olga', source: 'tag-name' });
  });
  it('dash-dialogue: &mdash; entity leakage treated as a dash', () => {
    const paras = parseChapterStructure('&mdash; Привет.', idx);
    expect(paras[0].kind).toBe('dialogue');
  });
  it('offsets are absolute into the body and spans tile the paragraph', () => {
    const body = 'Он вошёл.\n— Привет, — сказал Антон.';
    const paras = parseChapterStructure(body, idx);
    for (const p of paras) for (const s of p.spans) {
      expect(s.start).toBeGreaterThanOrEqual(p.start);
      expect(s.end).toBeLessThanOrEqual(p.end);
    }
    expect(body.slice(paras[1].spans[0].start, paras[1].spans[0].end)).toContain('Привет');
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement the parser core**

```ts
// server/src/analyzer/dialogue-structure/parser.ts
import type { LanguageConventions, ParagraphEvidence, SpanEvidence } from './types.js';
import type { NameIndex } from './name-matcher.js';
import { findRosterName } from './name-matcher.js';

/* Spec §5.1. Conservative by construction: only two interior-dash patterns
   toggle span state; anything ambiguous degrades to `unanchored` (flag, not
   guess). Paragraph = a body line (the EPUB/MD parsers emit one paragraph per
   line). Pure: no I/O, no model calls. */

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;
// ", — lowercase" / "! — lowercase" → close speech, open tag
const TAG_OPEN = new RegExp(String.raw`([,!?…]|\.{3})\s*${DASH}\s*(?=\p{Ll})`, 'gu');
// ". — Uppercase" (inside a dialogue paragraph) → close tag, resume speech
const SPEECH_RESUME = new RegExp(String.raw`([.!?…])\s*${DASH}\s*(?=\p{Lu})`, 'gu');

function hasStem(text: string, stems: string[]): boolean {
  const lower = text.toLowerCase();
  return stems.some((s) => lower.includes(s));
}

export function parseChapterStructure(body: string, index: NameIndex): ParagraphEvidence[] {
  const conv = index.conventions;
  const out: ParagraphEvidence[] = [];
  let offset = 0;
  for (const line of body.split('\n')) {
    const start = offset;
    offset += line.length + 1; // +1 for the split '\n'
    const trimmed = line.trim();
    if (!trimmed) continue;
    const open = conv.dialogueOpen ? line.match(conv.dialogueOpen) : null;
    if (!open) {
      // Quote-language + embedded-quote handling is Task 4; here: narration.
      out.push({ start, end: start + line.length, kind: 'narration',
        spans: [{ kind: 'narration', start, end: start + line.length }] });
      continue;
    }
    out.push(parseDashParagraph(line, start, index, open[0].length));
  }
  return out;
}

function parseDashParagraph(line: string, base: number, index: NameIndex, openLen: number): ParagraphEvidence {
  const conv = index.conventions;
  const spans: SpanEvidence[] = [];
  /* Walk the paragraph after the opening dash, cutting at toggle points. */
  type Cut = { at: number; to: 'tag' | 'speech' };
  const cuts: Cut[] = [];
  for (const m of line.matchAll(TAG_OPEN)) cuts.push({ at: m.index! + m[1].length, to: 'tag' });
  for (const m of line.matchAll(SPEECH_RESUME)) cuts.push({ at: m.index! + m[1].length, to: 'speech' });
  cuts.sort((a, b) => a.at - b.at);

  let state: 'speech' | 'tag' = 'speech';
  let segStart = openLen;
  let lastSpeech: SpanEvidence | null = null;
  const push = (end: number) => {
    if (end <= segStart) return;
    const span: SpanEvidence = { kind: state, start: base + segStart, end: base + end };
    spans.push(span);
    if (state === 'speech') lastSpeech = span;
  };
  for (const cut of cuts) {
    if (cut.to === 'tag' && state === 'speech') {
      push(cut.at);
      state = 'tag'; segStart = cut.at;
    } else if (cut.to === 'speech' && state === 'tag') {
      push(cut.at);
      state = 'speech'; segStart = cut.at;
    }
    /* a cut that doesn't match the current state is ignored — conservative */
  }
  push(line.length);

  /* Validate tag spans: a "tag" with no speech/beat verb was a mis-toggle →
     downgrade: whole paragraph reverts to a single unanchored speech span. */
  const tagSpans = spans.filter((s) => s.kind === 'tag');
  const verbs = [...conv.speechVerbStems, ...conv.beatVerbStems];
  if (tagSpans.some((t) => !hasStem(line.slice(t.start - base, t.end - base), verbs))) {
    return { start: base, end: base + line.length, kind: 'dialogue',
      spans: [{ kind: 'speech', start: base + openLen, end: base + line.length }] };
  }

  /* Anchor speech spans from their adjacent tag: name > pronoun-pending. */
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.kind !== 'tag') continue;
    const text = line.slice(s.start - base, s.end - base);
    const name = findRosterName(text, index);
    const target = (spans[i - 1]?.kind === 'speech' ? spans[i - 1] : null) ?? lastSpeech;
    const following = spans.slice(i + 1).filter((x) => x.kind === 'speech');
    if (name) {
      for (const sp of [target, ...following]) if (sp && !sp.speaker) sp.speaker = { characterId: name, source: 'tag-name' };
    } else {
      const p = conv.pronouns;
      const pron = p.firstPerson?.test(text) ? 'first' : p.male?.test(text) ? 'male' : p.female?.test(text) ? 'female' : undefined;
      if (pron) for (const sp of [target, ...following]) if (sp && !sp.speaker) (sp as SpanEvidence & { pendingPronoun?: string }).pendingPronoun = pron;
    }
  }
  return { start: base, end: base + line.length, kind: 'dialogue', spans };
}
```

- [ ] **Step 4: Run to verify PASS.** Iterate on regex details until green — the TESTS are the contract, not the sketch above.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): structure parser — dash-dialogue path (ru/es)"`

---

### Task 4: Structure parser — quote-dialogue path + sub-paragraph turns

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/parser.ts` (the narration branch in `parseChapterStructure` gains quote-span extraction)
- Test: extend `parser.test.ts`

**Interfaces:** unchanged signature; quote languages (en, de; and embedded `«»` in ru/fr) now yield paragraphs with interleaved `speech`/`narration` spans, one speech span per quoted run. Tag detection: the narration span immediately before/after a quote span containing a verb stem + roster name anchors it (`tag-name`), same rules as Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
describe('parser — quote conventions', () => {
  const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }, { id: 'marcus', name: 'Marcus' }], conventionsFor('en')!);
  it('en quotes: "…," he said splits quote → speech, tail → tag, anchored by name', () => {
    const paras = parseChapterStructure('“Hard to starboard,” Halloran said.', enIdx);
    const spans = paras[0].spans;
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toEqual({ characterId: 'halloran', source: 'tag-name' });
  });
  it('en quotes: multi-turn paragraph yields one speech span PER quoted run', () => {
    const paras = parseChapterStructure('Marcus turned. “Get below,” he muttered. “Now.” The deck pitched.', enIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.length).toBe(2);
  });
  it('ru guillemet (coalfall.ru shape): «…, — сказал X. — …» inside a narration paragraph anchors', () => {
    const ruIdx = buildNameIndex([{ id: 'mairin', name: 'Майрин' }], conventionsFor('ru')!);
    const paras = parseChapterStructure('«Осторожнее, — сказала Майрин. — Здесь скользко».', ruIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.every((s) => s.speaker?.characterId === 'mairin')).toBe(true);
  });
});
```

- [ ] **Step 2: FAIL.**  
- [ ] **Step 3: Implement** — in the non-dash branch, scan the line with each `quotePairs` entry (regex per pair, non-greedy, e.g. `/«[^»]*»/gu`); quoted matches become `speech` spans, gaps become `narration` spans; a narration gap containing a verb stem is reclassified `tag` and anchors adjacent speech spans exactly as in Task 3 (reuse the anchoring block — extract it to a shared helper `anchorSpansFromTags(spans, line, base, index)` during this task; Task 3's dash path calls the same helper). Inside a guillemet span, apply the dash tag/resume rules recursively for the ru `«…, — сказал X. — …»` shape.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): structure parser — quote-dialogue path + shared tag anchoring"`

---

### Task 5: Conversation windows, alternation, pronoun resolution

**Files:**
- Create: `server/src/analyzer/dialogue-structure/windows.ts`
- Test: `server/src/analyzer/dialogue-structure/windows.test.ts`

**Interfaces:**
- Consumes: `ParagraphEvidence[]` (Tasks 3–4), roster with gender: `{ id: string; gender?: 'male' | 'female' | 'neutral' }`, `firstPersonId: string | null` (resolved by caller — the roster character whose aliases include the language's first-person pronoun, e.g. ru `я`; null when absent).
- Produces: `resolveWindows(paras: ParagraphEvidence[], roster: WindowRoster, firstPersonId: string | null): ParagraphEvidence[]` — same array, mutated: `windowId`/`turnIndex` stamped on speech spans; `pendingPronoun` speech spans resolved to `{ characterId, source: 'tag-pronoun' }` (first-person → `firstPersonId`; gendered → the unique gender-compatible window participant, else left unanchored); clean two-party parity fills unanchored turns with `source: 'alternation'`.

- [ ] **Step 1: Failing tests** — cover: (a) window = contiguous dialogue paragraphs, narration paragraphs < 200 chars don't break it, ≥ 200 chars do; (b) first-person pronoun resolves to `firstPersonId`; (c) gendered pronoun resolves only when exactly ONE participant of that gender is in the window; (d) A/B/A/B parity with two anchors fills the gaps as `alternation`; (e) parity conflict (anchors disagree with alternation) leaves spans unanchored; (f) three participants → no alternation fill.

```ts
// representative test (write all six):
it('fills unanchored turns by parity in a clean two-party window', () => {
  const body = '— Раз, — сказал Антон.\n— Два.\n— Три.\n— Четыре, — сказала Ольга.';
  const paras = parseChapterStructure(body, idx);
  resolveWindows(paras, { anton: 'male', olga: 'female' }, null);
  const speech = paras.flatMap((p) => p.spans).filter((s) => s.kind === 'speech');
  expect(speech.map((s) => s.speaker?.characterId)).toEqual(['anton', 'olga', 'anton', 'olga']);
  expect(speech[1].speaker?.source).toBe('alternation');
});
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement** (pure; window grouping loop, then per-window: participants = distinct `tag-*` speakers; pronoun pass; parity pass — parity valid only when every anchored turn is consistent with the two-speaker even/odd assignment). — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): conversation windows, pronoun + alternation resolution"`

---

### Task 6: Sentence↔evidence aligner

**Files:**
- Create: `server/src/analyzer/dialogue-structure/aligner.ts`
- Test: `server/src/analyzer/dialogue-structure/aligner.test.ts`

**Interfaces:**
- Consumes: `SentenceOutput[]` (`server/src/handoff/schemas.ts`), `ParagraphEvidence[]`, `body: string`.
- Produces:

```ts
export interface AlignedSentence {
  sentence: SentenceOutput;
  /** spans the sentence text overlaps, in order; empty = unaligned */
  spans: SpanEvidence[];
  /** true when it overlaps BOTH a speech span and a tag/narration span */
  lumped: boolean;
}
export interface AlignmentResult { aligned: AlignedSentence[]; alignedPct: number }
export function alignSentences(sentences: SentenceOutput[], paras: ParagraphEvidence[], body: string): AlignmentResult;
```

- [ ] **Step 1: Failing tests** — cover: (a) exact-copy sentences align to their spans; (b) glyph drift (model emits `"` where body has `«`, `--` for `—`, collapsed whitespace) still aligns via normalization; (c) a model entry covering quote + tag reports `lumped: true`; (d) **duplicate model spans** (same sentence emitted twice — the stage-2 loop-and-truncate mode) align the first and mark the duplicate unaligned rather than desyncing everything after it; (e) `alignedPct` reflects unaligned count. Normalization function `normalize(s)`: lowercase; map `[«»„“”"']→'"'`, `[–—]|&mdash;|&ndash;→'-'`, `…→'...'`; collapse `\s+→' '`; trim.
- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement** — two-pointer: keep a cursor into `normalize(body)` (with an offset map back to raw offsets); for each sentence, search `normalize(sentence.text)` within a bounded look-ahead window (e.g. cursor..cursor+4096); found → advance cursor to match end, collect overlapping spans; not found → try one re-search from the cursor WITHOUT advancing (duplicate/ooo tolerance), else mark unaligned and DO NOT move the cursor. — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): sentence-evidence aligner with normalization + duplicate tolerance"`

---

### Task 7: Cross-examiner (decision matrix + derived confidence)

**Files:**
- Create: `server/src/analyzer/dialogue-structure/cross-examine.ts`
- Modify: `server/src/analyzer/narrator-default.ts` → module stays as-is (`applyNarratorDefault` is still the engine-off path; its only importers are `analysis.ts` and its own test — verify with `git grep -n "narrator-default"` and keep every import compiling).
- Test: `server/src/analyzer/dialogue-structure/cross-examine.test.ts`

**Interfaces:**
- Consumes: `AlignmentResult` (Task 6), `SentenceOutput[]`, roster ids, `EngineReport` (Task 1).
- Produces:

```ts
export const CONFIDENCE = {
  TAG_CONFIRM: 0.95, TAG_CORRECT: 0.9, TAG_SPAN: 0.9,
  PRONOUN_CONFIRM: 0.85, PRONOUN_CORRECT: 0.8, PRONOUN_KEEP_FLAG: 0.6,
  ALT_CONFIRM: 0.8, ALT_CORRECT_FLAG: 0.7, ALT_KEEP_FLAG: 0.6,
  UNANCH_NAMED_FLAG: 0.65, UNANCH_NARR_FLAG: 0.5, LUMPED_FLAG: 0.65,
  NARRATION_CONFIRM: 0.95, NARRATION_DEMOTE: 0.9, UNALIGNED_CAP: 0.74,
} as const;
export interface CrossExamineResult {
  sentences: SentenceOutput[];           // new array, corrected ids + derived confidence
  flags: Array<{ index: number; reason: string }>; // indexes into sentences[]
  report: EngineReport;
}
export function crossExamine(alignment: AlignmentResult, opts: {
  rosterIds: Set<string>;
  unknownBucketIds: Set<string>;         // MALE_BUCKET_ID / FEMALE_BUCKET_ID from fold-minor-cast.ts
  alignmentFloorPct: number;             // default 80: below → flagOnly (no corrections)
}): CrossExamineResult;
```

- [ ] **Step 1: Failing tests** — implement the FULL spec §5.3 matrix as a table-driven test (one row per matrix line), plus the invariants:

```ts
it('INVARIANT: tag-name evidence is never overridden — model disagreement auto-corrects', () => {
  // body: '— Привет, — сказал Антон.'  model: speech attributed to 'narrator'
  // → characterId becomes 'anton', confidence CONFIDENCE.TAG_CORRECT, structureNote logged
});
it('INVARIANT: continuation sentence inside a speech span is NOT demoted to narrator', () => {
  // body: '— Привет. Давно не виделись.' → model attributed 2nd sentence to anton;
  // old applyNarratorDefault would demote (no dash, no quotes) — engine must keep anton.
});
it('lumped entries are flagged, never corrected', () => { /* matrix row */ });
it('below alignment floor → flagOnly: zero corrections, unaligned caps applied', () => { /* … */ });
it('derived confidence REPLACES model confidence on every sentence', () => { /* … */ });
```

- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement** — pure mapping over `alignment.aligned`; each sentence resolves to exactly one matrix row; `structureNote` reasons are stable strings (`'tag-correct:anton'`, `'lumped'`, `'unanchored-narrator'`, …) surfaced in `flags[].reason` and counted into `report`. Engine-off / null-conventions path: return input sentences run through `applyNarratorDefault` (current behaviour, byte-identical). — [ ] **Step 4: PASS, plus the existing narrator-default suite:** `npx vitest run src/analyzer/narrator-default.test.ts` → PASS unchanged.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): cross-examiner — decision matrix + derived confidence"`

---

### Task 8: Registry knobs + wiring into attributeChapterStage2

**Files:**
- Modify: `server/src/config/registry.ts` (4 knobs + the new group)
- Modify: `server/src/routes/analysis.ts` — `attributeChapterStage2` (line ~1528)
- Modify: `server/src/analyzer/stage2-chunk.ts` — `Stage2ChunkRunResult` (defined HERE, ~lines 150-156, not in analysis.ts) gains optional `structureReport?: EngineReport`
- Test: `server/src/routes/analysis.structure-engine.test.ts` (new; mock analyzer)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `attributeChapterStage2` result sentences are engine-processed; new opts field `structureBudget?: { remainingWindows: number }` (used by Task 9); `Stage2ChunkRunResult` gains optional `structureReport?: EngineReport`.

**Registry knobs** (group: `analyzer-chunking` is wrong — add a new group `{ id: 'analyzer-structure', label: 'Dialogue-structure attribution', help: 'Deterministic structure engine that corrects/flags stage-2 attributions.', risk: 'medium', collapsedByDefault: false }`):

```ts
{ key: 'analyzer.structure.enabled', env: 'STRUCTURE_ENGINE', group: 'analyzer-structure',
  label: 'Structure engine', help: 'Deterministic dialogue-structure pass that corrects tag-proven attributions and derives honest confidence. Off = pre-engine behaviour.',
  type: 'boolean', default: true, apply: 'live', risk: 'medium' },
{ key: 'analyzer.structure.escalation', env: 'ATTRIBUTION_ESCALATION', group: 'analyzer-structure',
  label: 'Attribution escalation', help: "Second-pass re-query of unresolved dialogue windows: 'local' (default) uses the configured analyzer, 'cloud' the Gemini-API Gemma model, 'off' disables.",
  type: 'enum', options: ['off', 'local', 'cloud'], default: 'local', apply: 'live', risk: 'medium' },
{ key: 'analyzer.structure.maxWindowsPerChapter', env: 'ESCALATION_MAX_WINDOWS_PER_CHAPTER', group: 'analyzer-structure',
  label: 'Escalation windows per chapter', help: 'Cap on re-queried conversation windows per chapter.',
  type: 'integer', min: 0, default: 120, apply: 'live', risk: 'low' },
{ key: 'analyzer.structure.maxWindowsPerBook', env: 'ESCALATION_MAX_WINDOWS_PER_BOOK', group: 'analyzer-structure',
  label: 'Escalation windows per book', help: 'Cap on re-queried conversation windows per full-book analysis.',
  type: 'integer', min: 0, default: 600, apply: 'live', risk: 'low' },
```

(The enum field is `options` — `server/src/config/types.ts:27-28`; follow the existing enum knob at
`registry.ts:879` (`options: ['local','gemini']`) verbatim. Knobs are READ at runtime via
`configValue<T>(key)` from `server/src/config/resolver.ts` — there are no per-knob `resolve*`
helpers for new knobs: use `configValue<boolean>('analyzer.structure.enabled')`,
`configValue<string>('analyzer.structure.escalation')`,
`configValue<number>('analyzer.structure.maxWindowsPerChapter')` / `('…PerBook')`.)

- [ ] **Step 1: Failing integration test** — mock analyzer whose `runStage2Chapter` returns fixed sentences over a small ru dash-dialogue body; assert (a) tag-contradicted sentence comes back corrected; (b) confidence values are the derived constants, not the mock's; (c) `structureReport` counters populated; (d) with `STRUCTURE_ENGINE=0` env (or knob off) output is byte-identical to today's `applyNarratorDefault` path; (e) unsupported language (e.g. 'ja') → identical to (d).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement wiring** — inside `attributeChapterStage2` after the chunk run (replacing the line `result.sentences = applyNarratorDefault(result.sentences);`):

```ts
const conventions = configValue<boolean>('analyzer.structure.enabled')
  ? conventionsFor(opts.stageCall.language)
  : null;
if (conventions) {
  const index = buildNameIndex(opts.stage1.characters, conventions);
  const paras = parseChapterStructure(opts.chapter.body, index);
  const firstPersonId = findFirstPersonCharacter(opts.stage1.characters, conventions); // aliases include the fp pronoun
  resolveWindows(paras, rosterGenderMap(opts.stage1.characters), firstPersonId);
  const alignment = alignSentences(result.sentences, paras, opts.chapter.body);
  const examined = crossExamine(alignment, {
    rosterIds: new Set(opts.stage1.characters.map((c) => c.id)),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  });
  result.sentences = examined.sentences;
  result.structureReport = examined.report;
  // Task 9b inserts escalation here, consuming examined.flags.
} else {
  result.sentences = applyNarratorDefault(result.sentences);
}
```

Two small helpers live in THIS task (they are not deliverables of Task 5):

```ts
/** Roster character whose aliases include the language's first-person pronoun (the "я"→Антон case). */
function findFirstPersonCharacter(characters: Array<{ id: string; aliases?: string[] }>, conv: LanguageConventions): string | null {
  if (!conv.pronouns.firstPerson) return null;
  const hit = characters.find((c) => (c.aliases ?? []).some((a) => conv.pronouns.firstPerson!.test(` ${a} `)));
  return hit?.id ?? null;
}
function rosterGenderMap(characters: Array<{ id: string; gender?: string }>): Record<string, 'male' | 'female' | 'neutral'> {
  return Object.fromEntries(characters.map((c) => [c.id, (c.gender as 'male' | 'female' | 'neutral') ?? 'neutral']));
}
```

Report surfacing: log per chapter via the existing server logger
(`[analysis:structure] ch=N aligned=..% confirmed=.. corrected=.. flagged=..`) and aggregate into
the Task 11 provenance report. Do NOT add a new SSE event kind unless you first verify the frontend
SSE reducer silently ignores unknown kinds — the spec's "no frontend changes" non-goal makes
log + provenance the safe default.

- [ ] **Step 4: PASS + existing suites:** `cd server && npx vitest run src/routes/analysis.structure-engine.test.ts` and then `npm run test:server` from root (expect green; the slow tier untouched).
- [ ] **Step 5: Commit** — `git commit -m "feat(server): wire structure engine into stage-2 attribution + registry knobs"`

---

### Task 9: Escalation analyzer primitive (new `Analyzer` method)

> **Why this exists (adversarial-review blocker):** every analyzer call is SCHEMA-CONSTRAINED
> decoding — `runStage2Chapter` pipes through `runStage(..., stage2ChapterSchema, ...)` where the
> Zod schema is BOTH the structured-output grammar and the validator (`.strict()`,
> `sentences.min(1)`). An escalation reply shaped `{assignments:[…]}` is impossible through it, and
> an empty RECITATION body would throw on `.min(1)` instead of being observable. Escalation
> therefore gets its OWN primitive.

**Files:**
- Modify: `server/src/handoff/schemas.ts` — add `escalationSchema`
- Modify: `server/src/analyzer/index.ts` — add `runAttributionEscalation` to the `Analyzer` interface + `FallbackAnalyzer` delegation
- Modify: `server/src/analyzer/ollama.ts`, `server/src/analyzer/gemini.ts` — implementations
- Test: extend `server/src/analyzer/ollama.test.ts` (fast assertions only) + `server/src/analyzer/index.test.ts` if present

**Interfaces:**
- Produces:

```ts
// schemas.ts
export const escalationSchema = z.object({
  assignments: z.array(z.object({ line: z.number().int(), characterId: z.string().min(1) })),
}).strict(); // NOTE: assignments may be EMPTY — no .min(1); an empty/blocked reply must be observable
export type EscalationOutput = z.infer<typeof escalationSchema>;

// Analyzer interface
runAttributionEscalation(manuscriptId: string, chapterId: number, prompt: string, stageCall: StageCall):
  Promise<EscalationOutput | null>;   // null = empty/blocked/unparseable response (RECITATION signature),
                                      // NEVER a throw for those cases — callers skip the window
```

- [ ] **Step 1: Failing tests** — (a) Ollama impl round-trips a valid `{assignments}` reply; (b) an EMPTY response body resolves `null` (not throw); (c) malformed JSON resolves `null`; (d) `FallbackAnalyzer` delegates to whichever engine is active. Mock the HTTP layer the way the existing ollama/gemini tests do (follow their fixtures).
- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement** — mirror `runStage2Chapter`'s plumbing with `escalationSchema` as grammar+validator, but catch empty-body/parse failures into `null`. Cloud path: `GeminiAnalyzer` uses the configured `GEMINI_MODEL`; every call flows through the existing per-model rate limiter — do not bypass it. — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): runAttributionEscalation analyzer primitive with tolerant schema"`

---

### Task 9b: Escalation selector + runner (③)

**Files:**
- Create: `server/src/analyzer/dialogue-structure/escalation.ts`
- Modify: `server/src/routes/analysis.ts` (both call sites create the per-book budget accumulator and pass it; escalation call inside `attributeChapterStage2`)
- Test: `server/src/analyzer/dialogue-structure/escalation.test.ts`

**Interfaces:**
- Consumes: `CrossExamineResult.flags`, `ParagraphEvidence[]`, `body`, `runAttributionEscalation` (Task 9), budget `{ remainingWindows: number }` (mutable, shared per book).
- Produces:

```ts
export interface EscalationOutcome { applied: number; attempted: number }
export async function escalateFlaggedWindows(opts: {
  sentences: SentenceOutput[];              // mutated in place for accepted answers
  flags: Array<{ index: number; reason: string }>;
  paras: ParagraphEvidence[];
  body: string;
  analyzer: Analyzer;                       // calls analyzer.runAttributionEscalation
  stageCall: StageCall;
  rosterIds: Set<string>;
  budget: { remainingWindows: number };
  maxWindowsPerChapter: number;
}): Promise<EscalationOutcome>;
```

- [ ] **Step 1: Failing tests** (mock analyzer exposing `runAttributionEscalation`) — (a) flagged sentences grouped per conversation window (window text ≤ 1500 chars, ±2 short narration paragraphs context); (b) prompt contains the window text, the flagged line markers, participant candidates, and the JSON shape ask; (c) accepted only when characterId ∈ rosterIds AND the line has no `tag-name` evidence → applied at confidence 0.8, flag cleared; (d) `null` result (empty/blocked reply) → window skipped, flags intact; (e) budget: per-chapter and per-book caps decrement and stop; (f) escalation knob `'off'` → function never called (wiring test in Task 8's integration suite).
- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement.** Window prompt (plain text inbox, mirrors existing inbox style):

```
You are resolving speaker attribution for ${n} marked dialogue lines.
Characters present (ids): ${participantIds.join(', ')} — full roster ids: ${rosterIds}.
Reply with ONLY JSON: {"assignments":[{"line":<number>,"characterId":"<roster id>"}]}.
Text (>>N<< marks the lines to resolve):
${windowText}
```

Routing: `'local'` → the already-selected analyzer instance; `'cloud'` → construct a `GeminiAnalyzer` directly, mirroring `selectAnalyzer`'s gemini branch in `server/src/analyzer/index.ts` (~lines 180-194). — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): flagged-window escalation with acceptance rules + budgets"`

---

### Task 10: Script-review evidence annotation

**Files:**
- Modify: `server/src/routes/script-review.ts` (`buildScriptReviewChapterInbox` + the route that builds per-chapter input)
- Modify: `skills/audiobook-script-review.md`
- Test: extend `server/src/routes/script-review.test.ts`

**Interfaces:**
- Consumes: parser ① + windows (Tasks 3–5) run fresh over the chapter body at review time (cheap, pure); current sentence attributions.
- Produces: `buildScriptReviewChapterInbox(...existing args, evidence?: Map<sentenceKey, string>)` — a per-sentence bracketed suffix rendered ONLY when structure disagrees with the current attribution or the line is unanchored speech: `[structure: speech, tag→антон]`, `[structure: speech, speaker unproven]`, `[structure: narration]`.

- [ ] **Step 1: Failing tests** — (a) chapter with zero disagreements renders **byte-identical** to today (snapshot the current output first — same guard style as the fs-64 `priorExchange` tests); (b) a tag-contradicted sentence gets its `[structure: …]` suffix; (c) suffix never includes a sentenceId from another chapter (the §4.6-style guard).
- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement**, plus append to `skills/audiobook-script-review.md` a short "Attribution audit" section: structural annotations are strong hints; propose `reattribute` ops citing them in `rationale`; for dash-dialogue languages verify speech/tag splits (`split` op when a lumped sentence mixes quote and tag). — [ ] **Step 4: PASS (all script-review tests).**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): script-review inbox structure-evidence annotations + skill audit rules"`

---

### Task 11: Provenance + run-report persistence

**Files:**
- Modify: `server/src/routes/analysis.ts` — both completion sites (main whole-book, chapter-subset retry) — find where `state.json` is persisted post-analysis (`Persist cast.json + refreshed manuscript-edits.json + state.json` blocks near lines ~4062 and ~5085)
- Test: extend the nearest existing route test that exercises analysis completion persistence (look at `server/src/routes/book-state.reparse.test.ts` for the state.json read/write pattern)

**Interfaces:**
- Produces: `state.json` gains `analysisProvenance: { engine: string; model: string; at: string; structureEngineVersion: 1; report?: { alignedPct, confirmed, corrected, flagged, escalated, escalationAccepted } }`. Additive and schema-tolerant: readers must not require it.

- [ ] **Step 1: Failing test** — run a mocked analysis to completion; assert `state.json` contains `analysisProvenance.model` and the aggregated report; run the subset route; assert provenance is REWRITTEN (fresh `at`).
- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement** (the engine/model strings come from the same `AnalyzerSelection` the routes already hold). — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): persist analysis provenance + structure-engine run report"`

---

### Task 12: Dash-dialogue ru fixture + full-pipeline integration test

**Files:**
- Create: `server/src/__fixtures__/the-coalfall-commission.ru-dash.md` — a Castwright-owned dash-dialogue Russian scene (~40–60 paragraphs): write an original scene (characters Майрин / Тобиас / рассказчик) using paragraph-leading `—` dialogue with tags before/after speech, multi-sentence utterances, pronoun tags, one two-hander alternation run, one three-party ambiguous run, interior punctuation dashes. **Never copy text from any published book.**
- Test: `server/src/routes/analysis.structure-fixture.test.ts`

- [ ] **Step 1: Write the fixture + failing test** — mock analyzer returns deliberately WRONG attributions for the fixture (tag-contradicted lines on narrator, dialogue on unknown buckets); assert post-engine: tag-proven lines corrected, continuation lines not demoted, ambiguous three-party lines flagged `< 0.75`, two-hander filled by alternation, `structureReport.corrected > 0`.
- [ ] **Step 2: FAIL → Step 3: fix anything the realistic fixture shakes out of Tasks 3–7 → Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "test(server): dash-dialogue ru fixture + end-to-end structure-engine assertions"`

---

### Task 13: Docs, release notes, wiki, backlog close-out

**Files:**
- Create: `docs/features/247-dialogue-structure-attribution.md` (from `docs/features/TEMPLATE.md`, `status: active`) — invariants: the §5.3 matrix ordering, the two hard invariants, the §9 on-box acceptance walkthrough with the baseline numbers (0 flagged today; ~1,900 unanchored; ~859 dash-speech-on-narrator; targets: flags ≤ ~500, hard-error class near-zero) and the probe methodology from the spec §5.4 (reproduce the probe code in an appendix so acceptance can re-run it).
- Modify: `docs/features/INDEX.md` (new entry), `docs/release-notes-next.md` + `RELEASE_NOTES.md` (matching in-progress entries), `docs/BACKLOG.md` (row already added when srv-59 was filed — update if scope shifted).
- Wiki: add rows for the 4 new knobs to the Advanced-Settings page (clone `Castwright.wiki` repo, or edit via web — see `feedback_new_registry_knobs_need_advanced_settings_wiki_row`).

- [ ] Step 1: Write all docs. Step 2: `npm run verify:fast:branch` from repo root → green. Step 3: Commit — `git commit -m "docs(docs): plan 247 regression plan + release notes for dialogue-structure attribution"`.

---

### Task 14: PR + review gate + acceptance handoff

- [ ] Push branch; open PR titled `feat(server): dialogue-structure attribution engine (plan 247)`, body: mini release notes + `Closes #<srv-59 issue number>` (literal, not backticked) + link spec + plan + regression plan.
- [ ] Mandatory independent `code-review` pass (effort `high` — multi-scope feat: server + skills + docs) once fully staged; triage and fold findings before merge.
- [ ] Cloud `verify.yml` green (required check).
- [ ] Merge (merge commit; auto-delete branch). **Owed after merge (record in the issue before closing):** on-box acceptance per regression plan §acceptance — re-analyze _Ночной дозор_ on the default pipeline and compare against the baseline numbers.

---

## Plan Self-Review (done at write time)

- **Spec coverage:** §4 seams → Task 8; §5.1 parser/tables → Tasks 1, 3, 4; §5.2 aligner (incl. duplicate-span idempotence + floor) → Task 6; §5.3 matrix + invariants + lumped → Task 7; §5.4 measured consequence (escalation default local) → Tasks 8–9b; §6 escalation details (empty-response RECITATION via the null-returning primitive, budgets accumulator, acceptance rules) → Tasks 9 + 9b; §7 script review → Task 10; §8 provenance both sites → Task 11; §9 fixtures/tests → Tasks 3–7, 12; wiki knob rows → Task 13; acceptance → Task 14. No uncovered spec section.
- **Adversarial review folded (2026-07-09):** escalation split into its own analyzer primitive
  (Task 9) because analyzer calls are schema-constrained decoding; registry enum field is
  `options`; knob reads via `configValue<T>()`; `Stage2ChunkRunResult` lives in `stage2-chunk.ts`;
  `findFirstPersonCharacter`/`rosterGenderMap` assigned to Task 8; no new SSE kind without
  verifying the frontend reducer tolerates unknown kinds; Task 10/registry sequenced against the
  concurrent script-review-persistence thread.
- **Type consistency:** `conventionsFor`/`buildNameIndex`/`findRosterName`/`parseChapterStructure`/`resolveWindows`/`alignSentences`/`crossExamine`/`escalateFlaggedWindows` are used with the same signatures across tasks.
