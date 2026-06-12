# Per-book bulk emotion-variant design + cast-table variant glyphs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user design every *needed* Qwen emotion variant for a book's cast in one action (a scope picker on the existing "Design full cast" button), and show per-emotion designed/needed status as glyphs in the cast table instead of a bare count.

**Architecture:** Reuse the existing server-owned, reload-resilient bulk-design job (`server/src/routes/cast-design.ts`). Generalize its work unit from "character id" to "design task" (`{ characterId, emotion? }`). The frontend computes the demand-driven work-list (it already derives demand via `usedEmotionsByCharacter` + `countMissingVariants`) and passes `scope` + `variantTasks` to the job. Variant persistence is book-scoped via a helper extracted from the single-design route. The cast table gains a demand-driven glyph strip on a second Status-column line, superseding the variant count badge + "N tags need a variant" hint.

**Tech Stack:** TypeScript, Express (server), React 18 + Redux Toolkit (frontend), Vitest (unit), Playwright (e2e). Spec: `docs/superpowers/specs/2026-06-09-cast-bulk-emotion-variants-design.md`.

---

## File Structure

**Server**
- Modify `server/src/routes/qwen-voice.ts` — extract `persistEmotionVariant()`; refactor the single-design route to use it.
- Modify `server/src/routes/cast-design.ts` — accept `scope` + `variantTasks`; build a unified task list; design variants; emit `variant_designed`.
- Test `server/src/routes/qwen-voice.test.ts` (or existing), `server/src/routes/cast-design.test.ts`.

**API client**
- Modify `src/lib/api.ts` — `startCastDesign` payload (`scope`, `variantTasks`); `CastDesignCallbacks.onVariantDesigned`; parse `variant_designed`; mock parity.
- Test `src/lib/api.test.ts` (or the cast-design API test file if one exists; otherwise add to `src/lib/api.test.ts`).

**Redux**
- Modify `src/store/cast-design-slice.ts` — `DesignAllRequestedPayload` gains `scope` + `variantTasks`.
- Modify `src/store/cast-design-stream-middleware.ts` — pass new payload; wire `onVariantDesigned`.
- Test `src/store/cast-design-slice.test.ts`, `src/store/cast-design-stream-middleware.test.ts`.

**Frontend — work-list + scope picker**
- Create `src/lib/variant-tasks.ts` — `buildVariantTasks()` + `variantWorkCounts()`.
- Create `src/components/design-scope-picker.tsx` — the popover.
- Modify `src/views/cast.tsx` — open the picker; dispatch with scope/variantTasks.
- Test `src/lib/variant-tasks.test.ts`, `src/components/design-scope-picker.test.tsx`, `src/views/cast.test.tsx`.

**Frontend — glyph strip (Part A)**
- Create `src/components/variant-glyph-strip.tsx` — the demand-driven strip.
- Modify `src/views/cast.tsx` `StatusPill` — render the strip on line 2; drop the count badge + text hint there.
- Test `src/components/variant-glyph-strip.test.tsx`, `src/views/cast.test.tsx`.

**E2E + docs**
- Create `e2e/cast-variant-design.spec.ts`.
- Create `docs/features/NNN-cast-bulk-emotion-variants.md`; update `docs/features/INDEX.md` + `docs/BACKLOG.md` (fe-32 row).

---

## Phase 1 — Server: variant persistence helper

### Task 1: Extract `persistEmotionVariant` (book-scoped) and reuse it in the single route

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (add export; refactor route at ~L439-445)
- Test: `server/src/routes/qwen-voice.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/qwen-voice.test.ts` (create the file if absent, mirroring the existing route-test setup — `import { persistEmotionVariant } from './qwen-voice.js';`). Use a temp book dir with a `cast.json`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistEmotionVariant } from './qwen-voice.js';

describe('persistEmotionVariant', () => {
  let bookDir: string;
  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), 'cast-'));
    await mkdir(bookDir, { recursive: true });
    await writeFile(
      join(bookDir, 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'wren', voiceId: 'wren', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } },
        ],
      }),
    );
  });
  afterEach(async () => {
    await rm(bookDir, { recursive: true, force: true });
  });

  it('records the variant slot without clobbering the base name', async () => {
    await persistEmotionVariant(bookDir, 'wren', 'angry', 'qwen-wren__angry');
    const cast = JSON.parse(await readFile(join(bookDir, 'cast.json'), 'utf8'));
    expect(cast.characters[0].overrideTtsVoices.qwen.name).toBe('qwen-wren');
    expect(cast.characters[0].overrideTtsVoices.qwen.variants.angry).toEqual({
      name: 'qwen-wren__angry',
    });
  });

  it('preserves a sibling variant when adding another', async () => {
    await persistEmotionVariant(bookDir, 'wren', 'angry', 'qwen-wren__angry');
    await persistEmotionVariant(bookDir, 'wren', 'sad', 'qwen-wren__sad');
    const cast = JSON.parse(await readFile(join(bookDir, 'cast.json'), 'utf8'));
    expect(Object.keys(cast.characters[0].overrideTtsVoices.qwen.variants).sort()).toEqual([
      'angry',
      'sad',
    ]);
  });

  it('is a no-op for an unknown character', async () => {
    await persistEmotionVariant(bookDir, 'ghost', 'angry', 'x');
    const cast = JSON.parse(await readFile(join(bookDir, 'cast.json'), 'utf8'));
    expect(cast.characters[0].overrideTtsVoices.qwen.variants).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t persistEmotionVariant`
Expected: FAIL — `persistEmotionVariant is not a function` / import error.

- [ ] **Step 3: Implement the helper**

In `server/src/routes/qwen-voice.ts`, add near the other helpers (after `buildVariantInstruct`):

```ts
/* fs-25 / fe-32 — record a designed emotion variant onto a character's qwen
   slot in the BOOK's cast.json. Book-scoped (the base voiceId is already
   series-unified so the `.pt` is reusable, but the slot is recorded per book).
   Preserves the base `name` (defaulting it to the derived base id when the slot
   is fresh) and any sibling variants. No-op for an unknown character. Shared by
   the single design-voice route and the bulk "Design full cast" job. */
export async function persistEmotionVariant(
  bookDir: string,
  characterId: string,
  emotion: Exclude<Emotion, 'neutral'>,
  variantVoiceId: string,
): Promise<void> {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const character = cast?.characters?.find((c) => c.id === characterId);
  if (!cast || !character) return;
  const baseVoiceId = deriveQwenVoiceId(character, characterId);
  character.overrideTtsVoices = character.overrideTtsVoices ?? {};
  const qwenSlot = character.overrideTtsVoices.qwen ?? { name: baseVoiceId };
  qwenSlot.variants = { ...(qwenSlot.variants ?? {}), [emotion]: { name: variantVoiceId } };
  character.overrideTtsVoices.qwen = qwenSlot;
  await writeJsonAtomic(castJsonPath(bookDir), cast);
}
```

- [ ] **Step 4: Refactor the single-design route to use it**

Replace the inline block at `server/src/routes/qwen-voice.ts` ~L439-445:

```ts
      if (emotion && body.preview !== true) {
        character.overrideTtsVoices = character.overrideTtsVoices ?? {};
        const qwenSlot = character.overrideTtsVoices.qwen ?? { name: baseVoiceId };
        qwenSlot.variants = { ...(qwenSlot.variants ?? {}), [emotion]: { name: voiceId } };
        character.overrideTtsVoices.qwen = qwenSlot;
        await writeJsonAtomic(castJsonPath(bookDir), cast);
      }
```

with:

```ts
      if (emotion && body.preview !== true) {
        await persistEmotionVariant(bookDir, characterId, emotion, voiceId);
      }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: PASS (all three new cases). If the route test file already had cases, they stay green.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "refactor(server): extract book-scoped persistEmotionVariant; reuse in single design"
```

---

## Phase 2 — Server: variant tasks in the bulk job

### Task 2: Generalize the bulk job to a unified task list with `scope` + `variantTasks`

**Files:**
- Modify: `server/src/routes/cast-design.ts`
- Test: `server/src/routes/cast-design.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/cast-design.test.ts`. The existing tests start a job via supertest against the router; mirror their setup. Add a test that drives a `variants` scope and asserts the variant is persisted and a `variant_designed` event is emitted. (Use the existing harness's sidecar mock — the design core is mocked there; reuse that mock to return a deterministic voiceId.)

```ts
it('scope:variants designs each task emotion and persists the slot', async () => {
  // ARRANGE: a confirmed book whose cast has a base voice but no variants.
  const { bookId, bookDir } = await seedConfirmedBook({
    characters: [
      { id: 'wren', voiceId: 'wren', ttsEngine: 'qwen',
        voiceStyle: 'warm, bright', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } },
    ],
  });

  // ACT: start a variants-scope job for wren:angry and read the SSE to completion.
  const events = await runDesignJobToCompletion(bookId, {
    modelKey: 'qwen-base',
    scope: 'variants',
    characterIds: [],
    variantTasks: [{ characterId: 'wren', emotions: ['angry'] }],
  });

  // ASSERT: a variant_designed event fired and the slot is on disk.
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'variant_designed', characterId: 'wren', emotion: 'angry' }),
  );
  const cast = await readCastJson(bookDir);
  expect(cast.characters[0].overrideTtsVoices.qwen.variants.angry).toBeTruthy();
});

