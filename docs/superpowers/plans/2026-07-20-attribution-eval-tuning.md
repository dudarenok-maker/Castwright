# Attribution Eval + Tuning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn hand-corrected chapters into a live, three-point (raw LLM / deterministic / post-escalation) attribution-accuracy harness for Qwen local + Gemma cloud, seeded from Playing with Fire ch.43–46.

**Architecture:** A committed **capture** CLI mines a book's `manuscript-edits.json` + `cast.json` + parsed chapter bodies into git-ignored `LabelledChapter` fixtures + a per-book roster snapshot. A committed **runner** CLI pins that roster as `stage1` (so IDs align), attributes each chapter through the real pipeline, snapshots three stages via a small additive eval seam, scores each with the existing `scoreAttribution`, and prints a per-engine/per-stage/per-bucket scorecard. Coalfall (+ a new committed roster) runs every time as the anti-overfit guardrail. A separate diff tool supports whole-book before/after validation.

**Tech Stack:** TypeScript (Node 20, ESM, `.js`-suffixed imports), `tsx` for the CLI entry, Vitest (server config), Zod, a root `.mjs` orchestrator mirroring `scripts/run-golden-audio.mjs`.

## Global Constraints

- **No copyrighted text in git.** The corpus dir (`server/src/analyzer/attribution-eval/corpus/`) is git-ignored. Only Castwright-owned fixtures (Coalfall) are committed. — verbatim from spec §4.
- **Opt-in, triple-gated.** The runner and capture are never in `test:all` / `verify`. The runner SKIPs + exits 0 when a gate is absent (no corpus / Ollama unreachable / no `GEMINI_API_KEY`). Mirror `golden-audio`. — spec §3.
- **Additive production edits only.** The two production files touched (`analysis.ts`, `cross-examine.ts`/`types.ts`) gain optional/extra outputs; default runtime behaviour and existing return destructuring are unchanged. — spec §2 "Scope honesty", §3.5.
- **ESM import suffix:** all intra-`server/src` imports use the `.js` extension (e.g. `from './schema.js'`).
- **Commit convention:** `<type>(server): <subject>` (scope `server`; `scripts`/`docs` where the file lives there). Hooks reject other scopes.
- **Every task ends green** on its own test before commit.

---

## File Structure

**New (committed):**
- `server/src/analyzer/attribution-eval/roster-schema.ts` — `RosterSnapshot` Zod schema + parse.
- `server/src/analyzer/attribution-eval/capture.ts` — pure transforms: edits→`LabelledChapter`, cast→`RosterSnapshot`.
- `server/src/analyzer/attribution-eval/capture-cli.ts` — CLI: resolve book, read files, strip, write corpus.
- `server/src/analyzer/attribution-eval/buckets.ts` — reason→evidence-family coarsening.
- `server/src/analyzer/attribution-eval/run-eval.ts` — runner core (attribute one fixture, 3 stages, score, bucket, scorecard).
- `server/src/analyzer/attribution-eval/run-eval-cli.ts` — runner CLI (gating, engine loop, print).
- `server/src/analyzer/attribution-eval/diff-runs.ts` — whole-book baseline-vs-tuned diff (spec §3.7).
- `server/src/analyzer/attribution-eval/__fixtures__/coalfall.roster.json` — committed Coalfall roster.
- `scripts/run-attribution-eval.mjs` — root orchestrator (spawns `tsx`).
- Test files colocated: `roster-schema.test.ts`, `capture.test.ts`, `capture-cli.test.ts`, `buckets.test.ts`, `run-eval.test.ts`, `diff-runs.test.ts`.

**Modified (committed, additive):**
- `server/src/routes/analysis.ts` — add optional `onStages` callback to `attributeChapterStage2` opts.
- `server/src/analyzer/dialogue-structure/cross-examine.ts` — add `reasons` to `CrossExamineResult`.
- `server/src/analyzer/dialogue-structure/types.ts` — export `DecisionBucket`.
- `.gitignore` — ignore the corpus dir.
- root `package.json` — `eval:attribution`, `eval:attribution:capture` scripts.

**New (git-ignored):**
- `server/src/analyzer/attribution-eval/corpus/` — the labelled fixtures + roster snapshots.

**Docs:**
- `docs/features/<nn>-attribution-eval-tuning.md` — regression plan (Task 9).

---

## Task 1: Roster snapshot schema

**Files:**
- Create: `server/src/analyzer/attribution-eval/roster-schema.ts`
- Test: `server/src/analyzer/attribution-eval/roster-schema.test.ts`

**Interfaces:**
- Produces: `RosterSnapshotSchema` (Zod), `type RosterSnapshot = { characters: Array<{ id: string; name: string; gender?: 'male'|'female'|'neutral'; aliases?: string[] }> }`, `parseRosterSnapshot(json: unknown): RosterSnapshot`.

- [ ] **Step 1: Write the failing test**

```ts
// roster-schema.test.ts
import { describe, it, expect } from 'vitest';
import { parseRosterSnapshot } from './roster-schema.js';

describe('parseRosterSnapshot', () => {
  it('accepts a well-formed roster', () => {
    const r = parseRosterSnapshot({
      characters: [
        { id: 'narrator', name: 'Narrator' },
        { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female', aliases: ['Val'] },
      ],
    });
    expect(r.characters).toHaveLength(2);
    expect(r.characters[1].gender).toBe('female');
  });

  it('rejects a character missing id', () => {
    expect(() => parseRosterSnapshot({ characters: [{ name: 'x' }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/roster-schema.test.ts`
Expected: FAIL — cannot find module `./roster-schema.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// roster-schema.ts
import { z } from 'zod';

export const RosterSnapshotSchema = z.object({
  characters: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      gender: z.enum(['male', 'female', 'neutral']).optional(),
      aliases: z.array(z.string()).optional(),
    })
  ),
});

export type RosterSnapshot = z.infer<typeof RosterSnapshotSchema>;

export function parseRosterSnapshot(json: unknown): RosterSnapshot {
  return RosterSnapshotSchema.parse(json);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/roster-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/attribution-eval/roster-schema.ts server/src/analyzer/attribution-eval/roster-schema.test.ts
git commit -m "feat(server): add roster-snapshot schema for attribution eval"
```

---

## Task 2: Capture transforms (pure)

**Files:**
- Create: `server/src/analyzer/attribution-eval/capture.ts`
- Test: `server/src/analyzer/attribution-eval/capture.test.ts`

