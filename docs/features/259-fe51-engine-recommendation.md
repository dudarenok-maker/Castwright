---
status: active
shipped: null
owner: null
---

# fs-38 Part B / fe-51 — Wizard language-aware engine recommendation

> Status: active
> Key files: `server/src/tts/voice-engine-registry.ts`, `server/src/tts/engine-recommendation.ts`,
> `server/src/tts/models-status.ts`, `src/lib/api.ts` (`ModelsStatus.recommendation`,
> `mockGetModelsStatus`), `src/components/setup/engine-recommendation-copy.ts`,
> `src/components/setup/step-voice.tsx`
> URL surface: `#/setup` (Voice step, step 4 of 7)
> OpenAPI ops: none — `recommendation` rides the existing hand-written
> `GET /api/setup/models-status` payload (Part A), not openapi-generated

Closes #1614 (fe-51, child of epic #1613). Builds on
[258 — fs-38 Part A: wizard models-status single source of truth](258-wizard-models-status.md)
(depends on #1612 / PR #1644 — the `VOICE_ENGINES` registry, the `ModelsStatus` payload,
and the controlled install cards) and
[257 — fe-49: analyzer/voice wizard split](257-fe49-analyzer-wizard-split.md) (Voice is step 4
of 7). Spec:
`docs/superpowers/specs/2026-07-14-wizard-models-status-and-recommendation-design.md` (Part B
section, amended 2026-07-15). Plan:
`docs/superpowers/plans/2026-07-15-fe51-language-aware-engine-recommendation.md`.

## Benefit / Rationale

- **User:** The Voice step no longer hardcodes "Kokoro is the default voice engine." It asks
  one guided question — "Do you want expressive and/or multilingual audio?" — and leads with
  the engine that actually fits: Qwen (Coqui as an optional alternate) for expressive or
  non-English work, Kokoro for simple English narration. The answer also pre-seeds the account's
  default voice model, so the Defaults step shows the right pick already selected.
- **Technical:** The recommendation is precomputed server-side for **both** possible answers
  and rides Part A's existing `models-status` fetch — the wizard adds no new endpoint and no
  new round-trip. The capable engine set is **derived** (`expressive || isMultilingualEngine`),
  not hardcoded, so a future expressive/multilingual engine qualifies automatically without a
  code change to the recommendation logic itself (only a registry entry).
- **Architectural:** Locks a **capability-hard-filter / VRAM-soft-caveat** invariant: an
  engine that cannot serve the stated need is never recommended, and detected VRAM never
  reorders or downgrades the capable branch — it only ever attaches an informational caveat.
  This is the invariant the deliberate case-4 revision (below) exists to protect.

## Architectural impact

- **New seams / extension points:**
  - `server/src/tts/engine-recommendation.ts` — pure `recommendEngines(vramTotalMb)` +
    `isMultilingualEngine(id)`. No I/O; takes VRAM in, returns a `RecommendationSet` for both
    answers.
  - Authored capability fields on `VOICE_ENGINES` (`server/src/tts/voice-engine-registry.ts:35,39,44`):
    `expressive: boolean`, `genVramFloorMb: number`, `capablePreferenceRank: number`. Kokoro
    `expressive:false` / rank `99` (sentinel — never enters the capable set); Qwen
    `expressive:true` / floor `6144` / rank `0` (leads); Coqui `expressive:true` / floor `4096`
    / rank `1` (alternate).
  - `ModelsStatus.recommendation: RecommendationSet` (`server/src/tts/models-status.ts:34,71`),
    mirrored by hand onto the client `ModelsStatus` type and `mockGetModelsStatus()`
    (`src/lib/api.ts`) — same hand-mirror convention Part A established (no generated type).
  - `src/components/setup/engine-recommendation-copy.ts` — pure presentation strings
    (`NEEDS_QUESTION`, `needsAnswerLabel`, `RECOMMENDED_BADGE`, `engineDisplayName`), kept out
    of the component body and independently unit-tested.
  - `step-voice.tsx`: `needs` local state, `activeRec` derivation
    (`src/components/setup/step-voice.tsx:105,107`), `chooseNeeds` handler
    (`step-voice.tsx:114`) that both sets `needs` and dispatches the Defaults handoff, and
    derived card ordering keyed off `activeRec?.engine` (`step-voice.tsx:211`) replacing the
    old fixed Kokoro-lead layout.
- **Invariants preserved:**
  - Part A's single-fetch/controlled-card contract (plan 258) is unchanged — `recommendation`
    is an **additive** field on the same `ModelsStatus` payload; no second fetch, no new
    self-fetching card.
  - `defaultTtsModelKey` (not `defaultTtsEngine`) carries the kokoro/qwen/coqui choice;
    `defaultTtsEngine: 'local'` is set alongside it because every recommended engine here is
    on-device. `defaultTtsModelKeyExplicit: true` prevents a later resolved default from
    silently clobbering the seed — the same convention `step-defaults.tsx` already uses.
  - Nothing is ever blocked: every engine stays installable regardless of the recommendation:
    the unanswered state and the "Other engines" disclosure both still render all three cards.