it('scope:variants skips a variant whose base is missing', async () => {
  const { bookId } = await seedConfirmedBook({
    characters: [{ id: 'brann', voiceId: 'brann', ttsEngine: 'qwen' }], // no qwen.name = no base
  });
  const events = await runDesignJobToCompletion(bookId, {
    modelKey: 'qwen-base',
    scope: 'variants',
    characterIds: [],
    variantTasks: [{ characterId: 'brann', emotions: ['angry'] }],
  });
  expect(events).toContainEqual(expect.objectContaining({ type: 'character_skipped' }));
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'variant_designed' }));
});

it('scope:both designs base then its variants for one character', async () => {
  const { bookId } = await seedConfirmedBook({
    characters: [{ id: 'marlow', voiceId: 'marlow', ttsEngine: 'qwen', voiceStyle: 'sly' }],
  });
  const events = await runDesignJobToCompletion(bookId, {
    modelKey: 'qwen-base',
    scope: 'both',
    characterIds: ['marlow'],
    variantTasks: [{ characterId: 'marlow', emotions: ['whisper'] }],
  });
  const order = events.filter((e) => e.type === 'character_designed' || e.type === 'variant_designed')
    .map((e) => e.type);
  expect(order).toEqual(['character_designed', 'variant_designed']);
});
```

> If `seedConfirmedBook` / `runDesignJobToCompletion` / `readCastJson` helpers don't exist in the test file, add small local helpers following the existing tests' supertest + temp-workspace pattern (the file already builds a book dir and POSTs to `/:bookId/cast/design`; factor those into the helpers). Each helper is ≤15 lines.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts -t variants`
Expected: FAIL — the job ignores `variantTasks`; no `variant_designed` event.

- [ ] **Step 3: Implement — task model + route parsing**

In `server/src/routes/cast-design.ts`:

a) Add the task type + imports near the top (after the existing imports):

```ts
import type { Emotion } from '../handoff/schemas.js';
import { VARIANT_EMOTIONS, persistEmotionVariant } from './qwen-voice.js';

type DesignScope = 'bases' | 'variants' | 'both';
interface VariantTask {
  characterId: string;
  emotions: Exclude<Emotion, 'neutral'>[];
}
/** One unit of work for the serial loop: a base voice (no emotion) or a variant. */
interface DesignTask {
  characterId: string;
  emotion?: Exclude<Emotion, 'neutral'>;
}
```

b) In the POST handler, after `characterIds` is parsed, also parse `scope` + `variantTasks` and build the unified task list. Replace the start-detection + validation block so `isStart` covers a variants-only start (where `characterIds` is empty but `variantTasks` is non-empty):

```ts
  const scope: DesignScope =
    body.scope === 'variants' || body.scope === 'both' ? body.scope : 'bases';
  const variantTasks: VariantTask[] = Array.isArray(body.variantTasks)
    ? (body.variantTasks as unknown[])
        .map((t) => t as { characterId?: unknown; emotions?: unknown })
        .filter(
          (t): t is VariantTask =>
            typeof t.characterId === 'string' &&
            Array.isArray(t.emotions) &&
            t.emotions.every(
              (e) => typeof e === 'string' && (VARIANT_EMOTIONS as string[]).includes(e),
            ),
        )
        .map((t) => ({ characterId: t.characterId, emotions: t.emotions as VariantTask['emotions'] }))
    : [];

  const hasWork =
    (characterIds !== null && characterIds.length > 0) ||
    (scope !== 'bases' && variantTasks.length > 0);
```

Update the `isStart` line to: `const isStart = hasWork && !existing;`

c) Build the ordered task list (base-before-variant per character for `both`), and pass it to `runDesignJob`. Replace the `total: characterIds!.length` and the `runDesignJob(job, characterIds!, …)` call:

```ts
  const tasks: DesignTask[] = buildTaskList(scope, characterIds ?? [], variantTasks);
  // …
  total: tasks.length,
  // …
  void runDesignJob(job, tasks, modelKey!, language, seriesFilter).catch((e) => { … });
```

And add the builder (module scope):

```ts
/** bases → base task per id; variants → one task per (char, emotion); both →
    for each character, its base (if requested) then its variant emotions, so a
    just-designed base is in place before its variants run. */
function buildTaskList(
  scope: DesignScope,
  characterIds: string[],
  variantTasks: VariantTask[],
): DesignTask[] {
  if (scope === 'bases') return characterIds.map((id) => ({ characterId: id }));
  if (scope === 'variants')
    return variantTasks.flatMap((t) => t.emotions.map((e) => ({ characterId: t.characterId, emotion: e })));
  // both
  const variantsById = new Map(variantTasks.map((t) => [t.characterId, t.emotions]));
  const ids = [...new Set([...characterIds, ...variantTasks.map((t) => t.characterId)])];
  const out: DesignTask[] = [];
  for (const id of ids) {
    if (characterIds.includes(id)) out.push({ characterId: id });
    for (const e of variantsById.get(id) ?? []) out.push({ characterId: id, emotion: e });
  }
  return out;
}
```