**Interfaces:**
- Consumes: `LabelledChapter` (`./schema.js`), `RosterSnapshot` (`./roster-schema.js`), `SentenceOutput` (`../../handoff/schemas.js`), `CastCharacter` shape (id/name/gender/aliases fields).
- Produces:
  - `buildLabelledChapter(chapterText: string, sentences: SentenceOutput[], chapterId: number): LabelledChapter` — filters sentences to `chapterId`, sorts by `id`, maps to `{ text, speakerId: characterId }`, pairs with the given `chapterText`.
  - `buildRosterSnapshot(cast: Array<{ id: string; name?: string; gender?: 'male'|'female'|'neutral'; aliases?: string[] }>): RosterSnapshot` — maps to `{ id, name: name ?? id, gender, aliases }`.

- [ ] **Step 1: Write the failing test**

```ts
// capture.test.ts
import { describe, it, expect } from 'vitest';
import { buildLabelledChapter, buildRosterSnapshot } from './capture.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

const s = (id: number, chapterId: number, characterId: string, text: string): SentenceOutput => ({
  id, chapterId, characterId, text,
});

describe('buildLabelledChapter', () => {
  it('filters to the chapter, orders by id, maps characterId→speakerId', () => {
    const sentences = [
      s(3, 44, 'valkyrie', 'Line C'),
      s(1, 44, 'narrator', 'Line A'),
      s(2, 45, 'skulduggery', 'other chapter'),
      s(2, 44, 'skulduggery', 'Line B'),
    ];
    const out = buildLabelledChapter('CHAPTER BODY', sentences, 44);
    expect(out.chapterText).toBe('CHAPTER BODY');
    expect(out.lines).toEqual([
      { text: 'Line A', speakerId: 'narrator' },
      { text: 'Line B', speakerId: 'skulduggery' },
      { text: 'Line C', speakerId: 'valkyrie' },
    ]);
  });
});

describe('buildRosterSnapshot', () => {
  it('keeps id/name/gender/aliases and falls back name→id', () => {
    const out = buildRosterSnapshot([
      { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female', aliases: ['Val'] },
      { id: 'narrator' },
    ]);
    expect(out.characters).toEqual([
      { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female', aliases: ['Val'] },
      { id: 'narrator', name: 'narrator' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/capture.test.ts`
Expected: FAIL — cannot find module `./capture.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// capture.ts
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

export function buildLabelledChapter(
  chapterText: string,
  sentences: SentenceOutput[],
  chapterId: number,
): LabelledChapter {
  const lines = sentences
    .filter((s) => s.chapterId === chapterId)
    .sort((a, b) => a.id - b.id)
    .map((s) => ({ text: s.text, speakerId: s.characterId }));
  return { chapterText, lines };
}

export function buildRosterSnapshot(
  cast: Array<{ id: string; name?: string; gender?: 'male' | 'female' | 'neutral'; aliases?: string[] }>,
): RosterSnapshot {
  return {
    characters: cast.map((c) => {
      const out: RosterSnapshot['characters'][number] = { id: c.id, name: c.name ?? c.id };
      if (c.gender) out.gender = c.gender;
      if (c.aliases) out.aliases = c.aliases;
      return out;
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/attribution-eval/capture.ts server/src/analyzer/attribution-eval/capture.test.ts
git commit -m "feat(server): add pure capture transforms for attribution fixtures"
```

---

## Task 3: Capture CLI + gitignore + npm script

**Files:**
- Create: `server/src/analyzer/attribution-eval/capture-cli.ts`
- Test: `server/src/analyzer/attribution-eval/capture-cli.test.ts`
- Modify: `.gitignore`, root `package.json`

**Interfaces:**
- Consumes: `buildLabelledChapter`, `buildRosterSnapshot` (Task 2); `findBookByBookId` (`../../workspace/scan.js`, returns `{ bookDir, author, title, state: { manuscriptId, author, title } }`); `getOrHydrateManuscript` (`../../store/manuscripts.js`, `(manuscriptId) → { chapterHints: Array<{ id; title; body }> } | undefined`); `stripFrontMatterBoilerplate` (`../strip-front-matter.js`, `(body, { author, title }) → string`); `manuscriptEditsJsonPath`, `castJsonPath` (`../../workspace/paths.js`).
- Produces: `captureCorpus(opts: { bookId: string; chapters: number[]; corpusDir: string }): Promise<{ writtenFixtures: string[]; rosterPath: string }>` — writes `<corpusDir>/<bookSlug>-ch<NN>.<lang?>.labelled.json` per chapter and `<corpusDir>/<bookSlug>.roster.json`. Plus a `main()` that parses `--book` / `--chapters` from `process.argv` and calls it.

- [ ] **Step 1: Write the failing test** (drives `captureCorpus` against a temp workspace, mocking the two workspace lookups so no real books are needed)

```ts
// capture-cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bookDir = mkdtempSync(join(tmpdir(), 'cap-book-'));
mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
writeFileSync(
  join(bookDir, '.audiobook', 'manuscript-edits.json'),
  JSON.stringify({ sentences: [
    { id: 1, chapterId: 44, characterId: 'narrator', text: 'He said.' },
    { id: 2, chapterId: 44, characterId: 'valkyrie', text: 'Hi.' },
  ] }),
);
writeFileSync(
  join(bookDir, '.audiobook', 'cast.json'),
  JSON.stringify({ characters: [
    { id: 'narrator', name: 'Narrator' },
    { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female' },
  ] }),
);

vi.mock('../../workspace/scan.js', () => ({
  findBookByBookId: vi.fn(async () => ({
    bookDir, author: 'Derek Landy', title: 'Playing with Fire',
    state: { manuscriptId: 'm_pwf', author: 'Derek Landy', title: 'Playing with Fire', language: 'en' },
  })),
  bookStateLanguage: (s: { language?: string }) => s.language ?? 'en',
}));
vi.mock('../../store/manuscripts.js', () => ({
  getOrHydrateManuscript: vi.fn(async () => ({
    chapterHints: [{ id: 44, title: 'Ch44', body: 'RAW BODY 44' }],
  })),
}));

import { captureCorpus } from './capture-cli.js';

describe('captureCorpus', () => {
  const corpusDir = mkdtempSync(join(tmpdir(), 'cap-corpus-'));
  it('writes a labelled fixture + roster snapshot', async () => {
    const res = await captureCorpus({ bookId: 'b_pwf', chapters: [44], corpusDir });
    expect(res.writtenFixtures).toHaveLength(1);
    const fixture = JSON.parse(readFileSync(res.writtenFixtures[0], 'utf8'));
    expect(fixture.chapterText).toContain('RAW BODY 44');
    expect(fixture.lines).toEqual([
      { text: 'He said.', speakerId: 'narrator' },
      { text: 'Hi.', speakerId: 'valkyrie' },
    ]);
    const roster = JSON.parse(readFileSync(res.rosterPath, 'utf8'));
    expect(roster.characters.find((c: any) => c.id === 'valkyrie').gender).toBe('female');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/capture-cli.test.ts`