- **Migration story:** none — `recommendation` is additive on a request/response type, not a
  persisted shape. No `state.json`/`cast.json`/`openapi.yaml` change.
- **Reversibility:** UI + a pure server function feeding an existing read-only endpoint;
  reverting restores the fixed Kokoro-lead card order and drops the guided question with no
  data cleanup.

## Invariants to preserve

- **Capability is a hard filter; VRAM is a soft preference.** The capable set for
  "expressive-or-multilingual" is `VOICE_ENGINES.filter(e => e.expressive ||
  isMultilingualEngine(e.id))`, sorted by `capablePreferenceRank`
  (`server/src/tts/engine-recommendation.ts:48-55`). VRAM (`fits` at
  `engine-recommendation.ts:58`) only ever selects between `caveat: null` and the CPU caveat
  string (`engine-recommendation.ts:67`) — it never changes `capable[0]` (the lead) or
  `alternate`. Locked by `server/src/tts/engine-recommendation.test.ts:23,31,38`.
- **`simpleEnglish` is always Kokoro, unconditionally.** No VRAM branch, no caveat, no
  alternate, regardless of detected VRAM (incl. `null`/CPU-only). Locked by
  `engine-recommendation.test.ts:13`.
- **The CPU-only / no-GPU + "yes" case deliberately still leads Qwen** (a flagged revision of
  the design spec's literal case-4, which said "CPU-only → Kokoro" — see Global Constraints in
  the implementation plan). Rationale: Qwen runs on CPU (slower, via the voice-engine device
  setting); the single guided question cannot distinguish a non-English need (which Kokoro
  literally cannot serve) from expressive-English (which Kokoro *can* serve). Recommending
  Kokoro here would hand a non-English user an engine that cannot do their language at all.
  Locked by `engine-recommendation.test.ts:38` (`vramTotalMb: null` → `engine: 'qwen'`,
  `caveat` matches `/may not fit/i`).
- **The four recommendation cases**, all locked in `engine-recommendation.test.ts`:
  1. Simple English → Kokoro, no caveat, any VRAM (`:13`).
  2. Expressive/multilingual + adequate VRAM (>= Qwen's `genVramFloorMb`, 6144) → Qwen,
     Coqui alternate, no caveat (`:23`).
  3. Expressive/multilingual + low VRAM (< 6144, e.g. 4096) → Qwen with the CPU caveat, never
     downgraded to Kokoro (`:31`).
  4. Expressive/multilingual + CPU-only (`vramTotalMb: null`) → Qwen with the CPU caveat, still
     not Kokoro — **the deliberate case-4 revision** (`:38`).
- **Caveat wording is truthful, not alarming.** The caveat string (`CAVEAT_VRAM`,
  `engine-recommendation.ts:34`) reads *"May not fit this GPU's memory — you can run Qwen on
  CPU (slower) via the voice-engine device setting, or pick Kokoro below for fast English-only
  voices."* It renders in neutral sky styling (`data-testid="recommendation-caveat"`,
  `step-voice.tsx:229`), never amber/rose blocker styling — this is a preference note, not a
  setup failure. The client mock's copy of this string
  (`src/lib/api.ts` `mockGetModelsStatus`) is a hand-copy tagged `// keep in sync with server
  CAVEAT_VRAM` — every assertion against it (test and e2e) matches `/may not fit/i`
  substring, not exact equality, so drift between the two can't silently break a test; the
  real runtime caveat always comes from the server.
- **Defaults handoff, with reconfirmation.** Answering the guided question dispatches
  `saveAccountSettings({ defaultTtsModelKey: rec.modelKey, defaultTtsModelKeyExplicit: true,
  defaultTtsEngine: 'local' })` (`step-voice.tsx:122-127`). This is a **suggestion**, not a
  silent commit — `step-defaults.tsx`'s "Voice model" dropdown shows it pre-selected and the
  user reconfirms there (no new plumbing needed on the Defaults side — it already reads/writes
  `defaultTtsModelKey`). Locked by `step-voice.test.tsx:236`.
