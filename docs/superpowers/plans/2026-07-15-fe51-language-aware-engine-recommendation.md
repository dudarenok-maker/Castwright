# Wizard Language-Aware Engine Recommendation (Part B / fe-51) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's hardcoded "Kokoro is the default voice engine" with a one-question, needs-based recommendation — expressive/multilingual → Qwen (Coqui optional), simple English → Kokoro — that leads the matching install card, prioritizes its pull, and pre-seeds the Defaults step, with detected VRAM as a soft caveat only.

**Architecture:** A pure server function `recommendEngines(vramTotalMb)` reads an authored capability map (extended onto Part A's `VOICE_ENGINES` registry) plus the *derived* multilingual flag (from `ENGINE_LANGUAGE_SUPPORT`), and precomputes the recommendation for **both** answers to the single guided question. The result rides Part A's existing `ModelsStatus` payload (the wizard already fetches it once), so the client adds **no new endpoint and no new fetch** — `step-voice.tsx` renders a guided-question control, reorders the install cards so the recommended engine leads with a "Recommended for you" badge + primary CTA, and dispatches the Defaults handoff (`defaultTtsModelKey`) when the user answers.

**Tech Stack:** TypeScript, Node/Express (server), Vitest (server + frontend), React 18 + Redux Toolkit (frontend), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-14-wizard-models-status-and-recommendation-design.md` — **Part B section** (amended 2026-07-15 against the landed Part A interfaces; server-side recommendation placement decided).

**Issue:** `#1614` (fe-51, child of epic `#1613` / fs-75). This plan `Closes #1614`. **Depends on Part A (#1612 / PR #1644)** — this branch builds on Part A's `VOICE_ENGINES` registry, `ModelsStatus` payload, and controlled install cards. fe-49 (#1610) is **merged (PR #1642)**, so the pull-priority presentation is fully in-scope.

## Global Constraints

Every task's requirements implicitly include this section.

- **No hex literals in component code** — use the CSS custom-property design tokens (`--peach`, `--ink`, `--magenta`, …) via Tailwind classes.
- **OpenAPI / hand-written mirror parity** — the client `ModelsStatus` type in `src/lib/api.ts` is a **hand-written mirror** of the server `ModelsStatus` (there is no generated type for it). Any server shape change ships with the matching mirror edit **in the same task**, or the client typechecks against a stale contract.
- **Mocks parity** — `mockGetModelsStatus()` (`src/lib/api.ts`) must return the same shape as the real endpoint; adding a field to `ModelsStatus` means updating the mock in the same task or every `step-voice`/`model-manager` test that renders off the mock breaks.
- **`defaultTtsModelKey`, NOT `defaultTtsEngine`** carries the kokoro/qwen/coqui choice. `defaultTtsEngine` is the `'local' | 'gemini'` provider *tier* and cannot hold an engine id. The handoff sets `defaultTtsModelKey` (+ `defaultTtsModelKeyExplicit: true`) and `defaultTtsEngine: 'local'` (all recommended engines are on-device).
- **Capability is a hard filter; VRAM is a soft preference.** Never recommend an engine that cannot meet the stated need (multilingual → Kokoro is ineligible). VRAM never *reorders* the capable branch — it only attaches a caveat. Nothing is ever blocked; every engine stays installable.
- **Data-driven capability (decided 2026-07-15).** The capable set is **derived** — `VOICE_ENGINES.filter(e => e.expressive || isMultilingualEngine(e.id))` — so a future expressive/multilingual engine qualifies automatically (the spec's stated goal). Ordering within the capable set uses an **authored `capablePreferenceRank`** field (Qwen `0`, Coqui `1`), *not* VRAM floors (which would wrongly rank Coqui first). Today this yields Qwen-leads-Coqui, per #1614 — but via live capability + rank, not a hardcoded id list. `expressive` is therefore load-bearing (it's read by the filter); `designVramFloorMb` is **dropped** (no consumer in Part B).
- **CPU-only / no-GPU + "yes" answer → Qwen with a CPU caveat (decided 2026-07-15 — a deliberate revision of the spec's case-4 "CPU-only → Kokoro").** Rationale: Qwen *does* run on CPU (slower) via the voice-engine device setting, and the single "expressive **and/or** multilingual" question can't tell a non-English need (Kokoro literally cannot serve) from expressive-English (Kokoro can). Leading Qwen serves the multilingual user correctly; the caveat nudges the expressive-English user to Kokoro. Recommending Kokoro here (spec-literal) would hand a non-English user an engine that cannot do their language at all. **This override is flagged in Task 2 and in Self-Review — it is NOT silent.**
- **Truthfulness — caveat wording.** The caveat for a low/no-VRAM Qwen recommendation is **"May not fit this GPU's memory — you can run Qwen on CPU (slower) via the voice-engine device setting, or pick Kokoro below for fast English-only voices."** This is honest per the product owner (Qwen runs on CPU, just slow) — distinct from the *constrained-GPU auto-fallback* OOM history (#1155), which is a different path. On-box acceptance still confirms forcing CPU actually renders (Task 6 note).
- **Testing discipline** — every task ships paired automated tests (fails-before/passes-after for the behavior it adds). Server pure functions get Vitest unit tests mirroring the `diagnose*` pattern; UI crossing redux/fetch/layout seams earns one Playwright e2e.
- **Commit convention** — `<type>(<scope>): <subject>`; scopes here are `server` and `frontend` (and `docs` for the plan/regression-doc commits). Multi-file client+server changes stay split by task so scope stays single.

## File Structure

**New files:**
- `server/src/tts/engine-recommendation.ts` — the pure recommendation module: `NeedsAnswer`, `EngineRecommendation`, `RecommendationSet` types; `isMultilingualEngine()` (derives from `ENGINE_LANGUAGE_SUPPORT`); `recommendEngines(vramTotalMb)`. One responsibility: turn hardware + capability into a recommendation. No I/O.
- `server/src/tts/engine-recommendation.test.ts` — unit tests for the four spec cases + multilingual derivation.
- `src/components/setup/engine-recommendation-copy.ts` — tiny client-side presentation helpers (question label, answer labels, "Recommended for you" badge text). Pure, keeps copy out of the component body and unit-testable.
- `e2e/setup-engine-recommendation.spec.ts` — one golden-path spec.
- `docs/features/259-fe51-engine-recommendation.md` — regression plan (verify `259` is still free at implementation time; bump if a concurrent plan claimed it).

**Modified files:**
- `server/src/tts/voice-engine-registry.ts` — extend `VoiceEngineEntry` with authored capability fields (`expressive`, `genVramFloorMb`, `capablePreferenceRank`); populate the three entries.
- `server/src/tts/models-status.ts` — add `recommendation: RecommendationSet` to `ModelsStatus`; `buildModelsStatus` calls `recommendEngines(input.info.vramTotalMb)`.
- `src/lib/api.ts` — mirror the `recommendation` field onto the client `ModelsStatus` interface; add it to `mockGetModelsStatus()`.
- `src/components/setup/step-voice.tsx` — guided-question control; recommendation-driven card ordering + "Recommended for you" badge + primary CTA; de-defaulting copy; Defaults handoff dispatch.
- `src/components/setup/step-voice.test.tsx` — extend with the new behaviors.

**Untouched (verified, receives the pre-seed only):**
- `src/components/setup/step-defaults.tsx` — already reads/writes `defaultTtsModelKey` + `defaultTtsModelKeyExplicit` via its "Voice model" dropdown; it shows the recommended model pre-selected with **no new plumbing**.

---

## Task 1: Authored capability fields on the voice-engine registry

Extend Part A's `VoiceEngineEntry` with the authored capability constants the recommendation reads. `multilingual` is **not** stored here (it is derived in Task 2 from `ENGINE_LANGUAGE_SUPPORT`); only the authored facts live here.

**Files:**
- Modify: `server/src/tts/voice-engine-registry.ts`
- Test: `server/src/tts/voice-engine-registry.test.ts` (create if absent)

**Interfaces:**
- Consumes: existing `VoiceEngineEntry` / `VOICE_ENGINES` (Part A).
- Produces: `VoiceEngineEntry.expressive: boolean`, `VoiceEngineEntry.genVramFloorMb: number`, `VoiceEngineEntry.capablePreferenceRank: number` — all read by `recommendEngines` (Task 2). (`expressive` drives the capable-set filter; `capablePreferenceRank` orders the capable set; `genVramFloorMb` sets the caveat threshold.)

**Authored constants** (estimates, not measured — only the *structure* is fixed; treat the numbers as best-effort authored values grounded in CLAUDE.md's model-lifecycle notes, and refine on-box if measurement contradicts them. **Only the capable lead's `genVramFloorMb` is read today** — see Task 2 — but every engine carries one as a coherent per-engine property for when it leads):
- **Kokoro** — `expressive: false`, `genVramFloorMb: 1024` (~1 GB, fits CPU), `capablePreferenceRank: 99` (never in the capable set — `expressive` false + English-only — so its rank is inert; a high sentinel documents that).
- **Qwen** — `expressive: true`, `genVramFloorMb: 6144` (0.6B generation path; the one #1614-derived threshold), `capablePreferenceRank: 0` (leads the capable branch — the multi-cast default).
- **Coqui** — `expressive: true`, `genVramFloorMb: 4096`, `capablePreferenceRank: 1` (optional alternate).

`designVramFloorMb` from the spec's draft `EngineCapability` is intentionally **omitted** — Part B's recommendation never reads it (it governs voice-design VRAM steering, a separate future feature). Add it when a consumer exists (YAGNI).

- [ ] **Step 1: Write the failing test**

Create/extend `server/src/tts/voice-engine-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { VOICE_ENGINES } from './voice-engine-registry.js';

describe('VOICE_ENGINES capability fields', () => {
  const byId = Object.fromEntries(VOICE_ENGINES.map((e) => [e.id, e]));

  it('carries authored expressive + VRAM floor + capable rank per engine', () => {
    expect(byId.kokoro.expressive).toBe(false);
    expect(byId.kokoro.genVramFloorMb).toBe(1024);
    expect(byId.kokoro.capablePreferenceRank).toBe(99);

    expect(byId.qwen.expressive).toBe(true);
    expect(byId.qwen.genVramFloorMb).toBe(6144);
    expect(byId.qwen.capablePreferenceRank).toBe(0);

    expect(byId.coqui.expressive).toBe(true);
    expect(byId.coqui.genVramFloorMb).toBe(4096);
    expect(byId.coqui.capablePreferenceRank).toBe(1);
  });

  it('every entry has a positive generation floor', () => {
    for (const e of VOICE_ENGINES) expect(e.genVramFloorMb).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/voice-engine-registry.test.ts`
Expected: FAIL — `expressive`/`genVramFloorMb` are `undefined` (type error at compile or `toBe` mismatch at runtime).

- [ ] **Step 3: Extend the interface and populate entries**

In `server/src/tts/voice-engine-registry.ts`, add to `VoiceEngineEntry` (after `liveLoaded`):

```ts
  /** Authored: the engine produces expressive/emotive speech (no code source —
      a curated fact). Kokoro is flat/fast; Qwen + Coqui are expressive. Read by
      the recommendation's capable-set filter (expressive || multilingual). */
  expressive: boolean;
  /** Authored estimate: comfortable VRAM (MB) for the GENERATION path. The
      recommendation reads the capable LEAD's floor to decide whether to attach a
      caveat. Not measured — refine on-box if contradicted. */
  genVramFloorMb: number;
  /** Authored: lead preference within the capable (expressive||multilingual) set.
      Lower wins. Only meaningful for capable engines (Qwen 0, Coqui 1); a
      non-capable engine (Kokoro) never enters the set, so its rank is a high
      sentinel (99). */
  capablePreferenceRank: number;
```

Then add the fields to each entry:

```ts
  {
    id: 'kokoro',
    defaultModelKey: 'kokoro-v1',
    // …existing probe fns…
    expressive: false,
    genVramFloorMb: 1024,
    capablePreferenceRank: 99,
  },
  {
    id: 'qwen',
    defaultModelKey: 'qwen3-tts-0.6b',
    // …existing probe fns…
    expressive: true,
    genVramFloorMb: 6144,
    capablePreferenceRank: 0,
  },
  {
    id: 'coqui',
    defaultModelKey: 'coqui-xtts-v2',
    // …existing probe fns…
    expressive: true,
    genVramFloorMb: 4096,
    capablePreferenceRank: 1,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/voice-engine-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/voice-engine-registry.ts server/src/tts/voice-engine-registry.test.ts
git commit -m "feat(server): add authored capability fields to voice-engine registry"
```

---

## Task 2: `recommendEngines()` pure recommendation function

The heart of Part B: a pure function over authored capability + derived multilingual + detected VRAM, precomputing the recommendation for **both** answers to the guided question.

**Files:**
- Create: `server/src/tts/engine-recommendation.ts`
- Test: `server/src/tts/engine-recommendation.test.ts`

**Interfaces:**
- Consumes: `VOICE_ENGINES` (with capability fields from Task 1); `ENGINE_LANGUAGE_SUPPORT` (`server/src/tts/voice-mapping.ts`); `DEFAULT_LANGUAGE` (`server/src/tts/language.ts`).
- Produces:
  - `type NeedsAnswer = 'expressive-or-multilingual' | 'simple-english'`
  - `interface EngineRecommendation { engine: VoiceEngineId; modelKey: VoiceEngineEntry['defaultModelKey']; reason: string; caveat: string | null; alternate: VoiceEngineId | null }`
  - `interface RecommendationSet { expressiveOrMultilingual: EngineRecommendation; simpleEnglish: EngineRecommendation }`
  - `function isMultilingualEngine(id: VoiceEngineId): boolean`
  - `function recommendEngines(vramTotalMb: number | null): RecommendationSet`

**Logic (verbatim — do not paraphrase into "handle edge cases"):**
- `simpleEnglish` → **always Kokoro** (`kokoro-v1`), `caveat: null`, `alternate: null`, `reason: 'Fast and light — runs comfortably on low VRAM or CPU.'`
- `expressiveOrMultilingual` → **data-driven**: capable set = `VOICE_ENGINES.filter(e => e.expressive || isMultilingualEngine(e.id))`, sorted ascending by `capablePreferenceRank`. `engine` = first (Qwen today); `alternate` = second's id if present (Coqui today), else `null`; `reason: 'Expressive and multilingual — the multi-cast default.'`
- **Caveat** (soft, never reorders): `null` when `vramTotalMb != null && vramTotalMb >= lead.genVramFloorMb`; otherwise the CPU caveat string. This covers **both** low-VRAM and CPU-only/`null` — the CPU-only case **deliberately still leads Qwen** (not Kokoro), a flagged revision of the spec's case-4 (see Global Constraints): Qwen runs on CPU (slower) and Kokoro can't do non-English, so the caveat — not a downgrade — is the honest tool.

- [ ] **Step 1: Write the failing test**

Create `server/src/tts/engine-recommendation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { recommendEngines, isMultilingualEngine } from './engine-recommendation.js';

describe('isMultilingualEngine', () => {
  it('derives multilingual from ENGINE_LANGUAGE_SUPPORT', () => {
    expect(isMultilingualEngine('qwen')).toBe(true); // support '*'
    expect(isMultilingualEngine('coqui')).toBe(true); // ['en','ru',…]
    expect(isMultilingualEngine('kokoro')).toBe(false); // ['en'] only
  });
});

describe('recommendEngines', () => {
  it('simple-english → Kokoro always, no caveat, regardless of VRAM', () => {
    for (const vram of [null, 512, 8192, 24576]) {
      const r = recommendEngines(vram).simpleEnglish;
      expect(r.engine).toBe('kokoro');
      expect(r.modelKey).toBe('kokoro-v1');
      expect(r.caveat).toBeNull();
      expect(r.alternate).toBeNull();
    }
  });

  it('need + adequate VRAM (>= Qwen floor) → Qwen, Coqui alternate, no caveat', () => {
    const r = recommendEngines(8192).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.modelKey).toBe('qwen3-tts-0.6b');
    expect(r.alternate).toBe('coqui');
    expect(r.caveat).toBeNull();
  });

  it('need + low VRAM (< Qwen floor) → Qwen with CPU caveat (never downgraded to Kokoro)', () => {
    const r = recommendEngines(4096).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.caveat).toMatch(/may not fit/i);
    expect(r.caveat).toMatch(/CPU/i); // caveat offers the CPU-mode escape hatch
  });

  it('need + CPU-only (vram null) → Qwen with CPU caveat, still not Kokoro (deliberate case-4 revision)', () => {
    const r = recommendEngines(null).expressiveOrMultilingual;
    expect(r.engine).toBe('qwen');
    expect(r.caveat).toMatch(/may not fit/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/engine-recommendation.test.ts`
Expected: FAIL — module `./engine-recommendation.js` not found.

- [ ] **Step 3: Write the implementation**

Create `server/src/tts/engine-recommendation.ts`:

```ts
/* fe-51 (Part B) — language-aware voice-engine recommendation. Pure over authored
   capability (voice-engine-registry) + derived multilingual (ENGINE_LANGUAGE_SUPPORT)
   + detected VRAM. Precomputes BOTH answers to the wizard's one guided question so
   the client renders off the models-status payload with no extra round-trip.

   Capability is a HARD filter (never recommend an engine that can't meet the need);
   VRAM is a SOFT preference (caveat only, never reorders). Qwen leads the capable
   branch, Coqui is the optional alternate (#1614). */
import { VOICE_ENGINES, type VoiceEngineId, type VoiceEngineEntry } from './voice-engine-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import { DEFAULT_LANGUAGE } from './language.js';

export type NeedsAnswer = 'expressive-or-multilingual' | 'simple-english';

export interface EngineRecommendation {
  engine: VoiceEngineId;
  modelKey: VoiceEngineEntry['defaultModelKey'];
  reason: string;
  caveat: string | null;
  alternate: VoiceEngineId | null;
}

export interface RecommendationSet {
  expressiveOrMultilingual: EngineRecommendation;
  simpleEnglish: EngineRecommendation;
}

/* CPU caveat for a low/no-VRAM Qwen recommendation. Honest per the product owner:
   Qwen runs on CPU (slower) via the voice-engine device setting; Kokoro is the fast
   English-only escape hatch. This is a caveat, NOT a downgrade — the CPU-only case
   still LEADS Qwen (deliberate revision of the spec's case-4 "CPU-only → Kokoro",
   because Kokoro can't serve a non-English book at all and the one guided question
   can't tell non-English from expressive-English). */
const CAVEAT_VRAM =
  "May not fit this GPU's memory — you can run Qwen on CPU (slower) via the voice-engine " +
  'device setting, or pick Kokoro below for fast English-only voices.';

const byId = new Map<VoiceEngineId, VoiceEngineEntry>(VOICE_ENGINES.map((e) => [e.id, e]));

/** Derived, not stored: an engine is multilingual if it supports any language
    beyond English in ENGINE_LANGUAGE_SUPPORT ('*' or a non-'en' entry). */
export function isMultilingualEngine(id: VoiceEngineId): boolean {
  const support = ENGINE_LANGUAGE_SUPPORT[id];
  if (support === '*') return true;
  return support.some((lang) => lang !== DEFAULT_LANGUAGE);
}

export function recommendEngines(vramTotalMb: number | null): RecommendationSet {
  // Capable = expressive OR multilingual (DERIVED — a future qualifying engine joins
  // automatically), ordered by authored capablePreferenceRank (Qwen 0, Coqui 1).
  const capable = VOICE_ENGINES.filter(
    (e) => e.expressive || isMultilingualEngine(e.id),
  ).sort((a, b) => a.capablePreferenceRank - b.capablePreferenceRank);

  const lead = capable[0];
  const alternate: VoiceEngineId | null = capable[1]?.id ?? null;

  const fits = vramTotalMb != null && vramTotalMb >= lead.genVramFloorMb;

  const kokoro = byId.get('kokoro')!;

  return {
    expressiveOrMultilingual: {
      engine: lead.id,
      modelKey: lead.defaultModelKey,
      reason: 'Expressive and multilingual — the multi-cast default.',
      caveat: fits ? null : CAVEAT_VRAM,
      alternate,
    },
    simpleEnglish: {
      engine: 'kokoro',
      modelKey: kokoro.defaultModelKey,
      reason: 'Fast and light — runs comfortably on low VRAM or CPU.',
      caveat: null,
      alternate: null,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/engine-recommendation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/engine-recommendation.ts server/src/tts/engine-recommendation.test.ts
git commit -m "feat(server): pure language-aware engine recommendation function"
```

---

## Task 3: Surface the recommendation on the `ModelsStatus` payload (+ client mirror + mock)

Thread the recommendation through Part A's existing computation so the wizard gets it in the one fetch it already makes.

**Files:**
- Modify: `server/src/tts/models-status.ts`
- Modify: `src/lib/api.ts` (client `ModelsStatus` mirror + `mockGetModelsStatus`)
- Test: `server/src/tts/models-status.test.ts` (extend Part A's suite)

**Interfaces:**
- Consumes: `recommendEngines` (Task 2); `BuildModelsStatusInput.info.vramTotalMb` (Part A).
- Produces: `ModelsStatus.recommendation: RecommendationSet` — read by `step-voice.tsx` (Task 4).

- [ ] **Step 1: Write the failing test**

Extend `server/src/tts/models-status.test.ts` (add near the existing `buildModelsStatus` cases — reuse whatever `baseInput` helper the suite already has; the block below shows the minimal standalone form):

```ts
import { buildModelsStatus } from './models-status.js';

function inputWith(vramTotalMb: number | null) {
  const probe = { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined };
  return {
    runtime: { installedOnDisk: false, pythonFound: false, process: 'down' as const },
    engines: { kokoro: probe, qwen: probe, coqui: probe },
    info: { gpu: 'test', vramTotalMb },
  };
}

it('surfaces a recommendation derived from vramTotalMb', () => {
  const hi = buildModelsStatus(inputWith(8192));
  expect(hi.recommendation.expressiveOrMultilingual.engine).toBe('qwen');
  expect(hi.recommendation.expressiveOrMultilingual.caveat).toBeNull();
  expect(hi.recommendation.simpleEnglish.engine).toBe('kokoro');

  const lo = buildModelsStatus(inputWith(2048));
  expect(lo.recommendation.expressiveOrMultilingual.caveat).toMatch(/may not fit/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/models-status.test.ts`
Expected: FAIL — `recommendation` is not a property of `ModelsStatus`.

- [ ] **Step 3: Add the field and wire the computation**

In `server/src/tts/models-status.ts`:

```ts
import { recommendEngines, type RecommendationSet } from './engine-recommendation.js';
```

Add to the `ModelsStatus` interface (after `info`):

```ts
  /** fe-51 — precomputed recommendation for both answers to the wizard's guided
      question. Derived from info.vramTotalMb + the engine capability map. */
  recommendation: RecommendationSet;
```

In `buildModelsStatus`, change the return to include it:

```ts
  return {
    runtime: input.runtime,
    engines,
    info: input.info,
    recommendation: recommendEngines(input.info.vramTotalMb),
  };
```

- [ ] **Step 4: Mirror the field on the client + update the mock**

In `src/lib/api.ts`, extend the hand-written `ModelsStatus` mirror (the `fs-38 Part A` block, ~line 7196). Add the mirrored types **above** the interface and the field **inside** it:

```ts
export type NeedsAnswer = 'expressive-or-multilingual' | 'simple-english';
export interface EngineRecommendation {
  engine: 'kokoro' | 'qwen' | 'coqui';
  modelKey: 'kokoro-v1' | 'qwen3-tts-0.6b' | 'coqui-xtts-v2';
  reason: string;
  caveat: string | null;
  alternate: 'kokoro' | 'qwen' | 'coqui' | null;
}
export interface RecommendationSet {
  expressiveOrMultilingual: EngineRecommendation;
  simpleEnglish: EngineRecommendation;
}
export interface ModelsStatus {
  runtime: { installedOnDisk: boolean; pythonFound: boolean; process: RuntimeProcessState };
  engines: Record<'kokoro' | 'qwen' | 'coqui', { state: EngineHealthState; packageBroken: boolean }>;
  info: { gpu: string; vramTotalMb: number | null };
  recommendation: RecommendationSet;
}
```

Update `mockGetModelsStatus()` (~line 7272) to return a recommendation (mock is CPU-only → `vramTotalMb: null` → Qwen caveat present). Note the caveat string here is a **hand-copy** of the server's `CAVEAT_VRAM` (Task 2) — the client mirror can't import a server const. This only affects mock-mode display + tests, and every assertion is a `/may not fit/i` substring (not exact equality), so the two can't break a test by drifting; the real runtime caveat always comes from the server. Add a `// keep in sync with server CAVEAT_VRAM` comment:

```ts
    info: { gpu: 'CPU — no GPU detected', vramTotalMb: null },
    recommendation: {
      expressiveOrMultilingual: {
        engine: 'qwen',
        modelKey: 'qwen3-tts-0.6b',
        reason: 'Expressive and multilingual — the multi-cast default.',
        caveat:
          "May not fit this GPU's memory — you can run Qwen on CPU (slower) via the voice-engine device setting, or pick Kokoro below for fast English-only voices.",
        alternate: 'coqui',
      },
      simpleEnglish: {
        engine: 'kokoro',
        modelKey: 'kokoro-v1',
        reason: 'Fast and light — runs comfortably on low VRAM or CPU.',
        caveat: null,
        alternate: null,
      },
    },
```

- [ ] **Step 5: Update local `ModelsStatus` test fixtures**

Making `recommendation` **required** breaks any hand-built **full `ModelsStatus`** literal. Find them, but add the field **only to full-`ModelsStatus` builders — NOT to `RuntimeStatus`-shaped literals** (`{ installedOnDisk, pythonFound, process }` passed to `VenvBootstrap`/`runtimeIsBlocking`), which have no `recommendation` field and would type-error if you add one:

Run: `git grep -ln "installedOnDisk" -- 'src/**/*.test.tsx' 'src/**/*.test.ts'`
The only **full-`ModelsStatus`** builders are `src/components/setup/step-voice.test.tsx` (its local `modelsStatus()` helper — add `recommendation` to that helper's default object) and `src/views/model-manager.test.tsx` (its `getModelsStatus` mock — untyped `vi.fn().mockResolvedValue({…})`, so it won't type-error, but add the field for realism). `venv-bootstrap.test.tsx` and `engine-card-status.test.ts` build `RuntimeStatus`, **not** `ModelsStatus` — leave them alone. Reuse the Task-3 `mockGetModelsStatus` recommendation shape (Qwen lead, CPU caveat). A shared exported fixture is fine.

- [ ] **Step 6: Run tests + typecheck to verify green**

Run: `cd server && npx vitest run src/tts/models-status.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS (client mirror matches server; no runtime consumer of `ModelsStatus` breaks — `setup-readiness.ts` and `model-manager.tsx` read `.runtime`/`.engines` only and ignore the additive field; test fixtures fixed above).

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/models-status.ts server/src/tts/models-status.test.ts src/lib/api.ts src/components/setup/step-voice.test.tsx
git commit -m "feat(server): surface engine recommendation on models-status payload"
```

---

## Task 4: Guided question + recommendation-driven card ordering (client)

Add the one needs-based question above the engine cards and reorder them so the recommended engine leads with a "Recommended for you" badge + primary CTA. De-default: order is now derived, not fixed on Kokoro.

**Files:**
- Create: `src/components/setup/engine-recommendation-copy.ts`
- Modify: `src/components/setup/step-voice.tsx`
- Test: `src/components/setup/engine-recommendation-copy.test.ts`, `src/components/setup/step-voice.test.tsx`

**Interfaces:**
- Consumes: `ModelsStatus['recommendation']` (Task 3); the existing controlled `KokoroInstall`/`QwenInstall`/`CoquiInstall` (`status` + `onInstalled` props, Part A).
- Produces: the `NeedsAnswer` local state + the `activeRec` selection consumed by the handoff (Task 5).

**Behavior:**
- A two-option control (segmented radio) with the question. Default: **unanswered** (`null`).
- Unanswered → render cards in today's order (Kokoro lead, Qwen/Coqui under "More voice engines"), with a hint prompting the user to answer.
- Answered → the recommended engine's card leads with a `Recommended for you` badge; its Install CTA is the primary emphasis (pull priority); the other two engines render below under a **"Other engines"** disclosure (renamed from "More voice engines"). The lead's `caveat`, when present, renders as a neutral (sky, not amber) note under the badge.

- [ ] **Step 1: Write the failing copy-helper test**

Create `src/components/setup/engine-recommendation-copy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NEEDS_QUESTION, needsAnswerLabel, engineDisplayName } from './engine-recommendation-copy';

describe('engine-recommendation-copy', () => {
  it('exposes the one guided question and answer labels', () => {
    expect(NEEDS_QUESTION).toMatch(/expressive|multilingual/i);
    expect(needsAnswerLabel('expressive-or-multilingual')).toMatch(/expressive|multilingual/i);
    expect(needsAnswerLabel('simple-english')).toMatch(/english/i);
  });
  it('maps engine ids to display names', () => {
    expect(engineDisplayName('kokoro')).toBe('Kokoro');
    expect(engineDisplayName('qwen')).toBe('Qwen3-TTS');
    expect(engineDisplayName('coqui')).toBe('Coqui XTTS v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/setup/engine-recommendation-copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the copy helper**

Create `src/components/setup/engine-recommendation-copy.ts`:

```ts
import type { NeedsAnswer } from '../../lib/api';

export const NEEDS_QUESTION = 'Do you want expressive and/or multilingual audio?';

export function needsAnswerLabel(answer: NeedsAnswer): string {
  return answer === 'expressive-or-multilingual'
    ? 'Yes — expressive and/or non-English'
    : 'No — simple English narration';
}

export const RECOMMENDED_BADGE = 'Recommended for you';

const DISPLAY: Record<'kokoro' | 'qwen' | 'coqui', string> = {
  kokoro: 'Kokoro',
  qwen: 'Qwen3-TTS',
  coqui: 'Coqui XTTS v2',
};
export function engineDisplayName(id: 'kokoro' | 'qwen' | 'coqui'): string {
  return DISPLAY[id];
}
```

- [ ] **Step 4: Run the copy-helper test to verify it passes**

Run: `npx vitest run src/components/setup/engine-recommendation-copy.test.ts`
Expected: PASS.

- [ ] **Step 5: Build a Provider-backed `renderStepVoice` harness and migrate the existing tests**

**Critical — there is NO `renderStepVoice` today.** `src/components/setup/step-voice.test.tsx` currently `render(<StepVoice readiness={…} onRefetch={…} />)` **inline with no redux Provider** across ~6 tests (they pass differing `readiness`: all-pass, `crashed`, `starting`). Task 5 adds `useAppDispatch` to `StepVoice`, which makes a Provider **mandatory** — so the harness must exist and every current test must route through it, or Task 5 lands 6 red tests. Build it now (this task adds no redux to the component yet, so the Provider is harmless here and ready for Task 5).

**Copy `step-defaults.test.tsx`'s exact store + module-mock pattern — do NOT invent one.** Verified against the code: `account-slice.ts` exports `accountSlice` **named** (no default export), so use `accountSlice.reducer` + `accountSlice.getInitialState()`. `saveAccountSettings` calls `api.putUserSettings(patch)` and its `.fulfilled` does `Object.assign(s, a.payload)`, so the test must stub `putUserSettings` to **echo** `{...getInitialState(), ...patch}` or the account state never updates. And under vitest `VITE_USE_MOCKS` is **false** (`.env.development` = `false`, no `.env.test`), so `api.getModelsStatus` is the REAL fetch — every test must keep its own `vi.spyOn(api, 'getModelsStatus').mockResolvedValue(...)` (as the 6 existing tests already do).

At the **top of `step-voice.test.tsx`**, add the module mock (copied verbatim from `step-defaults.test.tsx:15-30` — it `importActual`s so `getModelsStatus` stays real for the per-test spies, and only overrides `putUserSettings`):

```tsx
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';

const putUserSettingsMock = vi.fn();
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      putUserSettings: (patch: unknown) => {
        putUserSettingsMock(patch);
        return Promise.resolve({ ...accountSlice.getInitialState(), ...(patch as object) });
      },
    },
  };
});
```

> Adapt the `api: { ...actual.api, putUserSettings }` shape to whatever `step-defaults.test.tsx` actually does — mirror it exactly (it may override the top-level export instead of the `api` object; copy the working form). `saveAccountSettings` dispatches through `api.putUserSettings`, so that's the binding the stub must intercept. `beforeEach(() => putUserSettingsMock.mockReset())`.

Then add the harness (reuses the suite's existing `allPassReadiness` const — a **value**, not `passingReadiness()`):

```tsx
function renderStepVoice(opts: { readiness?: SetupReadiness; account?: Partial<ReturnType<typeof accountSlice.getInitialState>> } = {}) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: { account: { ...accountSlice.getInitialState(), ...opts.account } },
  });
  const utils = render(
    <Provider store={store}>
      <StepVoice readiness={opts.readiness ?? allPassReadiness} onRefetch={() => {}} />
    </Provider>,
  );
  return { ...utils, store };
}
```

Then **rewrite all 6 existing tests**: each keeps its own leading `vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus({…}))`, and its `render(<StepVoice readiness={X} onRefetch={…} />)` becomes `renderStepVoice({ readiness: X })` (the two tests that build an inline `readiness` pass it through; the rest omit it and get `allPassReadiness`).

- [ ] **Step 6: Write the failing new-behavior tests**

Add to `step-voice.test.tsx`:

```tsx
it('shows the guided question and, once answered "yes", leads with the recommended engine', async () => {
  renderStepVoice(); // mock getModelsStatus returns the Task-3 recommendation (qwen lead, CPU caveat)
  expect(await screen.findByText(/expressive and\/or multilingual/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('radio', { name: /yes — expressive/i }));

  const badge = await screen.findByText(/recommended for you/i);
  // The recommended (Qwen) card leads: the badge sits on the qwen card wrapper.
  expect(badge.closest('[data-engine-card="qwen"]')).not.toBeNull();
  // CPU-only mock → Qwen caveat shown, neutral (sky) not an amber blocker.
  expect(screen.getByTestId('recommendation-caveat')).toHaveTextContent(/may not fit/i);
});

it('answering "no" recommends Kokoro', async () => {
  renderStepVoice();
  await userEvent.click(await screen.findByRole('radio', { name: /no — simple english/i }));
  const badge = await screen.findByText(/recommended for you/i);
  expect(badge.closest('[data-engine-card="kokoro"]')).not.toBeNull();
});
```

> **Assertion note (finding #5):** do NOT `getByText(/Kokoro/i)` for ordering — with Qwen leading, "Kokoro" also appears in the "Other engines" `<summary>` preview string, so `getByText` throws on multiple matches. Anchor on the `data-engine-card` wrapper instead (emitted by Step 7).

- [ ] **Step 7: Run tests to verify they fail**

Run: `npx vitest run src/components/setup/step-voice.test.tsx`
Expected: FAIL — no guided-question radios / no "Recommended for you" badge.

- [ ] **Step 8: Implement the guided question + ordering in `step-voice.tsx`**

Add state + a small `RecommendedBadge`, and render cards ordered by the active recommendation. Key edits (keep the existing badges/runtime/venv block untouched):

```tsx
import { NEEDS_QUESTION, needsAnswerLabel, RECOMMENDED_BADGE, engineDisplayName } from './engine-recommendation-copy';
import type { NeedsAnswer, EngineRecommendation } from '../../lib/api';

// …inside StepVoice, after `const [models, setModels] = useState…`
const [needs, setNeeds] = useState<NeedsAnswer | null>(null);

const activeRec: EngineRecommendation | null =
  models && needs
    ? needs === 'expressive-or-multilingual'
      ? models.recommendation.expressiveOrMultilingual
      : models.recommendation.simpleEnglish
    : null;
```

Render the question above the cards (inside the `models !== null` branch, before `<VenvBootstrap …>`):

```tsx
<fieldset className="rounded-2xl border border-ink/10 p-4 space-y-2">
  <legend className="text-sm font-medium text-ink px-1">{NEEDS_QUESTION}</legend>
  {(['expressive-or-multilingual', 'simple-english'] as NeedsAnswer[]).map((a) => (
    <label key={a} className="flex items-center gap-2 text-sm text-ink/80 min-h-[44px] fine-pointer:min-h-0">
      <input
        type="radio"
        name="voice-needs"
        checked={needs === a}
        onChange={() => setNeeds(a)}
      />
      {needsAnswerLabel(a)}
    </label>
  ))}
</fieldset>
```

Order the engine cards by `activeRec`. Define an ordered id list and render generically. Replace the fixed Kokoro-lead + "More voice engines" block with:

```tsx
const ALL: Array<'kokoro' | 'qwen' | 'coqui'> = ['kokoro', 'qwen', 'coqui'];
const leadId = activeRec?.engine ?? 'kokoro';
const ordered = [leadId, ...ALL.filter((id) => id !== leadId)];

const CARD: Record<'kokoro' | 'qwen' | 'coqui', () => JSX.Element> = {
  kokoro: () => <KokoroInstall status={models.engines.kokoro} onInstalled={refetchBoth} />,
  qwen: () => <QwenInstall status={models.engines.qwen} onInstalled={refetchBoth} />,
  coqui: () => <CoquiInstall status={models.engines.coqui} onInstalled={refetchBoth} />,
};
```

Then render lead + rest (the lead wrapped with the badge + caveat):

```tsx
<div data-engine-card={leadId} className="space-y-2">
  {activeRec && (
    <div className="space-y-1">
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
        {RECOMMENDED_BADGE}
      </span>
      {activeRec.caveat && (
        <p data-testid="recommendation-caveat" className="text-xs text-sky-700">{activeRec.caveat}</p>
      )}
    </div>
  )}
  {CARD[leadId]()}
</div>

<details className="group rounded-2xl border border-ink/10" open={!activeRec}>
  <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink select-none">
    <span>{activeRec ? 'Other engines' : 'More voice engines'}</span>
    <span className="text-xs text-ink/50 group-open:hidden">
      {ordered.slice(1).map(engineDisplayName).join(' · ')}
    </span>
    <span className="text-xs text-ink/50 hidden group-open:inline">Hide</span>
  </summary>
  <div className="px-4 pb-4 space-y-4">
    {ordered.slice(1).map((id) => (
      <div key={id} data-engine-card={id}>{CARD[id]()}</div>
    ))}
  </div>
</details>
```

Keep `VenvBootstrap` above this block (runtime is shared, engine-agnostic). Wrap the Kokoro lead case with `data-engine-card="kokoro"` too (already handled by the `data-engine-card={leadId}` wrapper). Remove the now-unused hardcoded Qwen-auto-install paragraph, or fold its Qwen/Coqui hint into the "Other engines" body.

> **De-defaulting note:** this replaces the fixed "Kokoro leads, others hidden under *More voice engines*" structure with derived ordering. That IS the "stop labelling Kokoro the default" acceptance item — no copy anywhere should call any engine "the default voice engine."
>
> **"Pull priority" = presentation, not a queue (finding #6):** there is no fe-49 pull *queue* to reprioritize — each install card fires its own independent install job on click. "Prioritize the recommended engine's pull" is therefore satisfied by making that engine lead with the primary/emphasized Install CTA (the lead card's CTA is the visually dominant one; the others sit under the "Other engines" disclosure). Do **not** wire anything into fe-49's install machinery — that acceptance item is met by ordering + CTA emphasis alone.

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run src/components/setup/step-voice.test.tsx`
Expected: PASS (the 6 migrated tests + the 2 new ones).

- [ ] **Step 10: Commit**

```bash
git add src/components/setup/engine-recommendation-copy.ts src/components/setup/engine-recommendation-copy.test.ts src/components/setup/step-voice.tsx src/components/setup/step-voice.test.tsx
git commit -m "feat(frontend): guided question + recommendation-driven voice-engine ordering"
```

---

## Task 5: Defaults handoff — seed `defaultTtsModelKey` on answer

When the user answers the guided question, pre-seed the account default to the recommended model key so the Defaults step shows it pre-selected (the user reconfirms there).

**Files:**
- Modify: `src/components/setup/step-voice.tsx`
- Test: `src/components/setup/step-voice.test.tsx`

**Interfaces:**
- Consumes: `activeRec.modelKey` (Task 4); `saveAccountSettings` (`src/store/…` account slice, the same thunk `step-defaults.tsx` uses); `useAppDispatch` (`src/store`).
- Produces: dispatched `saveAccountSettings({ defaultTtsModelKey, defaultTtsModelKeyExplicit: true, defaultTtsEngine: 'local' })`.

- [ ] **Step 1: Write the failing test**

Add to `src/components/setup/step-voice.test.tsx`. The `renderStepVoice` harness (returns `{ store }`) and the `putUserSettings` echo mock were **already built in Task 4 Step 5** — this test just needs the leading `getModelsStatus` spy + the assertion. The echo mock makes `saveAccountSettings` resolve `.fulfilled` with `{...getInitialState(), ...patch}`, so the account state actually updates:

```tsx
it('seeds defaultTtsModelKey when the recommendation is answered', async () => {
  vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus()); // qwen-lead recommendation
  const { store } = renderStepVoice();
  await userEvent.click(await screen.findByRole('radio', { name: /yes — expressive/i }));
  await waitFor(() => {
    expect(putUserSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTtsModelKey: 'qwen3-tts-0.6b', defaultTtsModelKeyExplicit: true, defaultTtsEngine: 'local' }),
    );
    expect(store.getState().account.defaultTtsModelKey).toBe('qwen3-tts-0.6b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/setup/step-voice.test.tsx -t "seeds defaultTtsModelKey"`
Expected: FAIL — no dispatch happens on answer; `defaultTtsModelKey` unchanged.

- [ ] **Step 3: Wire the handoff**

In `step-voice.tsx`:

```tsx
import { useAppDispatch } from '../../store';
import { saveAccountSettings } from '../../store/account-slice'; // match the import path step-defaults.tsx uses

// …inside StepVoice
const dispatch = useAppDispatch();

const chooseNeeds = useCallback(
  (answer: NeedsAnswer) => {
    setNeeds(answer);
    if (!models) return;
    const rec =
      answer === 'expressive-or-multilingual'
        ? models.recommendation.expressiveOrMultilingual
        : models.recommendation.simpleEnglish;
    void dispatch(
      saveAccountSettings({
        defaultTtsModelKey: rec.modelKey,
        defaultTtsModelKeyExplicit: true,
        defaultTtsEngine: 'local',
      }),
    );
  },
  [dispatch, models],
);
```

Change the radio `onChange={() => setNeeds(a)}` to `onChange={() => chooseNeeds(a)}`.

> **Reconfirmation is intentional** (spec): the Models-step pick is a *suggestion*; `step-defaults.tsx` is the *commit*. `defaultTtsModelKeyExplicit: true` stops a later resolved default from silently overriding the seed — matching `step-defaults`/`model-settings-form` behavior exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/setup/step-voice.test.tsx`
Expected: PASS (all step-voice tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-voice.tsx src/components/setup/step-voice.test.tsx
git commit -m "feat(frontend): seed default voice model from wizard recommendation"
```

---

## Task 6: E2E golden path + regression plan + release notes

Lock the cross-seam behavior (fetch → redux → layout) with one Playwright spec, and close the before-shipping checklist.

**Files:**
- Create: `e2e/setup-engine-recommendation.spec.ts`
- Create: `docs/features/259-fe51-engine-recommendation.md`
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: the mock `getModelsStatus` recommendation (Task 3) — e2e runs in Vite mock mode.

- [ ] **Step 1: Write the e2e spec**

Create `e2e/setup-engine-recommendation.spec.ts`. Navigate to the wizard's Voice step (reuse the Next-click pattern from `e2e/setup-*.spec.ts` — **the Voice step is stepIndex 3 post-fe-49**; count the clicks against the current wizard, do not hardcode a stale count):

```ts
import { test, expect } from '@playwright/test';

test('answering the guided question leads with the recommended engine', async ({ page }) => {
  await page.goto('/#/setup');
  // …advance to the Voice step (see sibling setup specs for the exact Next sequence)…
  await expect(page.getByText(/do you want expressive and\/or multilingual/i)).toBeVisible();

  await page.getByRole('radio', { name: /yes — expressive/i }).click();
  await expect(page.getByText(/recommended for you/i)).toBeVisible();
  // Recommended (Qwen) card is not buried under the disclosure.
  await expect(page.getByTestId('recommendation-caveat')).toContainText(/may not fit/i); // CPU-only mock
});
```

> **Wizard step-count caution (from fe-49's post-mortem):** a Next-click count is fragile. Run the FULL e2e suite locally before pushing — `npm run test:e2e` — not just this one spec; a step-order assumption here or in a sibling `setup-*.spec.ts` only surfaces across the whole suite.

- [ ] **Step 2: Run the e2e spec**

Run: `npm run test:e2e -- setup-engine-recommendation`
Expected: PASS. Then `npm run test:e2e` (full suite) Expected: PASS (no sibling step-count regressions).

- [ ] **Step 3: Write the regression plan**

Create `docs/features/259-fe51-engine-recommendation.md` from `docs/features/TEMPLATE.md` (verify `259` is still free; bump if a concurrent plan claimed it). `status: active`. Cover: the guided question; capability-hard-filter / VRAM-soft-caveat invariant; the four recommendation cases (incl. the **deliberate case-4 revision** — CPU-only + "yes" → Qwen-with-CPU-caveat, not Kokoro); the defaults handoff via `defaultTtsModelKey` (+ reconfirmation in Defaults); the de-defaulting (no "default voice engine" copy). Cite the spec and `#1614`. **Include the on-box acceptance item** below.

> **On-box acceptance item (record in the plan):** the caveat tells a low/no-VRAM user they can *run Qwen on CPU (slower) via the voice-engine device setting*. Confirm on-box that forcing the device to CPU **actually renders** (per the product owner it does — slow, not crashing; distinct from the constrained-*GPU* auto-fallback OOM path in #1155/1.7B storms). If forcing CPU turns out not to render, soften the caveat to drop the CPU-mode offer and keep only the "pick Kokoro" nudge.

- [ ] **Step 4: Update INDEX + release notes**

- `docs/features/INDEX.md` — add the new plan under its area (setup/wizard).
- `docs/release-notes-next.md` — technical entry, PR-refed: "fe-51: first-run wizard recommends the voice engine from a one-question needs check + detected VRAM (Qwen for expressive/multilingual, Kokoro for simple English), pre-seeds the default, and stops hardcoding Kokoro. `Closes #1614`."
- `RELEASE_NOTES.md` — brand-voice user line in the in-progress version section: e.g. *"First run now asks one question and picks the right voice engine for your books and your machine — no more guessing."*

- [ ] **Step 5: Commit**

```bash
git add e2e/setup-engine-recommendation.spec.ts docs/features/259-fe51-engine-recommendation.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "test(frontend): e2e for wizard engine recommendation + regression plan + release notes"
```

- [ ] **Step 6: Full branch verification**

Run: `npm run verify:fast:branch`
Expected: PASS. Then open the PR (`Closes #1614`), let cloud `verify.yml` + the mandatory Premium `code-review` (single-scope `feat` → `medium` effort) run, triage findings, merge.

---

## Self-Review

> **Post-review revisions (2026-07-15) — TWO adversarial `assumption-checker` passes.** Pass 1 caught two blockers (non-existent harness; silent spec-case-4 override) + the data-driven/YAGNI items. Pass 2 caught that the pass-1 harness *fix* was still non-functional (wrong reducer import, missing `getModelsStatus` spy + `putUserSettings` echo — all now corrected against `account-slice.ts`/`step-defaults.test.tsx`) and a leftover spec↔plan contradiction (spec step-2 said VRAM *reorders* the capable set; reconciled to caveat-only, matching the plan). The one **deliberate divergence** — CPU-only + "yes" → Qwen-with-CPU-caveat, not the spec's case-4 "→ Kokoro" — is a **user-approved decision**, flagged in Global Constraints + Task 2 + the spec, not silent.

**Spec coverage** (Part B section of the design doc):
- Guided question → Task 4. ✅
- Yes → Qwen, Coqui optional alternate → Task 1 (`capablePreferenceRank`) + Task 2 (data-driven capable filter/sort) + Task 4 (`alternate` under "Other engines"). ✅
- No → Kokoro → Task 2 (`simpleEnglish`). ✅
- Capability hard filter / VRAM soft caveat → Task 2 logic + Global Constraints. ✅
- VRAM `<` floor → caveat, never downgraded → Task 2 (need+low-VRAM, need+null cases). ✅
- CPU-only / no-GPU + "yes" → **DELIBERATE REVISION of spec case-4** (Qwen+caveat, not Kokoro) — user-approved, flagged in Global Constraints + Task 2. ⚠️ (documented divergence, not silent)
- Grounded capability map (multilingual **derived** from `ENGINE_LANGUAGE_SUPPORT`; expressive load-bearing in the filter; VRAM floors authored estimates) → Task 1 + Task 2 (`isMultilingualEngine`). ✅
- Defaults handoff via `defaultTtsModelKey` (+ `Explicit`, `defaultTtsEngine: 'local'`), reconfirmed in Defaults → Task 5. ✅
- Drop "the default voice engine" copy / pull-priority (presentation) → Task 4 (derived ordering + primary CTA + de-default + pull-priority notes). ✅
- Tests: needs × capability × VRAM → engine (server unit) → Task 2; the three Part-A status regressions stay in Part A's suite; recommendation UI e2e → Task 6. ✅
- `Closes #1614` (fe-49 merged) → header + Task 6. ✅
- `designVramFloorMb` (in the spec's draft `EngineCapability`) → **intentionally omitted** (YAGNI — no Part B consumer); noted in Task 1. ⚠️

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — every code step carries actual content. VRAM floors are concrete authored estimates (refine on-box if contradicted — a documented instruction, not a placeholder). ✅

**Type consistency:** `NeedsAnswer`, `EngineRecommendation`, `RecommendationSet`, `recommendEngines`, `isMultilingualEngine`, `capablePreferenceRank`, `RECOMMENDED_BADGE`, `engineDisplayName`, and the `defaultModelKey` values (`kokoro-v1`/`qwen3-tts-0.6b`/`coqui-xtts-v2`) are named identically across server (Tasks 1–3), the client mirror (Task 3), and consumers (Tasks 4–5). The `CAPABLE_PREFERENCE` hardcoded array from the first draft is **gone** — replaced by the data-driven filter + `capablePreferenceRank`. ✅

**Test-harness blast radius (was blocker #2):** Task 4 Step 5 creates the Provider-backed `renderStepVoice` and migrates all 6 existing inline renders **before** Task 5 adds redux to the component — so no test lands red. ✅

**Open items deliberately carried (not placeholders):** (1) VRAM floor numbers — authored estimates, refine on-box (Task 1); (2) on-box confirmation that forcing Qwen to CPU actually renders, with the caveat-softening fallback if not (Task 6).