Expected: FAIL — cannot find module `./capture-cli.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// capture-cli.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBookByBookId, bookStateLanguage } from '../../workspace/scan.js';
import { getOrHydrateManuscript } from '../../store/manuscripts.js';
import { stripFrontMatterBoilerplate } from '../strip-front-matter.js';
import { manuscriptEditsJsonPath, castJsonPath } from '../../workspace/paths.js';
import { buildLabelledChapter, buildRosterSnapshot } from './capture.js';

const DEFAULT_CORPUS_DIR = fileURLToPath(new URL('./corpus/', import.meta.url));

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function captureCorpus(opts: {
  bookId: string;
  chapters: number[];
  corpusDir?: string;
}): Promise<{ writtenFixtures: string[]; rosterPath: string }> {
  const corpusDir = opts.corpusDir ?? DEFAULT_CORPUS_DIR;
  await mkdir(corpusDir, { recursive: true });

  const book = await findBookByBookId(opts.bookId);
  if (!book) throw new Error(`No book found for bookId ${opts.bookId}`);
  const { bookDir, state } = book;
  const author = state.author;
  const title = state.title;
  const bookSlug = slug(title);
  const lang = bookStateLanguage(state); // e.g. 'en' / 'ru' — stamped into the fixture filename

  const edits = JSON.parse(await readFile(manuscriptEditsJsonPath(bookDir), 'utf8')) as {
    sentences: Array<{ id: number; chapterId: number; characterId: string; text: string }>;
  };
  const cast = JSON.parse(await readFile(castJsonPath(bookDir), 'utf8')) as {
    characters: Array<{ id: string; name?: string; gender?: 'male' | 'female' | 'neutral'; aliases?: string[] }>;
  };

  const record = await getOrHydrateManuscript(state.manuscriptId);
  if (!record) throw new Error(`Could not hydrate manuscript ${state.manuscriptId}`);

  const writtenFixtures: string[] = [];
  for (const chapterId of opts.chapters) {
    const hint = record.chapterHints.find((c) => c.id === chapterId);
    if (!hint) throw new Error(`Chapter ${chapterId} not found in manuscript ${state.manuscriptId}`);
    const chapterText = stripFrontMatterBoilerplate(hint.body, { author, title });
    const labelled = buildLabelledChapter(chapterText, edits.sentences as never, chapterId);
    const num = String(chapterId).padStart(2, '0');
    const path = join(corpusDir, `${bookSlug}-ch${num}.${lang}.labelled.json`);
    await writeFile(path, JSON.stringify(labelled, null, 2));
    writtenFixtures.push(path);
  }

  const rosterPath = join(corpusDir, `${bookSlug}.roster.json`);
  await writeFile(rosterPath, JSON.stringify(buildRosterSnapshot(cast.characters), null, 2));

  return { writtenFixtures, rosterPath };
}

function parseArgs(argv: string[]): { bookId: string; chapters: number[] } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bookId = get('--book');
  const chaptersRaw = get('--chapters');
  if (!bookId || !chaptersRaw) {
    throw new Error('Usage: capture-cli --book <bookId> --chapters 43,44,45,46');
  }
  const chapters = chaptersRaw.split(',').map((n) => Number(n.trim()));
  return { bookId, chapters };
}

// Run only when invoked directly (not when imported by tests). Normalise both
// sides with resolve() — a bare string compare is Windows-brittle (drive-letter
// casing / slash direction), matching the repo precedent (build-companion-apk.mjs).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { bookId, chapters } = parseArgs(process.argv.slice(2));
  captureCorpus({ bookId, chapters })
    .then((r) => {
      console.log(`Wrote ${r.writtenFixtures.length} fixture(s) + roster:`);
      for (const f of r.writtenFixtures) console.log(`  ${f}`);
      console.log(`  ${r.rosterPath}`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/capture-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Add gitignore + npm script**

Append to `.gitignore`:
```
# Attribution-eval corpus — copyrighted book text, local-only (spec 2026-07-20)
server/src/analyzer/attribution-eval/corpus/
```

Add to root `package.json` "scripts" (use `npx tsx` — `tsx` is a `server/` devDependency with no root bin, matching existing root scripts like `audit:stage2-coverage`):
```json
"eval:attribution:capture": "npx tsx server/src/analyzer/attribution-eval/capture-cli.ts",
```

- [ ] **Step 6: Verify gitignore + script**

Run: `git check-ignore server/src/analyzer/attribution-eval/corpus/x.json`
Expected: prints the path (ignored).
Run: `npm run eval:attribution:capture -- --help 2>&1 || true` — smoke that `tsx` resolves the entry (it will error "Usage:" — acceptable, proves wiring).

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/attribution-eval/capture-cli.ts server/src/analyzer/attribution-eval/capture-cli.test.ts .gitignore package.json
git commit -m "feat(server): add capture CLI for attribution-eval corpus"
```

---

## Task 4: Expose per-sentence reasons from cross-examine

**Files:**
- Modify: `server/src/analyzer/dialogue-structure/types.ts` (export `DecisionBucket`)
- Modify: `server/src/analyzer/dialogue-structure/cross-examine.ts:40-46` (add `reasons` to `CrossExamineResult`) and the return-build loop (`:285-309`)
- Test: `server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts`

**Interfaces:**
- Produces: `CrossExamineResult.reasons: Array<{ index: number; reason: string; bucket: DecisionBucket }>` — one entry per output sentence, index-aligned to `sentences`. `export type DecisionBucket = 'confirmed' | 'corrected' | 'flagged' | 'lumped'`.
- Note: existing consumers destructure `{ sentences, flags, report }` and are unaffected (additive field).

- [ ] **Step 1: Write the failing test** (uses the existing cross-examine test harness patterns; assert every sentence gets a reason+bucket, not only flagged ones)

