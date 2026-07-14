---
title: Setup wizard — single-source model status + language-aware engine recommendation
date: 2026-07-14
status: draft
issues:
  - "#1612 — bug: contradictory Kokoro / runtime status (badges vs cards)"
  - "#1614 — fe-51: language-aware voice-engine recommendation + pull priority"
epic: "#1613 — fs-75: harden the first-run setup wizard + healthcheck (1.14)"
---

# Setup wizard — single-source model status + language-aware engine recommendation

## Context

Beta feedback on the first-run wizard's **Models step** (Step 3 of 5) surfaced two
problems on the same surface (`src/components/setup/step-models.tsx`), both children
of epic **fs-75 (#1613)**:

1. **#1612 (bug) — the status is self-contradictory.** On one screen the summary
   badges disagree with the per-engine cards: a badge says *"kokoro is installed but
   its voice weights have not been downloaded"* while the card directly below says
   *"Kokoro is not installed"*; a badge says *"Runtime needed"* while the card says
   *"Voice engine runtime ready."* A first-run user cannot tell what is actually
   ready.

2. **#1614 (fe-51) — the wizard hard-defaults to Kokoro.** It funnels everyone to
   Kokoro ("the default voice engine"), but Kokoro is the light/simple engine —
   English-only and weak for multi-cast — so it is the wrong lead for a multilingual
   or multi-cast book, where Qwen (expressive, multilingual) or Coqui should lead.

The two are cohesive: both rework how the Models step *reports* and *recommends*
voice engines. This spec covers both, delivered as **two layers on one branch**:
Part A (status truthfulness — the foundation, ships first, no external dependency)
and Part B (recommendation — layered on top, composes with fe-49 for pull wiring).

### Why the status contradicts itself today

The Models step computes engine status from **two independent sources that never
reconcile**:

- **Summary badges** (`BlockerBadge`) read `readiness.blockers.sidecar` / `.tts`,
  aggregate diagnoses produced server-side by `diagnoseSidecar` / `diagnoseTts`
  (`server/src/routes/setup-diagnosis.ts`), fetched once by the wizard and passed
  down as a prop.
- **Per-engine cards** (`KokoroInstall`, `VenvBootstrap`, `QwenInstall`,
  `CoquiInstall`) each own their **own** `/detect` fetch and polling loop, fully
  self-contained, no shared state with the badges.

Three concrete defects fall out of that split:

- **Kokoro "installed vs not installed"** — the badge reports the granular
  `weights-missing` state; the Kokoro card *receives that same `state` field* in its
  detect response but branches only on the `installed` boolean, collapsing
  `weights-missing` → "not installed." Same disk source underneath
  (`detectKokoroInstallStateOnDisk`), different rendering.
- **"Runtime needed vs ready"** — the venv card measures the runtime **on disk**
  (venv present → "ready, all engines can load"); the sidecar badge measures the
  **live process** (`unreachable-transient` = "the voice engine is starting up").
  Both are individually true, both overload the word "runtime," and the transient
  startup state renders identically to a real "needs setup" blocker (amber).
- **Stale badges** — the emerald cards' manual "Re-check" does not consistently
  refresh the summary badge, leaving stale amber over a green card.

## Goals

- One consistent voice-engine status: badges and cards can never disagree, by
  construction, not by manual re-sync.
- Truthful runtime reporting: "installed" (on disk) and "running" (live process) are
  separate axes; a transient "starting up" is shown calmly, not as a blocker.
- Per-engine granularity is preserved and surfaced — a half-broken engine (e.g.
  Coqui's package fails to import) is always reported on its own card, even when the
  aggregate "can I make audio at all?" answer is green.
- A first-run user is guided to the **right** engine for their needs and hardware,
  and to the right download first — without being locked out of any engine.
- The status surface scales: adding a future TTS engine surfaces automatically
  rather than requiring a bespoke detect route + card wiring.

## Non-goals

- Reworking the analyzer section of the Models step (that is fe-49 #1610 / fe-50
  #1611, separate children of the epic).
- New engine-install *mechanics* (the install-job POST/poll flows stay as-is; only
  the *status/detect* source is unified).
- Inventing detection we do not have — see the honesty note in Part A.
- Auto-pulling weights (fe-49's principle: models are not auto-pulled).

---

## Part A — single source of truth for model status (#1612)

### Approach: A3 — one canonical server computation, one endpoint

Both the summary badges and the per-engine cards become **projections of one
server-side computation**. Divergence is structurally impossible because there is
only one source. This is a deliberate investment over the minimal per-defect fix
(A1), chosen because more TTS engines are coming and the status surface should be
done properly once.

### Server

**New module `server/src/tts/models-status.ts`** — the single canonical computation.
It iterates the **engine registry** (not a hardcoded kokoro/qwen/coqui list), so a
future engine appears automatically. It reuses the existing per-engine disk
detectors (`detect{Kokoro,Qwen,Coqui}InstallStateOnDisk`) and the sidecar `/health`
payload; it does **not** re-implement them.

Shape:

```ts
interface ModelsStatus {
  runtime: {
    installedOnDisk: boolean;   // venv present on disk (disk truth)
    pythonFound: boolean;       // only meaningful when !installedOnDisk
    process: 'ready' | 'starting' | 'down' | 'crashed';  // live liveness, separate axis
  };
  engines: Record<string /* engineId */, {
    installState: 'not-installed' | 'weights-missing' | 'ready';
    packageBroken: boolean;     // present in the venv but fails to import (live /health)
    loaded: boolean;            // resident in the sidecar now
    // usable is derived, not stored: installState === 'ready' && !packageBroken
  }>;
  info: {
    gpu: string;                // existing human string
    vramTotalMb: number | null; // NEW — from getDeviceTotalVramMb(); null on non-NVIDIA / no nvidia-smi
  };
}
```

**New route `GET /api/setup/models-status`** returns that object verbatim.

**`GET /api/setup/readiness` derives its `blockers.sidecar` and `blockers.tts` from
this module** instead of its own inline detect calls. So the summary badges (which
read `readiness.blockers`) and the per-engine cards (which read `models-status`) are
two views of one computation. `blockers.ffmpeg` and `blockers.analyzer` are
untouched.

**The `process` axis** maps the existing sidecar reachability + supervisor signals:
`unreachable-transient` → `starting`; `unreachable-no-supervisor` → `down`;
`supervisor-tripped` / `supervisor-exhausted` → `crashed`; reachable → `ready`. The
`installedOnDisk` axis is `sidecarVenvPresent()` — **completely independent** of
`process`.

### Aggregate vs per-engine — no masking

The existing `diagnoseTts` returns a single aggregate "pass if **any** engine is
usable." That is correct for the **summary badge** ("can I produce voice at all?")
but must never be the source for a **per-engine card**. The `engines.<id>` map
carries each engine's full, independent state, so:

- The **summary badge** answers only the roll-up question (green if any engine is
  usable).
- Each **per-engine card** answers "what is the state of *this* engine?" from its own
  slice — so the Coqui card shows *"Coqui is installed but its package failed to load
  — repair"* even while the summary badge is green because Kokoro is usable.

**Honesty limit:** cards surface only the broken states the system can actually
detect — `packageBroken` (import failure via `/health`) and `weights-missing`
(weights dir empty). We do not invent a "partially corrupt weights" signal we have no
probe for. This limit is documented rather than papered over.

### Client

- **The install cards become controlled.** `KokoroInstall`, `VenvBootstrap`,
  `QwenInstall`, `CoquiInstall` receive their status via a required prop instead of
  self-fetching `/detect`. They keep their own install-job POST + poll loop and their
  `onInstalled` callback; only the idle/detect status is lifted to the parent. On job
  completion → `onInstalled` → parent refetches `models-status` → fresh status flows
  back to badge and card together.
- **The Models step fetches `models-status` once** and derives **both** the summary
  badges **and** every card's status from that single response.
- **`model-manager.tsx` migrates in the same PR.** Its cards are rendered generically
  via `INSTALLER_BY_ID` with a `{ onInstalled }` shape; because the controlled cards
  now require a status prop, model-manager must feed it. It already polls inventory
  every 30 s (`INVENTORY_POLL_MS`) — status rides that same poll. This is a
  consequence of making the prop required (chosen over an optional self-fetch
  fallback to avoid an "optional-both-ways" smell), and it cleans up model-manager's
  status consistency for free.

### Status → UI mapping (the three fixes)

**Runtime (fixes contradiction #2):** two independent axes, never conflated.

- `runtime.installedOnDisk` drives the **venv card**: `false` → "not set up" (install
  CTA) or "Python missing" (manual instructions); `true` → green "Runtime installed."
- `runtime.process` drives a **separate liveness signal**: `ready` → subtle
  green / no badge; `starting` → **neutral blue "Voice engine starting…" pill, no
  amber, no fix-action**; `down` / `crashed` → amber/red with the appropriate
  fix-action.
- The summary badge label becomes **"Runtime installed"** (disk truth) rather than
  "Runtime ready/needed" (which conflated disk + process). A green "installed" card
  now coexists with a blue "starting…" pill — both true, no contradiction.

**Kokoro engine (fixes contradiction #1):** the card renders
`engines.kokoro.installState` verbatim:

- `not-installed` → "Kokoro is not installed" + Install CTA
- `weights-missing` → **"Kokoro is installed — voice weights not downloaded"** +
  "Download weights" CTA (identical wording to the badge, since both read the same
  field)
- `ready` → green "Kokoro is installed"

**Summary board + badges:** a shared client helper classifies each diagnosis as
`ok` / `attention` / `pending`, where **`pending` (transient `starting`) renders
neutral, not amber** — so the "Voice engines" summary row (`buildSummaryRows` in
`setup-wizard.tsx`) and the badge agree with the cards.

**Re-check (fixes contradiction #3):** every card's "Re-check" triggers the parent's
refetch of `models-status`. Since badge + card derive from that one response, they
update in lockstep — no stale amber over a green card. With controlled cards this is
automatic: there is only one fetch to refresh.

### Files (Part A)

- `server/src/tts/models-status.ts` (new) — canonical computation.
- `server/src/routes/models-status.ts` (new) — `GET /api/setup/models-status`.
- `server/src/routes/setup-readiness.ts` — derive `sidecar`/`tts` blockers from the
  module; surface `vramTotalMb`.
- `src/components/setup/step-models.tsx` — fetch once, derive badges + card status,
  pass controlled props.
- `src/components/{kokoro-install,venv-bootstrap,qwen-install,coqui-install}.tsx` —
  controlled (status via prop; keep job/poll).
- `src/views/model-manager.tsx` — feed status into `INSTALLER_BY_ID` rows.
- `src/components/setup/setup-wizard.tsx` — `buildSummaryRows` neutral `pending`.

---

## Part B — language-aware engine recommendation (fe-51 #1614)

Built on Part A's status surface.

### Capability map (grounded, not hardcoded)

A small table derived from the **existing eligibility source** (`fs-59` / `fs-60` /
`fs-70` language-code maps + `voice-mapping`) giving each engine:

```ts
interface EngineCapability {
  expressive: boolean;
  multilingual: boolean;
  genVramFloorMb: number;       // comfortable VRAM for the GENERATION path
  designVramFloorMb?: number;   // only for engines with a heavy design model (Qwen VoiceDesign 1.7B)
}
```

The recommendation **reads** this map rather than hardcoding "Qwen," so a future
engine that gains multilingual becomes eligible automatically. Rough floors, grounded
in the CLAUDE.md model-lifecycle notes (exact numbers pulled from real measurement /
the model registry, not guessed in code):

- **Kokoro** — ~1 GB; fits anything, incl. CPU. English-only, non-expressive.
- **Qwen Base 0.6B (generation)** — fits comfortably around 6 GB. Expressive,
  multilingual. The **VoiceDesign 1.7B** model (~4–5 GB, transient, only during
  cast-review voice design) is tracked as `designVramFloorMb` — a *separate* signal
  that governs the voice-design feature, **not** a reason to steer generation away
  from Qwen.
- **Coqui XTTS v2** — higher generation headroom; zero-shot cloning.

### The guided question

One needs-based question in the Models step, above the engine cards:

> *"Do you want expressive and/or multilingual audio?"*

- **Yes** → recommend the capability-map winner for `{expressive | multilingual}`
  (Qwen today), with Coqui offered as an optional alternate.
- **No** (English-only, non-expressive) → recommend Kokoro.

This replaces reasoning-about-engines or picking-a-language-cold with a single needs
question.

### VRAM as a soft preference, capability as a hard filter

The recommendation logic:

1. **Hard filter by capability** — never recommend an engine that cannot meet the
   stated need. If the user needs multilingual, Kokoro (English-only) is *not*
   eligible.
2. **Soft-prefer the lightest fitting engine** — among capable engines, prefer the
   lightest whose `genVramFloorMb` fits detected `vramTotalMb`.

Consequences:

- **Very low VRAM or CPU-only** (below Qwen-base's generation floor, or
  `vramTotalMb` null on a box with no capable GPU) → **recommend Kokoro** ("Recommended
  — runs comfortably on low VRAM / CPU"). Kokoro is genuinely the engine for very low
  VRAM or CPU-only machines.
- **~6 GB + expressive/multilingual need** → **recommend Qwen** (its 0.6B generation
  path fits), with a soft aside that *voice design* (the 1.7B model) may be tight on
  this GPU. We do **not** steer generation to Kokoro here.
- **Low VRAM but multilingual is needed** → recommend Qwen anyway (Kokoro literally
  cannot do the job) with a "low VRAM — will run on CPU, slower" caveat. We never
  steer someone to an engine that cannot meet their stated need.
- **Nothing is ever blocked.** Every engine stays installable and usable; the VRAM
  signal only changes which engine *leads* and what caveat is shown. Qwen/Coqui still
  install and run (on CPU, slower) on a low-VRAM box.

**This deliberately revises #1614's literal acceptance criterion** ("detected VRAM
< 6 GB → Kokoro recommended regardless"). That flat rule is inaccurate: Qwen's 0.6B
generation model runs fine at ~6 GB, and a hard Kokoro nudge there would wrongly cap
capable boxes and mis-serve multilingual needs. The revised rule — per-engine
generation floors, capability as a hard filter, VRAM as a soft preference — is called
out here so the divergence from the issue text is a deliberate, visible decision.

### Presentation

- The recommended engine's card **leads** with a **"Recommended for you"** badge +
  primary Install CTA (pull priority).
- **All engines stay installable.** The other engines remain present, just secondary;
  the "More voice engines" collapsible reframes as "Other engines" rather than
  implying Kokoro is the fixed default.
- Drop "the default voice engine" language throughout the wizard — the recommendation
  is *derived*, not fixed.

### Defaults handoff

The recommendation calls `saveAccountSettings({ defaultTtsEngine: <picked> })`,
pre-seeding the setting. The **Defaults step** (`step-defaults.tsx`) already reads and
re-syncs from `account.defaultTtsEngine`, so it shows the recommended engine
pre-selected and is where the user **reconfirms**. No new plumbing — the existing
account slice is the channel. Reconfirmation in a separate step is intentional: the
Models-step pick is a suggestion; the Defaults step is the commit.

### VRAM source

`getDeviceTotalVramMb()` (`server/src/gpu/device-total.ts`) already probes
`nvidia-smi --query-gpu=memory.total` once at server boot and caches it —
**sidecar-independent**, so it works before the venv/sidecar exist (exactly the
first-run case). Part A surfaces it as `info.vramTotalMb`. Null (non-NVIDIA / no
nvidia-smi) means "unknown" → no VRAM-based nudge beyond the CPU-only lean.

### Files (Part B)

- `src/components/setup/step-models.tsx` — guided question + recommendation
  presentation.
- `src/lib/models.ts` (or a new `src/lib/engine-capability.ts`) — capability map +
  pure recommendation function.
- `server/voice-mapping` / language-code maps — source for the capability map.
- `src/components/setup/step-defaults.tsx` — unchanged mechanics; receives the
  pre-seeded default.
- fe-49 (#1610) shared pull machinery — composed for pull-priority wiring.

---

## Data flow summary

```
                 server/src/tts/models-status.ts  (ONE computation)
                    /                        \
   GET /api/setup/readiness            GET /api/setup/models-status
   (blockers.sidecar/.tts derived)      (runtime + engines + info)
                    \                        /
              Models step: single fetch, derives BOTH
                    /                        \
            summary badges              per-engine cards (controlled)
       (roll-up: any engine usable)   (each engine's own state, no masking)
```

## Testing

Paired automated tests are required (testing-discipline rule), not optional.

- **Server unit — `models-status` module:** each engine's `installState` ×
  `packageBroken` × `loaded` → correct per-engine status; the readiness-blocker
  derivation (aggregate "pass if any usable"; a broken engine is *not* masked);
  `installedOnDisk` vs `process` independence; `vramTotalMb` surfacing (incl. null).
- **Server unit — recommendation function (pure, mirrors `diagnose*` tests):**
  needs-answer × capability map × `vramTotalMb` → recommended engine + caveats. Cover
  the four cases: no-need→Kokoro; need+adequate VRAM→Qwen; need+low VRAM→Qwen+CPU
  caveat; no capable GPU / CPU-only→Kokoro.
- **Frontend (Vitest + RTL) — `step-models.test.tsx`:** the three regressions
  (weights-missing card wording matches badge; `starting` renders neutral not amber;
  re-check refreshes the badge); controlled-card rendering; broken-Coqui-shown-while-
  Kokoro-green.
- **E2E (Playwright):** one spec on the Models step — badge/card consistency golden
  path (crosses redux/fetch/layout seams, so it earns an e2e).
- **Regression plan:** new doc under `docs/features/` for the wizard status surface;
  both issues cited.

## Sequencing & delivery

This `docs/wizard-models-status-recommendation` branch carries only the spec (and,
next, the plan). Implementation lands on its own branches per the execution model —
two PRs, Part A before Part B:

- **PR 1 — Part A (#1612):** canonical module + endpoint, readiness derivation,
  controlled cards, model-manager migration, the three status fixes. No fe-49
  dependency → ships first. `Closes #1612`.
- **PR 2 — Part B (fe-51 / #1614):** capability map, guided question, VRAM
  soft-recommendation, defaults handoff, copy de-defaulting. Built on PR 1; the
  pull-priority wiring composes with fe-49 (#1610) when it lands. `Closes #1614`
  (`Refs` if fe-49 gates full close).

Each PR runs the full before-shipping checklist: regression plan, release-notes-next
+ RELEASE_NOTES entries, verified issue link, `verify:fast:branch`, and the mandatory
`code-review` gate (Premium tier; single-scope `fix`/`feat` → `medium` effort).

## Risks & open questions

- **fe-49 dependency (Part B):** the recommendation/ordering/VRAM logic is
  independently buildable and testable; only the actual weights-pull wiring needs
  fe-49's shared machinery. If fe-49 slips, Part B ships with the recommendation +
  ordering + defaults handoff and a follow-up `Refs` for the pull-priority
  composition.
- **Controlled-card migration blast radius:** making the status prop required touches
  model-manager in the same PR. Verified feasible (generic `INSTALLER_BY_ID` rows +
  existing 30 s poll), but it is the one non-trivial extra surface in Part A.
- **Capability-map floor numbers:** the exact `genVramFloorMb` / `designVramFloorMb`
  values must come from real measurement or the model registry, not guessed literals.
  The *structure* is fixed here; the numbers are a plan-time task.