- [ ] **Step 4: Implement — the loop handles variant tasks**

Change `runDesignJob`'s signature to take `tasks: DesignTask[]` and branch per task. Replace the `for (const characterId of characterIds)` body's core. Base path is unchanged; add the variant branch:

```ts
async function runDesignJob(
  job: DesignJob,
  tasks: DesignTask[],
  modelKey: TtsModelKey,
  language: string,
  seriesFilter: { author: string; series: string } | undefined,
): Promise<void> {
  for (const task of tasks) {
    if (job.controller.signal.aborted) break;
    const { characterId, emotion } = task;

    const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      job.skipped += 1;
      broadcast(job, { type: 'character_skipped', characterId });
      continue;
    }

    // Freshness — base vs variant.
    if (!emotion) {
      if (character.overrideTtsVoices?.qwen?.name) {
        job.skipped += 1;
        broadcast(job, { type: 'character_skipped', characterId });
        continue;
      }
    } else {
      const baseName = character.overrideTtsVoices?.qwen?.name;
      const already = character.overrideTtsVoices?.qwen?.variants?.[emotion];
      if (!baseName || already) {
        // No base yet (can't design a variant) OR variant already designed.
        job.skipped += 1;
        broadcast(job, { type: 'character_skipped', characterId });
        continue;
      }
    }

    job.currentCharacterId = characterId;
    job.currentName = character.name ?? characterId;
    broadcast(job, {
      type: 'progress',
      characterId,
      name: job.currentName,
      done: job.done,
      total: job.total,
    });

    const heartbeat = setInterval(() => broadcast(job, { type: 'heartbeat', characterId }), HEARTBEAT_MS);
    try {
      let persona = (character.voiceStyle ?? '').trim();
      if (!persona) {
        persona = await generateVoiceStylePersona(character);
        const fresh = await readJson<CastFile>(castJsonPath(job.bookDir));
        const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
        if (fresh && idx !== -1) {
          fresh.characters[idx] = { ...fresh.characters[idx], voiceStyle: persona };
          await writeJsonAtomic(castJsonPath(job.bookDir), fresh);
        }
      }

      const sampleVoiceId = emotion
        ? `${character.voiceId ?? `char-${characterId}`}__${emotion}`
        : (character.voiceId ?? `char-${characterId}`);
      const { voiceId } = await designQwenVoiceForCharacter({
        bookDir: job.bookDir,
        character,
        characterId,
        persona,
        sampleVoiceId,
        modelKey,
        language,
        emotion,
        signal: job.controller.signal,
      });

      if (!emotion) {
        const matchKey = character.voiceId ?? character.id;
        await applyOverrideToCastFiles(matchKey, { engine: 'qwen', name: voiceId }, seriesFilter);
        job.done += 1;
        broadcast(job, { type: 'character_designed', characterId, voiceId });
      } else {
        await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId);
        job.done += 1;
        broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId });
      }
    } catch (e) {
      const message = (e as Error).message || 'Voice design failed.';
      if (/unreachable|did not complete within|stopped responding/i.test(message)) {
        clearInterval(heartbeat);
        endJob(job, { type: 'error', code: 'sidecar_unavailable', message });
        return;
      }
      job.failures.push({ characterId, name: character.name ?? characterId, error: message });
      broadcast(job, {
        type: 'character_failed',
        characterId,
        name: character.name ?? characterId,
        errorReason: message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  job.currentCharacterId = null;
  job.currentName = null;
  endJob(job, { type: 'idle', done: job.done, total: job.total, skipped: job.skipped, failures: job.failures });
}
```

Also widen the `body` cast at the top of the POST handler to include the new fields:

```ts
  const body = (req.body ?? {}) as {
    characterIds?: unknown;
    modelKey?: unknown;
    scope?: unknown;
    variantTasks?: unknown;
  };
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/routes/cast-design.test.ts`
Expected: PASS — including the three new cases and all pre-existing base-only cases (the `bases` scope path is behaviourally identical to today).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "feat(server): bulk-design accepts scope + variantTasks; designs needed emotion variants"
```

---

## Phase 3 — API client

### Task 3: `startCastDesign` payload + `onVariantDesigned` + parse `variant_designed`

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/api.test.ts` a parser test for the new event (the file already exercises `readCastDesignStream` via a fake `Response`; mirror that). If no such harness exists, test the mock path instead:

```ts
it('startCastDesign forwards scope + variantTasks in the POST body', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('data: {"type":"idle","done":0,"total":0,"skipped":0,"failures":[]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  await realStartCastDesign(
    'book-1',
    { characterIds: ['a'], modelKey: 'qwen-base', scope: 'both',
      variantTasks: [{ characterId: 'a', emotions: ['angry'] }] },
    {},
  );
  const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
  expect(body).toMatchObject({
    characterIds: ['a'], modelKey: 'qwen-base', scope: 'both',
    variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
  });
  fetchSpy.mockRestore();
});

it('readCastDesignStream maps variant_designed to onVariantDesigned', async () => {
  const got: unknown[] = [];
  const res = new Response(
    'data: {"type":"variant_designed","characterId":"a","emotion":"angry","voiceId":"qwen-a__angry"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
  await readCastDesignStream(res, { onVariantDesigned: (e) => got.push(e) });
  expect(got).toEqual([{ characterId: 'a', emotion: 'angry', voiceId: 'qwen-a__angry' }]);
});
```

> `realStartCastDesign` / `readCastDesignStream` are module-internal. If the test file can't import them, export them via the existing test-only export pattern in `api.ts`, or assert through `api.startCastDesign`. Check how other internal fns in `api.test.ts` are reached and follow that.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/api.test.ts -t variant_designed`
Expected: FAIL — `onVariantDesigned` not called; body lacks `scope`/`variantTasks`.

- [ ] **Step 3: Implement — types + payload + parser + mock**

a) Add to `CastDesignCallbacks` (after `onCharacterDesigned`):

```ts
  /** fe-32 — a designed emotion VARIANT was persisted (bulk job). */
  onVariantDesigned?: (e: { characterId: string; emotion: Emotion; voiceId: string }) => void;
```

b) Add to `CastDesignStreamEvent`: `emotion?: Emotion;` (it already has `characterId`, `voiceId`).

c) In `readCastDesignStream`'s `handle` switch, add a case:

```ts
      case 'variant_designed':
        if (
          typeof e.characterId === 'string' &&
          typeof e.emotion === 'string' &&
          typeof e.voiceId === 'string'
        )
          cb.onVariantDesigned?.({ characterId: e.characterId, emotion: e.emotion as Emotion, voiceId: e.voiceId });
        break;
```