```ts
// cross-examine-reasons.test.ts
// AlignedSentence/SpanEvidence factories are the exact ones from
// cross-examine.test.ts:19-50 (mkSentence/speechSpan/narrationSpan/aligned).
import { describe, it, expect } from 'vitest';
import { crossExamine } from './cross-examine.js';
import type { AlignedSentence, AlignmentResult } from './aligner.js';
import type { EvidenceSource, SpanEvidence } from './types.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

let nextId = 1;
const mkSentence = (characterId: string): SentenceOutput => ({
  id: nextId++, chapterId: 1, characterId, text: 'driven by aligned spans, not text',
});
const speechSpan = (speaker?: { characterId: string; source: EvidenceSource }): SpanEvidence => ({
  kind: 'speech', start: 0, end: 1, speaker,
});
const narrationSpan = (): SpanEvidence => ({ kind: 'narration', start: 0, end: 1 });
const aligned = (sentence: SentenceOutput, spans: SpanEvidence[]): AlignedSentence => ({
  sentence, spans, lumped: false,
});

describe('crossExamine reasons', () => {
  it('emits a reason+bucket for EVERY sentence, not only flagged', () => {
    // Line 0: tag-name proves 'alice' (CONFIRMED, not flagged). Line 1: pure narration.
    const alignment: AlignmentResult = {
      aligned: [
        aligned(mkSentence('alice'), [speechSpan({ characterId: 'alice', source: 'tag-name' })]),
        aligned(mkSentence('narrator'), [narrationSpan()]),
      ],
      alignedPct: 100,
    };
    const result = crossExamine(alignment, {
      rosterIds: new Set(['alice', 'narrator']),
      unknownBucketIds: new Set(),
      alignmentFloorPct: 80,
    });
    expect(result.reasons).toHaveLength(result.sentences.length);
    for (let i = 0; i < result.sentences.length; i++) {
      expect(result.reasons[i].index).toBe(i);
      expect(typeof result.reasons[i].reason).toBe('string');
      expect(['confirmed', 'corrected', 'flagged', 'lumped']).toContain(result.reasons[i].bucket);
    }
    // The confirmed line is NOT flagged, yet still carries a reason — the whole point.
    expect(result.reasons[0].bucket).toBe('confirmed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine-reasons.test.ts`
Expected: FAIL — `result.reasons` is `undefined`.

- [ ] **Step 3: Implement (additive)**

In `types.ts`, add near `EngineReport`:
```ts
export type DecisionBucket = 'confirmed' | 'corrected' | 'flagged' | 'lumped';
```

In `cross-examine.ts`, extend the result interface (`:40-46`):
```ts
export interface CrossExamineResult {
  sentences: SentenceOutput[];
  flags: Array<{ index: number; reason: string }>;
  reasons: Array<{ index: number; reason: string; bucket: DecisionBucket }>;
  report: EngineReport;
}
```
Import the type: `import type { EngineReport, DecisionBucket } from './types.js';`

