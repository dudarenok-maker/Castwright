# Wave 2+3 — analysing-view model honesty + section progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** (W2) the analysing model chip mirrors the model the server *actually resolved/ran*, not the local Redux selection; (W3) per-chapter progress shows "section M/N" with a sub-bar instead of only elapsed/est.

**Architecture:** Both are additive SSE enrichments. The server already computes `activeModelId`/`phase1ModelId` and tracks `sectionsDone/sectionsTotal` in `castInFlight`; it just doesn't *emit* them to the client. Add the fields to the existing phase/live payloads, thread through `src/lib/api.ts` types + handlers, and render in `phase-model-chip.tsx` / `phase-card.tsx`'s `LiveChapterRow`.

**Tech Stack:** TS, Vitest + RTL (frontend), Vitest node (server), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md` §5 (label) + §6 (progress).

**Branch:** `feat/frontend-analysing-honesty-progress` (off `main`, already checked out).

**Seam anchors (verified):**
- Chip: `src/components/analysing/phase-model-chip.tsx` (reads Redux `account.analyzerPhase0Model`/`phase1Model`, `ui.selectedModel*`; label via `MODEL_OPTIONS` in `src/lib/models.ts`).
- View: `src/views/analysing.tsx` (`onPhase` handler; per-phase state buckets like `heartbeatByPhase`).
- Server phase emit: `server/src/routes/analysis.ts` — `activeModelId` (`:2075`), `phase1ModelId` (`:3127`); phase events `send({ kind:'phase', phaseId, progress, label })` at `:2413/:2538/:2801/:2950/:3082/:3115`; throttle events already carry `model` (`:2747/:3451`).
- Live ticker: `sendCastLiveTick()` (`:2586-2619`), maps `castInFlight` (`sectionsDone/sectionsTotal` at `:2581-2584/:2673-2674`) → `chapters[]` (currently WITHOUT section fields).
- Client types: `AnalysisStreamEvent` (`src/lib/api.ts:~2245`), `AnalysisLiveChapter`/`AnalysisLiveInfo` (`src/lib/api.ts:~126-135`); phase handler (`:~2365`).
- Render: `LiveChapterRow` (`src/components/analysing/phase-card.tsx:42-76`), `LiveChapterTicker` mounted at `:457`.
- Tests: `phase-model-chip.test.tsx`, `phase-card.test.tsx`; e2e `e2e/analysing-multi-model.spec.ts` (mock stream `ANALYSIS_NORTHERN_STAR` in `src/mocks/canned-data.ts`).

---

## W2 — model-label honesty

### Task 1: Server emits the resolved `model` on phase events

**Files:** Modify `server/src/routes/analysis.ts`; Test `server/src/routes/analysis.test.ts`.

- [ ] **Step 1 — failing test:** add a test asserting that a `phase` SSE event for phase 0 carries `model` equal to the resolved analyzer id (mirror the existing analysis.test.ts harness that captures emitted events). Assert `phase` events include `model: <resolved>` for phase 0 (and phase1ModelId for phase 1 where applicable).
- [ ] **Step 2 — run red:** `cd server && npx vitest run src/routes/analysis.test.ts -t "phase event carries model"` → FAIL.
- [ ] **Step 3 — implement:** at each phase `send({ kind: 'phase', phaseId, progress, label })` site (`:2413/:2538/:2801/:2950/:3082/:3115`), add `model:` — use `activeModelId` for the phase-0/cast sites and `phase1ModelId` for the phase-1/attribution sites (match the variable in scope at each site; read the surrounding code to pick the right one). Keep it a string id (the client maps id→label).
- [ ] **Step 4 — run green** + full `cd server && npx vitest run src/routes/analysis.test.ts`.
- [ ] **Step 5 — commit** `LOW_CONCURRENCY=1 git commit -m "feat(server): emit resolved analyzer model on analysis phase events"`.

### Task 2: Frontend chip mirrors the server model

**Files:** `src/lib/api.ts` (type + handler), `src/views/analysing.tsx` (capture), `src/components/analysing/phase-card.tsx` (pass-through), `src/components/analysing/phase-model-chip.tsx` (prefer serverModel); Tests: `phase-model-chip.test.tsx` + e2e `e2e/analysing-multi-model.spec.ts`.

- [ ] **Step 1 — failing unit test** in `phase-model-chip.test.tsx`: when a `serverModel` prop is provided, the chip renders THAT model's label (via MODEL_OPTIONS) regardless of the Redux selection. (Render with Redux set to 4B + `serverModel='qwen3.5:9b'` → expect "Qwen3.5 9B (local)".)
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement (client wiring):**
  - `src/lib/api.ts`: add `model?: string` to the `phase` variant of `AnalysisStreamEvent` (~:2245) and extract it in the phase handler (~:2365) into the `onPhase` payload (extend `onPhase`'s arg type with `model?: string`).
  - `src/views/analysing.tsx`: add a `serverModelByPhase` state bucket (mirror `heartbeatByPhase`); in `onPhase`, `setServerModelByPhase(prev => payload.model ? { ...prev, [phaseId]: payload.model } : prev)`. Pass `serverModelByPhase` to the PhaseCard(s).
  - `phase-card.tsx`: accept `serverModelByPhase?: Record<number,string>`; pass `serverModel={serverModelByPhase?.[p.id]}` to `<PhaseModelChip>`.
  - `phase-model-chip.tsx`: accept `serverModel?: string`; in the label derivation, prefer `serverModel` over the Redux-derived id when present (`const modelId = serverModel ?? <existing redux-derived id>`). Pre-stream (no serverModel yet) keeps the existing Redux behavior.
- [ ] **Step 4 — run green:** `npm test -- phase-model-chip` and the view test if present.
- [ ] **Step 5 — e2e:** extend `e2e/analysing-multi-model.spec.ts` (or add a case) so the mock stream emits a phase `model` that DIFFERS from the default selection, and assert the chip shows the server-reported label. (Check `ANALYSIS_NORTHERN_STAR` in `src/mocks/canned-data.ts` for how phase events are shaped; add `model` there if the mock drives the chip.)
- [ ] **Step 6 — commit** `feat(frontend): analysing chip mirrors the server-resolved analyzer model`.

---

## W3 — per-chapter section progress

### Task 3: Server includes section counts in the live tick

**Files:** Modify `server/src/routes/analysis.ts` (`sendCastLiveTick`, `:2586-2619`); Test `server/src/routes/analysis.test.ts`.

- [ ] **Step 1 — failing test:** assert a `phase`/live tick's `chapters[]` entries include `sectionsDone`/`sectionsTotal` from the `castInFlight` slot (drive a chunked-chapter scenario in the existing harness, or unit-test the mapping if extractable).
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement:** in the `castInFlight` → `chapters[]` map (`:2600-2615`), add `sectionsDone: r.sectionsDone` and `sectionsTotal: r.sectionsTotal` to each entry. (They already live on the slot at `:2581-2584/:2673-2674`.)
- [ ] **Step 4 — run green** (`analysis.test.ts`).
- [ ] **Step 5 — commit** `feat(server): surface per-chapter section counts in the analysis live tick`.

### Task 4: Frontend renders the section sub-bar

**Files:** `src/lib/api.ts` (`AnalysisLiveChapter` type), `src/components/analysing/phase-card.tsx` (`LiveChapterRow`); Tests: `phase-card.test.tsx` + e2e.

- [ ] **Step 1 — failing unit test** in `phase-card.test.tsx`: a `LiveChapterRow`/ticker given a chapter with `sectionsTotal: 4, sectionsDone: 3` renders "section 3/4" (and a sub-bar element); a chapter with `sectionsTotal` ≤ 1 renders NO section line.
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement:**
  - `src/lib/api.ts`: add `sectionsDone?: number; sectionsTotal?: number;` to `AnalysisLiveChapter` (~:126-131).
  - `phase-card.tsx` `LiveChapterRow` (`:42-76`): when `chapter.sectionsTotal && chapter.sectionsTotal > 1`, render a `· section {sectionsDone}/{sectionsTotal}` line + a thin sub-bar (`width: (sectionsDone/sectionsTotal)*100%`), using existing token classes (no hex literals; match the file's `text-ink/50`, `bg-ink/10` patterns).
- [ ] **Step 4 — run green:** `npm test -- phase-card`.
- [ ] **Step 5 — e2e:** add/extend an `e2e/analysing-*.spec.ts` case so the mock live tick includes `sectionsTotal>1` and assert the section text/sub-bar renders. (Add section fields to the mock live payload in `canned-data.ts` if needed.)
- [ ] **Step 6 — commit** `feat(frontend): per-chapter section sub-bar in the analysing live ticker`.

---

## Finalize
- [ ] `npm run config:check` (no registry change here, but confirm clean), then full `LOW_CONCURRENCY=1 npm run verify` (GPU idle).
- [ ] Push branch (pre-push verify) → open PR (Refs the spec §5/§6).

## Self-review notes
- Spec coverage: §5 label (T1+T2), §6 progress (T3+T4). Both cross the streaming/redux seam → e2e is MANDATORY (T2 Step 5, T4 Step 5), per CLAUDE.md.
- Out of scope: Wave 4 (MB-accounting policy + split UI), deferred.
- No hex literals in render code (design-token CSS vars only). Additive SSE fields are optional (back-compat: an older client ignores them; a newer client tolerates their absence).