d) Widen `realStartCastDesign`'s signature + body:

```ts
async function realStartCastDesign(
  bookId: string,
  { characterIds, modelKey, scope, variantTasks }: {
    characterIds: string[];
    modelKey: string;
    scope?: 'bases' | 'variants' | 'both';
    variantTasks?: { characterId: string; emotions: Emotion[] }[];
  },
  cb: CastDesignCallbacks,
): Promise<void> {
  // …existing fetch, but:
  body: JSON.stringify({ characterIds, modelKey, scope, variantTasks }),
```

e) Update `mockStartCastDesign`'s signature to accept the same args; for any `variantTasks`, emit a `variant_designed` per emotion so the mock UI flips glyphs:

```ts
async function mockStartCastDesign(
  _bookId: string,
  { characterIds, scope, variantTasks }: {
    characterIds: string[]; modelKey: string;
    scope?: 'bases' | 'variants' | 'both';
    variantTasks?: { characterId: string; emotions: Emotion[] }[];
  },
  cb: CastDesignCallbacks,
): Promise<void> {
  const baseIds = scope === 'variants' ? [] : characterIds;
  const vTasks = scope === 'bases' ? [] : (variantTasks ?? []);
  const total = baseIds.length + vTasks.reduce((n, t) => n + t.emotions.length, 0);
  let done = 0;
  for (const characterId of baseIds) {
    cb.onProgress?.({ characterId, name: characterId, done, total });
    cb.onCharacterDesigned?.({ characterId, voiceId: `qwen-${characterId}` });
    done += 1;
  }
  for (const t of vTasks) {
    for (const emotion of t.emotions) {
      cb.onProgress?.({ characterId: t.characterId, name: t.characterId, done, total });
      cb.onVariantDesigned?.({ characterId: t.characterId, emotion, voiceId: `qwen-${t.characterId}__${emotion}` });
      done += 1;
    }
  }
  cb.onIdle?.({ done, total, skipped: 0, failures: [] });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): cast-design API carries scope/variantTasks + onVariantDesigned"
```

---

## Phase 4 — Redux wiring

### Task 4: Slice payload + middleware wiring for variants

**Files:**
- Modify: `src/store/cast-design-slice.ts` (`DesignAllRequestedPayload`)
- Modify: `src/store/cast-design-stream-middleware.ts`
- Test: `src/store/cast-design-stream-middleware.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/store/cast-design-stream-middleware.test.ts` (it already stubs `api.startCastDesign` and asserts dispatches). Two cases:

```ts
it('passes scope + variantTasks through to api.startCastDesign', async () => {
  const startSpy = vi.spyOn(api, 'startCastDesign').mockResolvedValue();
  const store = makeStore(); // existing test helper
  store.dispatch(castDesignActions.designAllRequested({
    bookId: 'b', characterIds: ['a'], modelKey: 'qwen-base',
    scope: 'both', variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
  }));
  await flushPromises();
  expect(startSpy).toHaveBeenCalledWith(
    'b',
    expect.objectContaining({ scope: 'both', variantTasks: [{ characterId: 'a', emotions: ['angry'] }] }),
    expect.anything(),
  );
});

it('onVariantDesigned mirrors the variant into the cast slice and bumps done', async () => {
  // Drive the callbacks object the middleware builds: stub startCastDesign to
  // invoke cb.onVariantDesigned then cb.onIdle.
  vi.spyOn(api, 'startCastDesign').mockImplementation(async (_b, _a, cb) => {
    cb.onVariantDesigned?.({ characterId: 'a', emotion: 'angry', voiceId: 'qwen-a__angry' });
    cb.onIdle?.({ done: 1, total: 1, skipped: 0, failures: [] });
  });
  const store = makeStore();
  // seed a character so setCharacterEmotionVariant has a target
  store.dispatch(castActions.hydrate?.({ characters: [{ id: 'a', name: 'A' }] }) ?? { type: 'noop' });
  store.dispatch(castDesignActions.designAllRequested({
    bookId: 'b', characterIds: [], modelKey: 'qwen-base',
    scope: 'variants', variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
  }));
  await flushPromises();
  const c = store.getState().cast.characters.find((x) => x.id === 'a');
  expect(c?.overrideTtsVoices?.qwen?.variants?.angry).toEqual({ name: 'qwen-a__angry' });
});
```

> Use the test file's existing store/flush helpers; adapt the seeding line to however the cast slice is hydrated in that file. If `designAllRequested` is dispatched with empty `characterIds`, ensure the middleware's start guard (below) allows a variants-only start.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/store/cast-design-stream-middleware.test.ts -t variant`
Expected: FAIL — payload type rejects `scope`/`variantTasks`; `onVariantDesigned` unwired; empty `characterIds` start is dropped.

- [ ] **Step 3: Implement — slice payload type**

In `src/store/cast-design-slice.ts`, extend `DesignAllRequestedPayload`:

```ts
export interface DesignAllRequestedPayload {
  bookId: string;
  characterIds: string[];
  modelKey: string;
  /** fe-32 — design scope. Default 'bases' keeps today's behaviour. */
  scope?: 'bases' | 'variants' | 'both';
  /** fe-32 — demand-driven variant work-list (used for 'variants'/'both'). */
  variantTasks?: { characterId: string; emotions: string[] }[];
}
```

- [ ] **Step 4: Implement — middleware**

In `src/store/cast-design-stream-middleware.ts`:

a) In `buildCallbacks`, add the variant handler (after `onCharacterDesigned`):

```ts
      onVariantDesigned: ({ characterId, emotion, voiceId }) => {
        dispatch(castActions.setCharacterEmotionVariant({ characterId, emotion, voiceId }));
        dispatch(castDesignActions.charDone({ bookId, lastTickAt: Date.now() }));
      },
```

> `setCharacterEmotionVariant` already exists (used by `EmotionVariantDesigner`); confirm its payload is `{ characterId, emotion, voiceId }` in `cast-slice.ts` and match it.

b) In the `REQUESTED_TYPE` branch, destructure + forward the new fields, and relax the empty-`characterIds` guard so a variants-only start proceeds. Compute the pill total from the work-list:

```ts
      if (a.type === REQUESTED_TYPE) {
        const { bookId, characterIds, modelKey, scope, variantTasks } =
          a.payload as DesignAllRequestedPayload;
        if (handle) return result;
        const variantCount = (variantTasks ?? []).reduce((n, t) => n + t.emotions.length, 0);
        const baseCount = scope === 'variants' ? 0 : characterIds.length;
        const total = baseCount + (scope === 'bases' ? 0 : variantCount);
        if (!bookId || total === 0) return result;
        const controller = new AbortController();
        dispatch(
          castDesignActions.begin({ bookId, total, currentName: null, lastTickAt: Date.now() }),
        );
        runStream(bookId, controller, (cb) =>
          api.startCastDesign(bookId, { characterIds, modelKey, scope, variantTasks }, cb),
        );
        return result;
      }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/store/cast-design-slice.test.ts src/store/cast-design-stream-middleware.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/cast-design-slice.ts src/store/cast-design-stream-middleware.ts src/store/cast-design-stream-middleware.test.ts