In the return-build loop (`:285-309`) where each `decision` is known per output sentence, accumulate a parallel array:
```ts
  const reasons: CrossExamineResult['reasons'] = [];
  // inside the per-sentence loop, right after computing `decision` and pushing the sentence:
  reasons.push({ index: reasons.length, reason: decision.reason, bucket: decision.bucket });
  // ...
  return { sentences, flags, reasons, report };
```
(Keep `Bucket` internal; it is structurally identical to the exported `DecisionBucket`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/dialogue-structure/cross-examine-reasons.test.ts src/analyzer/dialogue-structure/cross-examine.test.ts`
Expected: PASS (new test + the existing cross-examine suite still green — additive field doesn't break destructuring).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/dialogue-structure/types.ts server/src/analyzer/dialogue-structure/cross-examine.ts server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts
git commit -m "feat(server): expose per-sentence reasons from crossExamine (eval seam)"
```

---

## Task 5: Add `onStages` snapshot callback to attributeChapterStage2

**Files:**
- Modify: `server/src/routes/analysis.ts` — opts type (`:1701-1730`), raw snapshot after `runStage2ChapterChunked` (`:1784`), deterministic snapshot in both branches (after `:1808` and `:1859`), invoke callback before `return` (after `:1867`).
- Test: `server/src/routes/attribute-chapter-stages.test.ts`

**Interfaces:**
- Produces: `attributeChapterStage2` opts gains `onStages?: (stages: { raw: SentenceOutput[]; deterministic: SentenceOutput[]; reasons: Array<{ index: number; reason: string; bucket: DecisionBucket }> }) => void`. Called exactly once per chapter (when provided) with **structured clones** of (a) the raw model output and (b) the deterministic pass, **before** escalation mutates in place, plus the per-sentence `reasons` from Task 4's `CrossExamineResult` (empty array in the narrator-default branch, which has no evidence classes). `final` is the function's normal return `result.sentences`. Default (no callback) → zero behaviour change.

- [ ] **Step 1: Write the failing test** — use the full `Analyzer` stub pattern from `analysis.structure-engine.test.ts:52-70` (all seven methods; `runAttributionEscalation → null` so the real structure engine runs but escalation is a no-op). English `stageCall.language` → `conventionsFor('en')` is non-null, so the structure branch runs and `reasons` is populated. Assert the callback fires once with raw + deterministic + reasons.

```ts
// attribute-chapter-stages.test.ts
import { describe, it, expect } from 'vitest';
import type { Analyzer } from '../analyzer/index.js';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { attributeChapterStage2 } from './analysis.js';

// Minimal English chapter: one tag-anchored speech line + one narration line.
const CHAPTER_BODY = '"Are you sure?" asked Alice.\n\nBob nodded and turned away.';
const CHARACTERS: CharacterOutput[] = [
  { id: 'alice', name: 'Alice', role: 'lead', color: '#111111', gender: 'female' },
  { id: 'bob', name: 'Bob', role: 'lead', color: '#222222', gender: 'male' },
];
const STAGE1: Stage1Output = { characters: CHARACTERS, chapters: [{ id: 1, title: 'Chapter One' }] };

// Full Analyzer stub (mirrors analysis.structure-engine.test.ts). runStage2Chapter
// returns a fixed raw attribution; runAttributionEscalation → null (escalation no-op).
function fakeAnalyzer(sentences: SentenceOutput[]): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.resolve({ sentences }),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
}

describe('attributeChapterStage2 onStages', () => {
  it('invokes onStages once with raw + deterministic + reasons', async () => {
    const captured: Array<{ raw: SentenceOutput[]; deterministic: SentenceOutput[]; reasons: unknown[] }> = [];
    const raw: SentenceOutput[] = [
      { id: 1, chapterId: 1, characterId: 'bob', confidence: 0.4, text: 'Are you sure?' },
      { id: 2, chapterId: 1, characterId: 'narrator', confidence: 0.4, text: 'Bob nodded and turned away.' },
    ];
    await attributeChapterStage2({
      analyzer: fakeAnalyzer(raw),
      manuscriptId: 'm1',
      title: 'Test Book',
      stage1: STAGE1,
      chapter: { id: 1, title: 'Chapter One', body: CHAPTER_BODY },
      stageCall: { language: 'en' } as never,
      onStages: (s) => captured.push(s),
    });
    expect(captured).toHaveLength(1);
    expect(Array.isArray(captured[0].raw)).toBe(true);
    expect(Array.isArray(captured[0].deterministic)).toBe(true);
    // structure branch ran (en supported) → reasons align 1:1 to the deterministic snapshot.
    expect(captured[0].reasons).toHaveLength(captured[0].deterministic.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/attribute-chapter-stages.test.ts`
Expected: FAIL — `onStages` not called / not in type.

- [ ] **Step 3: Implement (additive)**

Import the bucket type: `import type { DecisionBucket } from '../analyzer/dialogue-structure/types.js';`

Add to the opts object type (`:1701-1730`):
```ts
  onStages?: (stages: {
    raw: SentenceOutput[];
    deterministic: SentenceOutput[];
    reasons: Array<{ index: number; reason: string; bucket: DecisionBucket }>;
  }) => void;
```
Right after `const result = await runStage2ChapterChunked({...})` (`:~1784`):
```ts
  const rawSnapshot = opts.onStages ? structuredClone(result.sentences) : null;
  let detSnapshot: SentenceOutput[] | null = null;
  let detReasons: Array<{ index: number; reason: string; bucket: DecisionBucket }> = [];
```
In the structure branch, immediately after `result.sentences = examined.sentences;` (`:1808`) and **before** the escalation block (`:1814`):
```ts
    if (opts.onStages) { detSnapshot = structuredClone(examined.sentences); detReasons = examined.reasons; }
```
In the else branch, after `result.sentences = applyNarratorDefault(result.sentences);` (`:1859`):
```ts
    if (opts.onStages) { detSnapshot = structuredClone(result.sentences); detReasons = []; }
```
After `annotateSceneBreaks(result.sentences, opts.chapter.body);` (`:1867`), before `return result;`:
```ts
  if (opts.onStages && rawSnapshot) {
    opts.onStages({
      raw: rawSnapshot,
      deterministic: detSnapshot ?? structuredClone(result.sentences),
      reasons: detReasons,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/attribute-chapter-stages.test.ts src/routes/analysis.structure-engine.test.ts`
Expected: PASS (new test green; existing structure-engine suite unaffected).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/attribute-chapter-stages.test.ts
git commit -m "feat(server): snapshot raw+deterministic stages via onStages callback"
```

---

## Task 6: Bucket coarsening

**Files:**
- Create: `server/src/analyzer/attribution-eval/buckets.ts`
- Test: `server/src/analyzer/attribution-eval/buckets.test.ts`

**Interfaces:**
- Produces: `evidenceFamily(reason: string): 'tag' | 'pronoun' | 'alternation' | 'unanchored' | 'narration' | 'lumped' | 'unaligned' | 'other'` — maps a raw `Decision.reason` (e.g. `tag-confirm:alice`, `pronoun-keep-flag:x-vs-y`, `alt-correct-flag:z`, `unanchored-named:m`, `narration-demote:first`) to its family by prefix.

- [ ] **Step 1: Write the failing test**

```ts
// buckets.test.ts
import { describe, it, expect } from 'vitest';
import { evidenceFamily } from './buckets.js';

describe('evidenceFamily', () => {
  it.each([
    ['tag-confirm:alice', 'tag'],
    ['tag-correct:bob', 'tag'],
    ['tag-span-narrator', 'tag'],
    ['pronoun-confirm:x', 'pronoun'],
    ['pronoun-keep-flag:a-vs-b', 'pronoun'],
    ['alt-confirm:x', 'alternation'],
    ['alt-keep-flag:a-vs-b', 'alternation'],
    ['unanchored-named:m', 'unanchored'],
    ['unanchored-narrator', 'unanchored'],
    ['narration-confirm', 'narration'],
    ['narration-demote:first', 'narration'],
    ['lumped', 'lumped'],
    ['unaligned', 'unaligned'],
    ['flag-only-floor', 'other'],
  ])('%s → %s', (reason, family) => {
    expect(evidenceFamily(reason)).toBe(family);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/buckets.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// buckets.ts
export type EvidenceFamily =
  | 'tag' | 'pronoun' | 'alternation' | 'unanchored' | 'narration' | 'lumped' | 'unaligned' | 'other';

export function evidenceFamily(reason: string): EvidenceFamily {
  if (reason.startsWith('tag-')) return 'tag';
  if (reason.startsWith('pronoun-')) return 'pronoun';
  if (reason.startsWith('alt-')) return 'alternation';
  if (reason.startsWith('unanchored')) return 'unanchored';
  if (reason.startsWith('narration')) return 'narration';
  if (reason === 'lumped') return 'lumped';
  if (reason === 'unaligned') return 'unaligned';
  return 'other';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/buckets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/attribution-eval/buckets.ts server/src/analyzer/attribution-eval/buckets.test.ts
git commit -m "feat(server): add reason→evidence-family bucketing"
```

---

## Task 7: Runner core — score one fixture at three stages

**Files:**
- Create: `server/src/analyzer/attribution-eval/run-eval.ts`
- Test: `server/src/analyzer/attribution-eval/run-eval.test.ts`

**Interfaces:**
- Consumes: `scoreAttribution` (`./scorer.js`), `parseLabelledChapter` (`./schema.js`), `evidenceFamily` (`./buckets.js`), `attributeChapterStage2` + its opts (`../../routes/analysis.js`), `SentenceOutput` (`../../handoff/schemas.js`), `Stage1Output`/`CharacterOutput` (`../../handoff/schemas.js`), `Analyzer` (`../index.js`), `RosterSnapshot` (`./roster-schema.js`).
- Produces:
  - `type StageScore = { recall: number; precision: number; segMismatch: number; total: number; byFamily: Record<string, { correct: number; total: number }> }`.
  - `type FixtureResult = { fixture: string; raw: StageScore; deterministic: StageScore; final: StageScore }`.
  - `rosterToStage1(roster: RosterSnapshot, chapterId: number): Stage1Output` — build a minimal `stage1` whose `characters` carry the pinned ids/names/gender/aliases (fill required `characterSchema` fields `role`/`color` with safe defaults) and a single-chapter `chapters` entry.
  - `evalFixture(opts: { analyzer: Analyzer; escalationAnalyzer?: Analyzer | null; manuscriptId: string; title: string; truth: LabelledChapter; roster: RosterSnapshot; chapterId: number; stageCall: StageCall }): Promise<FixtureResult>` — pins roster→stage1, runs `attributeChapterStage2` with an `onStages` collector, scores raw/deterministic/final, buckets deterministic & final by the collected reasons.

- [ ] **Step 1: Write the failing test** — a fake `Analyzer` whose `runStage2Chapter` returns a known set; assert per-stage recall and family tallies.

```ts
// run-eval.test.ts
import { describe, it, expect } from 'vitest';
import { evalFixture, rosterToStage1 } from './run-eval.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';

const roster: RosterSnapshot = { characters: [
  { id: 'narrator', name: 'Narrator' },
  { id: 'alice', name: 'Alice', gender: 'female' },
] };

const truth: LabelledChapter = {
  chapterText: '"Hi," Alice said.',
  lines: [
    { text: 'Hi,', speakerId: 'alice' },
    { text: 'Alice said.', speakerId: 'narrator' },
  ],
};

// Full Analyzer stub (runAttributionEscalation → null so escalation is a no-op).
const fakeAnalyzer: any = {
  runStage1: () => Promise.reject(new Error('not used')),
  runStage1Chapter: () => Promise.reject(new Error('not used')),
  runStage2Chapter: () => Promise.resolve({ sentences: [
    { id: 1, chapterId: 44, characterId: 'alice', text: 'Hi,' },
    { id: 2, chapterId: 44, characterId: 'narrator', text: 'Alice said.' },
  ] }),
  runEmotionChapter: () => Promise.reject(new Error('not used')),
  runScriptReviewChapter: () => Promise.reject(new Error('not used')),
  runStage3Chapter: () => Promise.reject(new Error('not used')),
  runAttributionEscalation: () => Promise.resolve(null),
};

describe('rosterToStage1', () => {
  it('pins roster ids and satisfies characterSchema required fields', () => {
    const s1 = rosterToStage1(roster, 44);
    expect(s1.characters.map((c) => c.id)).toEqual(['narrator', 'alice']);
    expect(s1.characters[1].role).toBeTruthy();
    expect(s1.characters[1].color).toBeTruthy();
  });
});

describe('evalFixture', () => {
  it('scores three stages against the real structure engine (en)', async () => {
    // en is a supported language → the structure branch runs for real; the fake's
    // runAttributionEscalation → null makes escalation a no-op. No config override needed.
    const res = await evalFixture({
      analyzer: fakeAnalyzer,
      manuscriptId: 'm', title: 'T', truth, roster, chapterId: 44,
      stageCall: { language: 'en' } as never,
    });
    expect(res.raw.recall).toBeCloseTo(1);
    expect(res.final.recall).toBeCloseTo(1);
    expect(res.final.total).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

```ts
// run-eval.ts
import { scoreAttribution } from './scorer.js';
import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import { evidenceFamily } from './buckets.js';
import { attributeChapterStage2 } from '../../routes/analysis.js';
import type { SentenceOutput, Stage1Output } from '../../handoff/schemas.js';
import type { Analyzer } from '../index.js';
import type { StageCall } from '../index.js';

export interface StageScore {
  recall: number;
  precision: number;
  segMismatch: number;
  total: number;
  byFamily: Record<string, { correct: number; total: number }>;
}
export interface FixtureResult {
  fixture: string;
  raw: StageScore;
  deterministic: StageScore;
  final: StageScore;
}

export function rosterToStage1(roster: RosterSnapshot, chapterId: number): Stage1Output {
  return {
    characters: roster.characters.map((c) => ({
      id: c.id,
      name: c.name,
      role: 'character',
      color: '#888888',
      ...(c.gender ? { gender: c.gender } : {}),
      ...(c.aliases ? { aliases: c.aliases } : {}),
    })),
    chapters: [{ id: chapterId, title: `Chapter ${chapterId}` }],
  } as Stage1Output;
}

function toPredicted(sentences: SentenceOutput[]): Array<{ text: string; characterId: string }> {
  return sentences.map((s) => ({ text: s.text, characterId: s.characterId }));
}

function scoreStage(
  truth: LabelledChapter,
  sentences: SentenceOutput[],
  reasons?: Array<{ index: number; reason: string }>,
): StageScore {
  const s = scoreAttribution(truth, toPredicted(sentences));
  const total = s.truePositive + s.falseNegative;
  const byFamily: StageScore['byFamily'] = {};
  if (reasons) {
    // perLine[0..sentences.length-1] is in predicted (sentence) order, 1:1.
    for (let i = 0; i < sentences.length; i++) {
      const fam = evidenceFamily(reasons[i]?.reason ?? 'other');
      const line = s.perLine[i];
      byFamily[fam] ??= { correct: 0, total: 0 };
      byFamily[fam].total++;
      if (line?.correct) byFamily[fam].correct++;
    }
  }
  return {
    recall: s.recall,
    precision: s.precision,
    segMismatch: s.segMismatch,
    total,
    byFamily,
  };
}

export async function evalFixture(opts: {
  analyzer: Analyzer;
  escalationAnalyzer?: Analyzer | null;
  manuscriptId: string;
  title: string;
  truth: LabelledChapter;
  roster: RosterSnapshot;
  chapterId: number;
  stageCall: StageCall;
  fixtureName?: string;
}): Promise<FixtureResult> {
  const stage1 = rosterToStage1(opts.roster, opts.chapterId);
  let stages: {
    raw: SentenceOutput[];
    deterministic: SentenceOutput[];
    reasons: Array<{ index: number; reason: string; bucket: string }>;
  } | null = null;

  const result = await attributeChapterStage2({
    analyzer: opts.analyzer,
    manuscriptId: opts.manuscriptId,
    title: opts.title,
    stage1,
    chapter: { id: opts.chapterId, title: `Chapter ${opts.chapterId}`, body: opts.truth.chapterText },
    stageCall: opts.stageCall,
    escalationAnalyzer: opts.escalationAnalyzer ?? null,
    onStages: (s) => { stages = s; },
  }); // no `as never` — the opts object is fully typed, so `s` gets its proper type

  // `reasons` align 1:1 to the deterministic snapshot; reused for the final stage
  // because escalation changes ids on already-flagged lines but not the evidence class.
  const reasons = stages!.reasons;
  return {
    fixture: opts.fixtureName ?? `chapter-${opts.chapterId}`,
    raw: scoreStage(opts.truth, stages!.raw),
    deterministic: scoreStage(opts.truth, stages!.deterministic, reasons),
    final: scoreStage(opts.truth, result.sentences, reasons),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/attribution-eval/run-eval.ts server/src/analyzer/attribution-eval/run-eval.test.ts
git commit -m "feat(server): attribution-eval runner core (three-stage scoring)"
```

---

## Task 8: Runner CLI + orchestrator + Coalfall roster + npm script

**Files:**
- Create: `server/src/analyzer/attribution-eval/run-eval-cli.ts`
- Create: `scripts/run-attribution-eval.mjs`
- Create: `server/src/analyzer/attribution-eval/__fixtures__/coalfall.roster.json`
- Modify: root `package.json` (`eval:attribution` script)
- Test: `server/src/analyzer/attribution-eval/run-eval-cli.test.ts`

**Interfaces:**
- Consumes: `evalFixture` (Task 7); `parseLabelledChapter` (`./schema.js`); `parseRosterSnapshot` (`./roster-schema.js`); `selectAnalyzer` (`../index.js`) or direct `OllamaAnalyzer`/`GeminiAnalyzer` constructors; env `GEMINI_API_KEY`.
- Produces: `loadCorpus(corpusDir): Array<{ name; truth; roster; chapterId }>` (pairs `*.labelled.json` with the matching `<slug>.roster.json`); `runEval(opts: { engines: Array<'qwen'|'gemma'>; corpusDir?: string }): Promise<{ skipped: string | null; results: ... }>` — returns `skipped` reason (no corpus / engine unreachable / no key) so the CLI prints a SKIP banner and exits 0; a `main()` printing the scorecard.

- [ ] **Step 1: Write the failing test** — assert the gate: with an empty corpus dir, `runEval` returns `{ skipped: 'no corpus fixtures', ... }` (never throws).

```ts
// run-eval-cli.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval } from './run-eval-cli.js';

describe('runEval gating', () => {
  it('SKIPs cleanly when the corpus dir is empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-corpus-'));
    const res = await runEval({ engines: ['qwen'], corpusDir: empty });
    expect(res.skipped).toMatch(/no corpus/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval-cli.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement CLI** (gating first; Coalfall roster + scorecard formatting)

Escalation is controlled by the existing `ATTRIBUTION_ESCALATION` env/registry knob (`off|local|cloud`), NOT a new CLI flag — `--escalation off` would just duplicate it. Set `ATTRIBUTION_ESCALATION=off` to skip the second (cloud) pass while iterating.

```ts
// run-eval-cli.ts
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLabelledChapter, type LabelledChapter } from './schema.js';
import { parseRosterSnapshot, type RosterSnapshot } from './roster-schema.js';
import { evalFixture, type FixtureResult } from './run-eval.js';
import { OllamaAnalyzer } from '../ollama.js';
import { GeminiAnalyzer } from '../gemini.js';
import type { Analyzer } from '../index.js';

const DEFAULT_CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url));
const COMMITTED = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

// Fixture: <slug>-ch<NN>.<lang>.labelled.json ; roster (per book): <slug>.roster.json
const FIXTURE_RE = /^(.+)-ch(\d+)\.([a-z]{2})\.labelled\.json$/;

interface CorpusItem {
  name: string; truth: LabelledChapter; roster: RosterSnapshot; chapterId: number; lang: string;
}

async function loadDir(dir: string): Promise<CorpusItem[]> {
  let files: string[] = [];
  try { files = await readdir(dir); } catch { return []; }
  const out: CorpusItem[] = [];
  for (const f of files) {
    const m = FIXTURE_RE.exec(f);
    if (!m) continue;
    const [, slug, chap, lang] = m;
    const truth = parseLabelledChapter(JSON.parse(await readFile(join(dir, f), 'utf8')));
    const roster = parseRosterSnapshot(JSON.parse(await readFile(join(dir, `${slug}.roster.json`), 'utf8')));
    out.push({ name: f, truth, roster, chapterId: Number(chap), lang });
  }
  return out;
}

export async function loadCorpus(dir: string): Promise<CorpusItem[]> { return loadDir(dir); }

async function buildAnalyzer(engine: 'qwen' | 'gemma'): Promise<Analyzer | null> {
  if (engine === 'qwen') {
    const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
    } catch { return null; }
    return new OllamaAnalyzer({ url, model: process.env.EVAL_QWEN_MODEL ?? 'qwen3.5:9b' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GeminiAnalyzer({ apiKey, model: process.env.GEMINI_MODEL ?? 'gemma-4-31b-it' });
}

export async function runEval(opts: { engines: Array<'qwen' | 'gemma'>; corpusDir?: string }) {
  const corpus = await loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS);
  if (corpus.length === 0) {
    return { skipped: 'no corpus fixtures found', results: [] as Array<{ engine: string; fixtures: FixtureResult[] }> };
  }
  const all = [...corpus, ...(await loadDir(COMMITTED))]; // + committed Coalfall guardrail

  const results: Array<{ engine: string; fixtures: FixtureResult[] }> = [];
  for (const engine of opts.engines) {
    const analyzer = await buildAnalyzer(engine);
    if (!analyzer) return { skipped: `engine ${engine} unavailable (Ollama down / no GEMINI_API_KEY)`, results: [] };
    const fixtures: FixtureResult[] = [];
    for (const c of all) {
      fixtures.push(await evalFixture({
        analyzer,
        manuscriptId: `eval-${c.name}`,
        title: c.name,
        truth: c.truth,
        roster: c.roster,
        chapterId: c.chapterId,
        stageCall: { language: c.lang } as never,
        fixtureName: c.name,
      }));
    }
    results.push({ engine, fixtures });
  }
  return { skipped: null, results };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printScorecard(results: Array<{ engine: string; fixtures: FixtureResult[] }>): void {
  for (const { engine, fixtures } of results) {
    console.log(`\n=== engine: ${engine} ===`);
    for (const f of fixtures) {
      console.log(`  ${f.fixture}: raw ${pct(f.raw.recall)} → det ${pct(f.deterministic.recall)} → final ${pct(f.final.recall)} (n=${f.final.total}, seg-drift ${f.final.segMismatch})`);
      for (const fam of Object.keys(f.final.byFamily).sort()) {
        const b = f.final.byFamily[fam];
        console.log(`      ${fam}: ${b.correct}/${b.total}`);
      }
    }
  }
}

function parseEngines(argv: string[]): Array<'qwen' | 'gemma'> {
  const i = argv.indexOf('--engine');
  const v = i >= 0 ? argv[i + 1] : 'both';
  if (v === 'qwen') return ['qwen'];
  if (v === 'gemma') return ['gemma'];
  return ['qwen', 'gemma'];
}

async function main(): Promise<void> {
  const { skipped, results } = await runEval({ engines: parseEngines(process.argv.slice(2)) });
  if (skipped) { console.log(`[SKIP] attribution eval: ${skipped}`); process.exit(0); }
  printScorecard(results);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Create the committed Coalfall roster**

Read `__fixtures__/coalfall-ch1.en.labelled.json`, collect its distinct `speakerId`s, and hand-author `__fixtures__/coalfall.roster.json` with an entry per speaker:
```json
{
  "characters": [
    { "id": "narrator", "name": "Narrator" },
    { "id": "oduvan", "name": "Oduvan", "gender": "male" }
  ]
}
```
(One entry per distinct speakerId in the labelled fixture; gender from the Coalfall manuscript. Castwright-owned → safe to commit.)

- [ ] **Step 5: Create the orchestrator + npm script**

`scripts/run-attribution-eval.mjs` (mirrors `scripts/run-golden-audio.mjs`'s spawn+exit pattern):
```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
const res = spawnSync(
  'npx',
  ['tsx', 'server/src/analyzer/attribution-eval/run-eval-cli.ts', ...flags],
  { stdio: 'inherit', cwd: ROOT, shell: true },
);
process.exit(res.status ?? 1);
```

Add to root `package.json` "scripts":
```json
"eval:attribution": "node scripts/run-attribution-eval.mjs",
```

- [ ] **Step 6: Run tests + smoke the gate**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/run-eval-cli.test.ts`
Expected: PASS.
Run (from repo root, no corpus present): `npm run eval:attribution`
Expected: prints a SKIP banner ("no corpus fixtures found") and exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/attribution-eval/run-eval-cli.ts server/src/analyzer/attribution-eval/run-eval-cli.test.ts server/src/analyzer/attribution-eval/__fixtures__/coalfall.roster.json scripts/run-attribution-eval.mjs package.json
git commit -m "feat(server): attribution-eval runner CLI + Coalfall guardrail + npm script"
```

---

## Task 9: Whole-book before/after diff (spec §3.7)

**Files:**
- Create: `server/src/analyzer/attribution-eval/diff-runs.ts`
- Test: `server/src/analyzer/attribution-eval/diff-runs.test.ts`

**Interfaces:**
- Consumes: `SentenceOutput` (`../../handoff/schemas.js`).
- Produces: `diffRuns(baseline: SentenceOutput[], tuned: SentenceOutput[]): { lowConfDelta: number; changed: Array<{ id: number; chapterId: number; text: string; from: string; to: string }> }` — compares two full-book attribution result sets by sentence `id`; `lowConfDelta` = (# tuned with `confidence < 0.75`) − (# baseline `< 0.75`); `changed` lists sentences whose `characterId` differs.

- [ ] **Step 1: Write the failing test**

```ts
// diff-runs.test.ts
import { describe, it, expect } from 'vitest';
import { diffRuns } from './diff-runs.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

const base: SentenceOutput[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A', confidence: 0.9 },
  { id: 2, chapterId: 1, characterId: 'alice', text: 'B', confidence: 0.5 },
];
const tuned: SentenceOutput[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A', confidence: 0.9 },
  { id: 2, chapterId: 1, characterId: 'bob', text: 'B', confidence: 0.95 },
];

describe('diffRuns', () => {
  it('reports low-confidence delta and changed attributions', () => {
    const d = diffRuns(base, tuned);
    expect(d.lowConfDelta).toBe(-1); // one fewer low-conf line
    expect(d.changed).toEqual([{ id: 2, chapterId: 1, text: 'B', from: 'alice', to: 'bob' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/diff-runs.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// diff-runs.ts
import type { SentenceOutput } from '../../handoff/schemas.js';

const LOW = 0.75;

export function diffRuns(baseline: SentenceOutput[], tuned: SentenceOutput[]) {
  const lowCount = (arr: SentenceOutput[]) => arr.filter((s) => (s.confidence ?? 1) < LOW).length;
  const byId = new Map(baseline.map((s) => [s.id, s]));
  const changed = [];
  for (const t of tuned) {
    const b = byId.get(t.id);
    if (b && b.characterId !== t.characterId) {
      changed.push({ id: t.id, chapterId: t.chapterId, text: t.text, from: b.characterId, to: t.characterId });
    }
  }
  return { lowConfDelta: lowCount(tuned) - lowCount(baseline), changed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/attribution-eval/diff-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/attribution-eval/diff-runs.ts server/src/analyzer/attribution-eval/diff-runs.test.ts
git commit -m "feat(server): whole-book baseline-vs-tuned attribution diff"
```

---

## Task 10: Regression plan doc + typecheck gate

**Files:**
- Create: `docs/features/<nn>-attribution-eval-tuning.md` (from `docs/features/TEMPLATE.md`; frontmatter `status: active`; link the spec `docs/superpowers/specs/2026-07-20-attribution-eval-tuning-design.md`).
- Modify: `docs/features/INDEX.md` (new entry under the analyzer area).

- [ ] **Step 1: Write the regression plan** — document the invariants (opt-in/gated, roster-pinning prevents ID drift, three-point metric, Coalfall guardrail) and the manual acceptance walkthrough (`capture --book <PwF> --chapters 43,44,45,46` → `eval:attribution --engine qwen`).

- [ ] **Step 2: Typecheck the whole change**

Run: `npm run typecheck`
Expected: PASS (no type errors across the new files + the two additive edits).

- [ ] **Step 3: Run the full attribution-eval suite**

Run: `cd server && npx vitest run src/analyzer/attribution-eval src/analyzer/dialogue-structure/cross-examine-reasons.test.ts src/routes/attribute-chapter-stages.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/features/
git commit -m "docs(server): regression plan for attribution eval + tuning loop"
```

---

## Self-Review

- **Spec coverage:** capture (§3.1) → Tasks 2–3; roster snapshot + pinning (§3.1, §3.3) → Tasks 1, 3, 7; three-point metric (§3.4) → Tasks 5, 7; evidence buckets (§3.4) → Tasks 4, 6, 7; eval seam (§3.5) → Tasks 4, 5; Coalfall guardrail (§3.2) → Task 8; whole-book before/after (§3.7) → Task 9; gating/opt-in (§3) → Tasks 3, 8; tests (§5) → every task; corpus copyright (§4) → Task 3 gitignore. All spec sections mapped.
- **Metric denominator** is explicit (`recall = TP/(TP+FN)`, `segMismatch` separate) per spec §3.4.
- **Deferred to follow-up (per spec §2):** script-review tuning; dynamic few-shot injection. Not tasked — correct.
- **Known cross-task edit:** Task 7 extends the Task-5 `onStages` payload with `reasons`; called out explicitly in Task 7 so it isn't a hidden dependency.