- **De-defaulting: no "default voice engine" copy anywhere.** The fixed "Kokoro leads, others
  hidden under *More voice engines*" layout is gone — card order is derived from `activeRec`
  (`step-voice.tsx:211`, `ordered = [leadId, ...ALL.filter(id => id !== leadId)]`). Unanswered
  state still shows Kokoro first (today's historical default) but the disclosure is labeled
  "More voice engines," not "the default"; once answered, the disclosure relabels to "Other
  engines" (`step-voice.tsx:240`) and the badge is the only "recommended" language used.
  "Pull priority" is presentation only (lead card + primary CTA) — no fe-49 install-queue
  reordering was added or needed.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/voice-engine-registry.test.ts:32,46`) — every engine carries
  authored `expressive`/`genVramFloorMb`/`capablePreferenceRank`; every floor is positive.
- Vitest server (`server/src/tts/engine-recommendation.test.ts:5,13,23,31,38`) —
  `isMultilingualEngine` derivation (qwen/coqui true, kokoro false); the four recommendation
  cases above, including the deliberate case-4 revision.
- Vitest server (`server/src/tts/models-status.test.ts:75`) — `buildModelsStatus` surfaces a
  `recommendation` derived from `info.vramTotalMb` end to end (high VRAM → no caveat; low VRAM
  → caveat matches `/may not fit/i`).
- Vitest unit (`src/components/setup/engine-recommendation-copy.test.ts:5,10`) — the guided
  question + answer-label copy mentions expressive/multilingual/English; engine id → display
  name mapping.
- Vitest unit (`src/components/setup/step-voice.test.tsx:214,228,236`) — answering "yes" leads
  with the Qwen card (`data-engine-card="qwen"`) badged "Recommended for you" with the CPU
  caveat visible; answering "no" leads with Kokoro; answering seeds
  `defaultTtsModelKey`/`defaultTtsModelKeyExplicit`/`defaultTtsEngine` via
  `saveAccountSettings` and the redux `account` slice reflects it.
- Playwright e2e (`e2e/setup-engine-recommendation.spec.ts`) — drives the wizard to the Voice
  step (step 4 of 7, same Next-click sequence as `e2e/setup-models-status.spec.ts`), asserts
  the guided question is visible before any answer, clicks "Yes — expressive and/or
  non-English," and asserts the "Recommended for you" badge and the
  `recommendation-caveat` testid (matching `/may not fit/i`, from the CPU-only mock fixture)
  are both visible, plus that the Qwen card (`[data-engine-card="qwen"]`) is the one carrying
  them — the cross-seam (fetch → redux → layout) golden path through a real browser rather
  than mocked React state.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) unless noted.

1. **Cold Voice step, unanswered.** `#/setup` → advance to the Voice step. Expected: the
   guided question renders with both radios unchecked; cards render in today's historical
   order (Kokoro lead, "More voice engines" disclosure open, no badge anywhere).
2. **Answer "yes."** Click "Yes — expressive and/or non-English." Expected: the Qwen card
   moves to the lead position, badged "Recommended for you," with a neutral sky note reading
   "May not fit this GPU's memory…" (the mock fixture is CPU-only); the disclosure relabels to
   "Other engines" and collapses; Kokoro and Coqui still render underneath, both still
   installable.
3. **Answer "no."** Reload, answer "No — simple English narration" instead. Expected: Kokoro
   leads with the "Recommended for you" badge and no caveat; Qwen/Coqui render under "Other
   engines."
4. **Defaults reconfirmation.** After step 2, advance to the Defaults step. Expected: "Voice
   model" shows Qwen (`qwen3-tts-0.6b`) pre-selected, not silently applied — the user can still
   change it before Finish.
5. **On-box acceptance item (real hardware, not mock mode) — owed.** The CPU caveat tells a
   low/no-VRAM user they can *run Qwen on CPU (slower) via the voice-engine device setting*.
   Confirm on a real box that forcing the voice-engine device setting to CPU actually renders
   audio (per the product owner it does — slow, not crashing; this is distinct from the
   constrained-*GPU* auto-fallback OOM history in #1155/1.7B storms, a different failure path).
   **If forcing CPU turns out not to render**, soften `CAVEAT_VRAM`
   (`server/src/tts/engine-recommendation.ts:34`, and its client hand-copy in
   `src/lib/api.ts`'s `mockGetModelsStatus`) to drop the CPU-mode offer and keep only the "pick
   Kokoro below" nudge.

## Out of scope

- **Reordering fe-49's install machinery.** "Prioritize the recommended engine's pull" is
  satisfied by card ordering + primary-CTA emphasis alone — there is no install *queue* to
  reprioritize; each install card still fires its own independent job on click.
- **`designVramFloorMb`** (present in the design spec's draft `EngineCapability`) — no Part B
  consumer exists; intentionally omitted from the registry (YAGNI). Add it when the
  voice-design VRAM-steering feature actually needs it.
- **A third/fourth guided question or finer-grained needs taxonomy** — the spec scopes this to
  exactly one binary question; multi-axis needs (e.g. separating "expressive" from
  "multilingual") are a future extension, not this plan's surface.
- **Server-side VRAM-floor measurement.** `genVramFloorMb` values (Kokoro 1024, Qwen 6144,
  Coqui 4096) are authored estimates per the plan, not measured; refining them against real
  `qwen voice design:` numbers is future work, not blocking this ship.

## Ship notes

(Filled in when status flips to `stable`.)