git commit -m "feat(frontend): wire bulk scope/variantTasks + onVariantDesigned through redux"
```

---

## Phase 5 — Frontend: work-list + scope picker

### Task 5: `buildVariantTasks` + `variantWorkCounts`

**Files:**
- Create: `src/lib/variant-tasks.ts`
- Test: `src/lib/variant-tasks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildVariantTasks, variantWorkCounts } from './variant-tasks';
import type { Character } from './types';

const qwen = (id: string, variants: Record<string, { name: string }> = {}, name = 'qwen-' + id) =>
  ({ id, name: id, ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name, variants } } }) as Character;

describe('buildVariantTasks', () => {
  it('emits only in-use emotions that lack a designed variant, base present', () => {
    const chars = [qwen('wren', { angry: { name: 'x' } })];
    const used = new Map([['wren', new Set(['angry', 'excited'])]]);
    expect(buildVariantTasks(chars, used)).toEqual([{ characterId: 'wren', emotions: ['excited'] }]);
  });

  it('excludes a character with no base voice (needs base first)', () => {
    const brann = { id: 'brann', name: 'brann', ttsEngine: 'qwen' } as Character;
    const used = new Map([['brann', new Set(['angry'])]]);
    expect(buildVariantTasks([brann], used)).toEqual([]);
  });

  it('excludes characters with no in-use emotions', () => {
    const used = new Map<string, Set<string>>();
    expect(buildVariantTasks([qwen('ed')], used)).toEqual([]);
  });
});

describe('variantWorkCounts', () => {
  it('counts total missing variants across the cast', () => {
    const chars = [qwen('wren', { angry: { name: 'x' } }), qwen('marlow')];
    const used = new Map([
      ['wren', new Set(['angry', 'excited'])],
      ['marlow', new Set(['whisper', 'sad'])],
    ]);
    expect(variantWorkCounts(chars, used)).toBe(3); // wren:excited + marlow:whisper,sad
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/variant-tasks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* fe-32 — demand-driven variant work-list. Mirrors `countMissingVariants`
   (src/lib/voice-status.ts): for each Qwen character that HAS a base voice, the
   in-use emotions (from `usedEmotionsByCharacter`) that don't yet have a designed
   variant. A character missing its base is excluded — a variant needs a base. */
import type { Character } from './types';

function isQwenWithBase(c: Character): boolean {
  return c.ttsEngine === 'qwen' && !!c.overrideTtsVoices?.qwen?.name;
}

export interface VariantTask {
  characterId: string;
  emotions: string[];
}

export function buildVariantTasks(
  characters: Character[],
  usedEmotions: Map<string, Set<string>>,
): VariantTask[] {
  const tasks: VariantTask[] = [];
  for (const c of characters) {
    if (!isQwenWithBase(c)) continue;
    const used = usedEmotions.get(c.id);
    if (!used || used.size === 0) continue;
    const designed = new Set(Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}));
    const emotions = [...used].filter((e) => !designed.has(e));
    if (emotions.length > 0) tasks.push({ characterId: c.id, emotions });
  }
  return tasks;
}

export function variantWorkCounts(
  characters: Character[],
  usedEmotions: Map<string, Set<string>>,
): number {
  return buildVariantTasks(characters, usedEmotions).reduce((n, t) => n + t.emotions.length, 0);
}
```

- [ ] **Step 4: Run + commit**

Run: `npx vitest run src/lib/variant-tasks.test.ts` → PASS

```bash
git add src/lib/variant-tasks.ts src/lib/variant-tasks.test.ts
git commit -m "feat(frontend): demand-driven variant work-list builder + counts"
```

---

### Task 6: `DesignScopePicker` popover

**Files:**
- Create: `src/components/design-scope-picker.tsx`
- Test: `src/components/design-scope-picker.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignScopePicker } from './design-scope-picker';

const props = (over = {}) => ({
  baseCount: 2,
  variantCount: 5,
  onPick: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

describe('DesignScopePicker', () => {
  it('shows live counts and a combined "both" total', () => {
    render(<DesignScopePicker {...props()} />);
    expect(screen.getByTestId('scope-bases')).toHaveTextContent('2 needed');
    expect(screen.getByTestId('scope-variants')).toHaveTextContent('5 needed');
    expect(screen.getByTestId('scope-both')).toHaveTextContent('7 tasks');
  });

  it('disables an empty scope with "all done"', () => {
    render(<DesignScopePicker {...props({ baseCount: 0 })} />);
    expect(screen.getByTestId('scope-bases')).toBeDisabled();
    expect(screen.getByTestId('scope-bases')).toHaveTextContent('all done');
  });

  it('calls onPick with the chosen scope', async () => {
    const onPick = vi.fn();
    render(<DesignScopePicker {...props({ onPick })} />);
    await userEvent.click(screen.getByTestId('scope-variants'));
    expect(onPick).toHaveBeenCalledWith('variants');
  });

  it('renders nothing actionable when there is no work at all', () => {
    render(<DesignScopePicker {...props({ baseCount: 0, variantCount: 0 })} />);
    expect(screen.getByTestId('scope-both')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/design-scope-picker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
/* fe-32 — scope picker for the single "Design full cast" button. One entry,
   three scopes, each annotated with its live work count so GPU cost is visible
   before starting. A scope with zero work is disabled ("all done"). Closes on
   Escape / outside-click (handled by the parent's overlay). */
import { useEffect, type JSX } from 'react';
import { IconSparkle, IconClose } from '../lib/icons';

export type DesignScope = 'bases' | 'variants' | 'both';

export function DesignScopePicker({
  baseCount,
  variantCount,
  onPick,
  onClose,
}: {
  baseCount: number;
  variantCount: number;
  onPick: (scope: DesignScope) => void;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bothCount = baseCount + variantCount;
  const Row = ({
    scope,
    title,
    desc,
    count,
    unit,
  }: {
    scope: DesignScope;
    title: string;
    desc: string;
    count: number;
    unit: string;
  }) => (
    <button
      type="button"
      data-testid={`scope-${scope}`}
      disabled={count === 0}
      onClick={() => onPick(scope)}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink/4 disabled:opacity-40 disabled:cursor-not-allowed border-t border-ink/8 first:border-t-0 min-h-[44px]"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-bold text-ink">{title}</span>
        <span className="block text-xs text-ink/55">{desc}</span>
      </span>
      <span
        className={`text-xs font-bold px-2.5 py-1 rounded-full shrink-0 ${
          count === 0 ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/12 text-amber-700'
        }`}
      >
        {count === 0 ? 'all done' : `${count} ${unit}`}
      </span>
    </button>
  );

  return (
    <div
      role="menu"
      aria-label="Choose what to design"
      data-testid="design-scope-picker"
      className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-float border border-ink/10 overflow-hidden z-50 fade-in"
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
          What should I design?
        </span>
        <button onClick={onClose} aria-label="Close" className="text-ink/40 hover:text-ink p-1">
          <IconClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <Row scope="bases" title="Base voices" desc="Characters with no designed voice yet" count={baseCount} unit="needed" />
      <Row scope="variants" title="Emotion variants" desc="Tagged emotions missing a variant" count={variantCount} unit="needed" />
      <Row scope="both" title="Both" desc="Bases first, then their needed variants" count={bothCount} unit="tasks" />
      <p className="px-4 py-2.5 text-[11px] text-ink/50 bg-canvas/60 border-t border-ink/8 inline-flex items-center gap-1.5">
        <IconSparkle className="w-3 h-3" /> One at a time on the GPU · safe to close — the pill keeps it going
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run + commit**

Run: `npx vitest run src/components/design-scope-picker.test.tsx` → PASS

```bash
git add src/components/design-scope-picker.tsx src/components/design-scope-picker.test.tsx
git commit -m "feat(frontend): DesignScopePicker popover with live work counts"
```

---

### Task 7: Wire the picker into the cast view

**Files:**
- Modify: `src/views/cast.tsx` (`onDesignFullCast`, the button block at L518-552, add picker state + variant work-list)
- Test: `src/views/cast.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/views/cast.test.tsx` (it already renders the cast view with a store). Render a Qwen cast with one needs-voice char + one char with an in-use emotion missing a variant; click "Design full cast", assert the picker shows, click "Emotion variants", assert `designAllRequested` dispatched with `scope:'variants'` + the right `variantTasks`.

```tsx
it('opens the scope picker and dispatches a variants-scope design', async () => {
  const store = makeCastStore({
    ttsEngine: 'qwen',
    characters: [
      { id: 'wren', name: 'Wren', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } },
    ],
    sentences: [{ id: 1, characterId: 'wren', emotion: 'angry', text: '!' }],
  });
  renderCast(store);
  await userEvent.click(screen.getByTestId('design-full-cast'));
  expect(screen.getByTestId('design-scope-picker')).toBeInTheDocument();
  await userEvent.click(screen.getByTestId('scope-variants'));
  const dispatched = store.getActions?.() ?? [];
  expect(dispatched).toContainEqual(
    expect.objectContaining({
      type: 'castDesign/designAllRequested',
      payload: expect.objectContaining({
        scope: 'variants',
        variantTasks: [{ characterId: 'wren', emotions: ['angry'] }],
      }),
    }),
  );
});
```

> Adapt `makeCastStore` / `renderCast` / `getActions` to the helpers already used in `cast.test.tsx`. If the file uses a real store, assert via a `dispatch` spy instead.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/cast.test.tsx -t scope picker`
Expected: FAIL — button starts immediately; no picker.

- [ ] **Step 3: Implement**

In `src/views/cast.tsx`:

a) Imports:

```ts
import { DesignScopePicker, type DesignScope } from '../components/design-scope-picker';
import { buildVariantTasks, variantWorkCounts } from '../lib/variant-tasks';
```

b) Near the other `useState`s, add: `const [scopeOpen, setScopeOpen] = useState(false);`

c) Compute the variant work-list (reuse the existing `usedEmotions` map already built at L141):

```ts
  const variantTasks = useMemo(
    () => buildVariantTasks(characters, usedEmotions),
    [characters, usedEmotions],
  );
  const variantCount = useMemo(
    () => variantTasks.reduce((n, t) => n + t.emotions.length, 0),
    [variantTasks],
  );
```

> `usedEmotions` is defined later in the file (L141 region) — ensure these `useMemo`s are placed AFTER it. If ordering is awkward, move the `usedEmotions` memo up with the other derived state.

d) Replace `onDesignFullCast` so it opens the picker (cancel path unchanged) and add a `startDesign(scope)`:

```ts
  const onDesignFullCast = () => {
    if (designRunningHere) {
      if (bookId) void api.pauseCastDesign(bookId);
      return;
    }
    if (!bookId || designRunningElsewhere) return;
    setScopeOpen((v) => !v);
  };

  const startDesign = (scope: DesignScope) => {
    setScopeOpen(false);
    if (!bookId) return;
    const modelKey = sampleModelKeyForEngine('qwen', ttsModelKey);
    dispatch(
      castDesignActions.designAllRequested({
        bookId,
        characterIds: scope === 'variants' ? [] : needsVoiceIds,
        modelKey,
        scope,
        variantTasks: scope === 'bases' ? [] : variantTasks,
      }),
    );
  };
```

e) Update `showDesignFullCast` so the button also shows when there are variants to design (not only needs-voice bases):

```ts
  const showDesignFullCast =
    (ttsEngine === 'qwen' && (needsVoiceIds.length > 0 || variantCount > 0)) || designRunningHere;
```

f) Wrap the button in a `relative` container and render the picker. Replace the button block (L518-552) outer element so the picker can anchor:

```tsx
            {(showDesignFullCast || designRunningElsewhere) && (
              <div className="relative">
                <button
                  onClick={onDesignFullCast}
                  disabled={designRunningElsewhere}
                  data-testid="design-full-cast"
                  className={/* unchanged className */}
                  title={designRunningElsewhere ? 'A design run is already in progress for another book.' : undefined}
                >
                  {/* unchanged label content */}
                </button>
                {scopeOpen && !designRunningHere && !designRunningElsewhere && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setScopeOpen(false)} aria-hidden />
                    <DesignScopePicker
                      baseCount={needsVoiceIds.length}
                      variantCount={variantCount}
                      onPick={startDesign}
                      onClose={() => setScopeOpen(false)}
                    />
                  </>
                )}
              </div>
            )}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/views/cast.test.tsx`
Expected: PASS (new case + existing ones; existing "design full cast dispatches" test may need updating to go through the picker — update it to click `scope-bases` and assert `scope:'bases'`).

- [ ] **Step 5: Commit**

```bash
git add src/views/cast.tsx src/views/cast.test.tsx
git commit -m "feat(frontend): Design full cast opens scope picker (bases/variants/both)"
```

---

## Phase 6 — Frontend: cast-table glyph strip (Part A)

### Task 8: `VariantGlyphStrip` component

**Files:**
- Create: `src/components/variant-glyph-strip.tsx`
- Test: `src/components/variant-glyph-strip.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VariantGlyphStrip } from './variant-glyph-strip';

describe('VariantGlyphStrip', () => {
  it('renders one glyph per in-use emotion, marking designed vs needed', () => {
    render(
      <VariantGlyphStrip
        usedEmotions={new Set(['angry', 'excited'])}
        designedEmotions={new Set(['angry'])}
      />,
    );
    expect(screen.getByTestId('variant-glyph-angry')).toHaveAttribute('data-state', 'designed');
    expect(screen.getByTestId('variant-glyph-excited')).toHaveAttribute('data-state', 'needed');
  });

  it('shows a complete state when every in-use emotion is designed', () => {
    render(
      <VariantGlyphStrip
        usedEmotions={new Set(['angry'])}
        designedEmotions={new Set(['angry'])}
      />,
    );
    expect(screen.getByTestId('variants-complete')).toBeInTheDocument();
  });

  it('renders the no-tags hint when there are no in-use emotions', () => {
    render(<VariantGlyphStrip usedEmotions={new Set()} designedEmotions={new Set()} />);
    expect(screen.getByTestId('variants-no-tags')).toBeInTheDocument();
  });

  it('tooltip names the emotion + state', () => {
    render(<VariantGlyphStrip usedEmotions={new Set(['sad'])} designedEmotions={new Set()} />);
    expect(screen.getByTestId('variant-glyph-sad')).toHaveAttribute('title', 'Sad — needs a variant');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/variant-glyph-strip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
/* fe-32 — demand-driven per-emotion variant status for a cast row. One glyph per
   emotion the character's quotes USE; a green check badge = designed, an amber
   alert badge = needed (renders in the base voice until designed). Quiet when
   the character uses no emotion tags; "complete" when every in-use emotion is
   designed. Status badges are crisp SVG icons (IconCheck / IconAlertTri), not
   emoji-text, per the spec's icon-quality requirement. */
import type { JSX } from 'react';
import { IconCheck, IconAlertTri } from '../lib/icons';

const ORDER = ['whisper', 'angry', 'excited', 'sad'] as const;
const GLYPH: Record<string, string> = { whisper: '🤫', angry: '😠', excited: '🤩', sad: '😢' };
const LABEL: Record<string, string> = { whisper: 'Whisper', angry: 'Angry', excited: 'Excited', sad: 'Sad' };

export function VariantGlyphStrip({
  usedEmotions,
  designedEmotions,
}: {
  usedEmotions: Set<string>;
  designedEmotions: Set<string>;
}): JSX.Element {
  const inUse = ORDER.filter((e) => usedEmotions.has(e));
  if (inUse.length === 0) {
    return (
      <span data-testid="variants-no-tags" className="text-[10px] text-ink/35 italic">
        no emotion tags
      </span>
    );
  }
  if (inUse.every((e) => designedEmotions.has(e))) {
    return (
      <span
        data-testid="variants-complete"
        className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700"
      >
        <IconCheck className="w-3 h-3" /> variants complete
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {inUse.map((e) => {
        const designed = designedEmotions.has(e);
        return (
          <span
            key={e}
            data-testid={`variant-glyph-${e}`}
            data-state={designed ? 'designed' : 'needed'}
            title={`${LABEL[e]} — ${designed ? 'designed' : 'needs a variant'}`}
            className={`relative w-6 h-6 rounded-full grid place-items-center text-[13px] ${
              designed ? 'bg-emerald-500/10' : 'bg-amber-500/10'
            }`}
          >
            <span aria-hidden>{GLYPH[e]}</span>
            <span
              className={`absolute -right-1 -top-1 w-3 h-3 rounded-full grid place-items-center text-white ring-2 ring-white ${
                designed ? 'bg-emerald-600' : 'bg-amber-500'
              }`}
            >
              {designed ? (
                <IconCheck className="w-2 h-2" />
              ) : (
                <IconAlertTri className="w-2 h-2" />
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}
```

> Verify `IconCheck` and `IconAlertTri` exist in `src/lib/icons.tsx` (they're imported by `rebaseline-modal.tsx`). The ring uses `ring-white`; in dark mode the row background differs — if a dark-mode visual test flags it, switch to `ring-canvas`. Keep emoji glyphs (the user approved them); only the badges are SVG.

- [ ] **Step 4: Run + commit**

Run: `npx vitest run src/components/variant-glyph-strip.test.tsx` → PASS

```bash
git add src/components/variant-glyph-strip.tsx src/components/variant-glyph-strip.test.tsx
git commit -m "feat(frontend): VariantGlyphStrip — demand-driven per-emotion status glyphs"
```

---

### Task 9: Render the strip in the cast row; drop the count badge + text hint

**Files:**
- Modify: `src/views/cast.tsx` (`StatusPill` at L1262-1310; its two call sites at L829 and L1033)
- Test: `src/views/cast.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/views/cast.test.tsx`:

```tsx
it('cast row shows the variant glyph strip and not the legacy count badge', () => {
  const store = makeCastStore({
    ttsEngine: 'qwen',
    characters: [
      { id: 'wren', name: 'Wren', voiceState: 'generated', ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-wren', variants: { angry: { name: 'x' } } } } },
    ],
    sentences: [
      { id: 1, characterId: 'wren', emotion: 'angry', text: '!' },
      { id: 2, characterId: 'wren', emotion: 'excited', text: '!' },
    ],
  });
  renderCast(store);
  expect(screen.getByTestId('variant-glyph-angry')).toHaveAttribute('data-state', 'designed');
  expect(screen.getByTestId('variant-glyph-excited')).toHaveAttribute('data-state', 'needed');
  expect(screen.queryByTestId('variants-badge')).not.toBeInTheDocument();
  expect(screen.queryByTestId('missing-variants-hint')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/views/cast.test.tsx -t glyph strip`
Expected: FAIL — strip not rendered; legacy badge still present.

- [ ] **Step 3: Implement**

In `src/views/cast.tsx`:

a) Import the strip + add a `usedEmotions` prop to `StatusPill`:

```ts
import { VariantGlyphStrip } from '../components/variant-glyph-strip';
```

b) Change the `StatusPill` signature to take `usedEmotions?: Set<string>` instead of `missingVariants`, and restructure the render to two lines. Replace the component body's return (L1294-1309):

```tsx
  const usedEmotions = usedEmotionsForChar ?? new Set<string>();
  const designed = new Set(Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}));
  const showStrip = isQwen && (usedEmotions.size > 0 || hasEmotionVariants);
  if (!lifecycle && !reused && !showStrip) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        {lifecycle && <Pill color={lifecycle.color}>{lifecycle.label}</Pill>}
        {reused && <ReusedBadge />}
      </span>
      {showStrip && (
        <VariantGlyphStrip usedEmotions={usedEmotions} designedEmotions={designed} />
      )}
    </span>
  );
```

> Drop the `VariantsBadge` import/usage and the `missing-variants-hint` block from `StatusPill` (they're replaced by the strip). Leave `VariantsBadge` in `primitives.tsx` — it may still be used by the profile drawer (`NeedsVariantsBadge`/`VariantsBadge` on voice cards); only remove its use inside `StatusPill`.

c) Update the prop name + both call sites (L829, L1033): replace `missingVariants={countMissingVariants(c, usedEmotions.get(c.id))}` with `usedEmotionsForChar={usedEmotions.get(c.id)}`.

d) Rename the prop in the `StatusPill` props interface: replace `missingVariants?: number;` with `usedEmotionsForChar?: Set<string>;` and remove the now-unused `missingVariants = 0` default + the `showMissing` logic.

> `countMissingVariants` is still used by `statusBuckets` (the "Needs variants" chip) — keep that import. Only the row-level `missingVariants` prop is removed.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/views/cast.test.tsx`
Expected: PASS. Update any existing test that asserted `variants-badge` / `missing-variants-hint` in a row to assert the glyph strip instead.

- [ ] **Step 5: Commit**

```bash
git add src/views/cast.tsx src/views/cast.test.tsx
git commit -m "feat(frontend): cast row shows per-emotion variant glyphs (replaces count + hint)"
```

---

## Phase 7 — E2E + docs

### Task 10: Playwright e2e — picker → variants → glyph flips

**Files:**
- Create: `e2e/cast-variant-design.spec.ts`

- [ ] **Step 1: Write the spec**

Mock mode designs variants synchronously (Task 3's `mockStartCastDesign` emits `variant_designed`). Drive the cast view, open the picker, choose Emotion variants, assert a needed glyph flips to designed.

```ts
import { test, expect } from '@playwright/test';
import { gotoReadyBook } from './helpers'; // use the existing helper that lands on a confirmed Qwen book's cast view

test('bulk emotion-variant design flips a needed glyph to designed', async ({ page }) => {
  await gotoReadyBook(page, { view: 'cast' });
  // a row that uses an emotion with no variant shows a "needed" glyph
  const needed = page.getByTestId('variant-glyph-angry').first();
  await expect(needed).toHaveAttribute('data-state', 'needed');

  await page.getByTestId('design-full-cast').click();
  await expect(page.getByTestId('design-scope-picker')).toBeVisible();
  await page.getByTestId('scope-variants').click();

  // mock job designs the variant synchronously; the glyph flips to designed
  await expect(page.getByTestId('variant-glyph-angry').first()).toHaveAttribute(
    'data-state',
    'designed',
  );
});
```

> Adapt `gotoReadyBook` to the actual e2e helper in `e2e/` (check `e2e/helpers.ts` / how other specs reach the cast view). The mock canned cast must have at least one Qwen character with an emotion-tagged sentence and no matching variant — confirm `src/mocks/canned-data.ts` has this, or add a sentence emotion tag in the mock so the glyph renders.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/cast-variant-design.spec.ts --project=chromium`
Expected: PASS (after wiring the helper + ensuring the mock cast has a needed variant).

- [ ] **Step 3: Commit**

```bash
git add e2e/cast-variant-design.spec.ts src/mocks/canned-data.ts
git commit -m "test(e2e): bulk emotion-variant design flips a cast-row glyph"
```

---

### Task 11: Regression-plan doc + index + backlog

**Files:**
- Create: `docs/features/NNN-cast-bulk-emotion-variants.md` (next free number; check `docs/features/INDEX.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/BACKLOG.md` (the `fe-32` row)

- [ ] **Step 1: Write the regression plan**

Use `docs/features/TEMPLATE.md`. Cover: the demand-driven model; the scope picker + work-list; the server task model + book-scoped variant persistence + deferred series propagation; the glyph strip replacing the count/hint; the test matrix. Link the spec + this plan.

- [ ] **Step 2: Update INDEX.md**

Add an entry under the cast/voice area summarizing the feature and linking the plan.

- [ ] **Step 3: Update BACKLOG.md**

Collapse the `fe-32` row to reflect the per-book delivery (it shipped against the cast view, not the rebaseline modal). Note the series-wide rebaseline-modal variant design remains out of scope (the original fe-32 framing) if you want to keep a thin follow-up row; otherwise mark fe-32 delivered.

- [ ] **Step 4: Commit**

```bash
git add docs/features/NNN-cast-bulk-emotion-variants.md docs/features/INDEX.md docs/BACKLOG.md
git commit -m "docs(docs): regression plan for per-book bulk emotion-variant design + glyphs"
```

---

## Phase 8 — Verify

### Task 12: Full local verify

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean (frontend + server).

- [ ] **Step 2: Targeted suites**

Run: `npm run test && npm run test:server && npm run test:e2e`
Expected: all green.

- [ ] **Step 3: Full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 4: Live-GPU acceptance (manual, owed)**

With the real server + sidecar running on the Qwen box: open a confirmed Qwen book's cast view, click "Design full cast" → "Emotion variants", watch the third pill run "Designing voices & variants…", and confirm needed glyphs flip to designed and audition the new variant in the profile drawer. Note this in the plan's Ship notes.

---

## Self-Review

- **Spec coverage:**
  - Part A glyphs → Tasks 8–9 (component + row wiring, count/hint removed). ✓
  - Demand-driven (`usedEmotions`) → Tasks 5, 8, 9. ✓
  - Quiet/complete/needs-base states → Task 8 (no-tags, complete) + Task 9 (needs-base shows no strip since `isQwenWithBase` false → strip hidden; lifecycle "Needs voice" pill carries it). ✓ *(Note: the "design base voice first" hint is implicit — the strip is simply hidden for a base-less Qwen row. If an explicit hint is wanted, add it in Task 9's `showStrip === false && isQwen && usedEmotions.size>0` branch.)*
  - SVG status badges → Task 8 (IconCheck/IconAlertTri). ✓
  - Part B scope picker (bases/variants/both, live counts, disabled, dependency) → Tasks 6–7. ✓
  - Frontend-computed work-list passed to server → Tasks 5, 7, 3. ✓
  - Server task model + freshness (variant exists / base missing) → Task 2. ✓
  - Book-scoped variant persistence + shared helper → Task 1. ✓
  - `variant_designed` event + `onVariantDesigned` + slice mirror → Tasks 2, 3, 4. ✓
  - Pill total counts bases+variants → Task 4. ✓
  - Error handling (per-task isolate / sidecar fast-fail / base-missing skip) → Task 2. ✓
  - Tests: unit + server + e2e → Tasks 1–10. ✓
- **Placeholder scan:** the only "NNN" is the doc number (Task 11 resolves it from INDEX). No TBD/TODO in code steps.
- **Type consistency:** `DesignScope` defined in `design-scope-picker.tsx` (Task 6) and re-used as a string union in the slice payload (Task 4) and server (Task 2, local `DesignScope`). `VariantTask` shape `{ characterId, emotions[] }` consistent across `variant-tasks.ts` (Task 5), slice payload (Task 4), API (Task 3), server parsing (Task 2). `persistEmotionVariant(bookDir, characterId, emotion, voiceId)` signature consistent between Task 1 (def) and Task 2 (call). `setCharacterEmotionVariant({ characterId, emotion, voiceId })` matches the existing cast-slice action (verify in `cast-slice.ts` during Task 4).

**Open item flagged for execution:** confirm `setCharacterEmotionVariant`'s exact payload key names in `src/store/cast-slice.ts` before Task 4 Step 4 (the `EmotionVariantDesigner` dispatches it as `{ characterId, emotion, voiceId }` — match verbatim).
