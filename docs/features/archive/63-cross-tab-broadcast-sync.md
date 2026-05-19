---
status: stable
shipped: 2026-05-19
owner: null
---

# 63 — Cross-tab `BroadcastChannel` state sync

> Status: stable
> Key files: `src/store/broadcast-middleware.ts`, `src/store/index.ts`, `src/store/analysis-slice.ts`, `src/store/chapters-slice.ts`
> URL surface: indirect — the cross-tab pill updates are visible in the top-bar on every view
> OpenAPI ops: none (purely client-side cross-tab coordination; complements the existing `/api/library/active-analyses` cold-boot lookup)

## Benefit / Rationale

- **User:** open the same book in two tabs, start an analysis or generation in tab A → tab B's top-bar `AnalysisPill` / generation pill updates without a refresh and without re-hitting the cold-boot endpoint. Zero network round-trip for the cooperative cross-tab case.
- **Technical:** eliminates the `GET /api/library/active-analyses` lookup (shipped 2026-05-17) when a sibling tab already has the state — the broadcast carries the post-mutation snapshot directly. Server load shrinks proportional to "how many tabs the user has open on the same workspace."
- **Architectural:** locks in two invariants the rest of the codebase can rely on: (1) cross-tab traffic flows only through the cross-book `activeStream` slots of the analysis + chapters slices — per-chapter rows, cast, manuscript, revisions are NEVER broadcast; (2) every broadcast is wholly self-describing (its own `bookId` rides inside the snapshot) and replaces the receiving slice's slot verbatim, so cross-bookId leakage into per-book state is structurally impossible.

## Architectural impact

- **New seams / extension points:**
  - `src/store/broadcast-middleware.ts` — owns the `BroadcastChannel('audiobook-state')` lifecycle. Exports `createBroadcastMiddleware({ channel, instanceId })` so tests can inject a mock channel without touching the global, and a `broadcastMiddleware` singleton wired into the store.
  - New reducer hooks: `analysis/applyExternalAnalysisSnapshot` and `chapters/applyExternalChaptersSnapshot`. Both are pure — they replace the slice's `activeStream` slot verbatim with the inbound payload (which may be `null` to mirror a sibling `clearActiveStream`). They are NOT in the broadcast rules table, so they never re-broadcast (echo-suppression layer 2).
  - `BroadcastMessage` shape (exported): discriminated by `kind: 'sync:analysis' | 'sync:chapters'`, plus `instanceId`, `bookId`, `snapshot`.
- **Invariants preserved:**
  - Plan 00 (stage machine): not touched. The broadcast operates entirely below the stage layer, on cross-book snapshot slots that already exist in the analysis + chapters slices.
  - Plan 23 (mock toggle): not touched. The middleware composes regardless of `VITE_USE_MOCKS`.
  - Plan 24 (OpenAPI source of truth): no shape changes to API types. `BroadcastMessage` is an internal cross-tab envelope — it never crosses the network.
  - Plan 26 (RTK Immer): both new reducers mutate via Immer drafts (assign-to-prop), preserving the rule.
  - Plan 27 (book state persistence): not touched. Persistence still goes through `persistence-middleware.ts` to disk per-bookId; the broadcast is in-memory, cross-tab, ephemeral.
  - Plan 32 / 32-sticky-analysis (cross-book guards): the analysis-slice's manuscriptId-keyed guards on `applyAnalysisSnapshotTick` / `bumpActiveStreamHeartbeat` / `setHalted` / `setPaused` / `setSeriesPrior` are unchanged. The new `applyExternalAnalysisSnapshot` reducer is wholesale-replace, by design — the sibling tab is the source of truth for its own bookId.
  - Plan 31 / 32 sticky generation + analysis: the cross-book `activeStream` snapshots (which power the header pills across navigation) are what we broadcast. Sticky-across-navigation behaviour is unchanged.
- **Migration story:** none — purely additive. No state shape changes, no on-disk migrations. Older browsers without `BroadcastChannel` degrade gracefully (`typeof BroadcastChannel === 'function'` feature-detect, no-op when missing — the cold-boot endpoint remains the fallback correctness floor).
- **Reversibility:** revert the four touched files. No on-disk artifacts, no API contract.

## Invariants to preserve

1. **Echo suppression is two-layered.** `src/store/broadcast-middleware.ts:138` filters inbound messages by `instanceId` (layer 1: drop self-broadcasts). `src/store/broadcast-middleware.ts:67-82` (the `ANALYSIS_BROADCAST_ACTIONS` / `CHAPTERS_BROADCAST_ACTIONS` sets) deliberately EXCLUDES the inbound `applyExternal*Snapshot` action types (layer 2: even if a self-message slips past layer 1, it cannot generate an outbound). Removing either layer reintroduces infinite ping-pong — do not collapse to one.
2. **Broadcast scope is narrow.** Only `analysis.activeStream` and `chapters.activeStream` are broadcast. Per-chapter rows (`chapters.chapters[]`), pendingRegen, regenEpoch, currentBookId, cast, manuscript, revisions are NEVER broadcast. Broadcasting them would fan out regen side-effects across tabs (the Generate view watches `regenEpoch` as a useEffect dep to re-open SSE) — that is the racing-writes case explicitly parked as Won't #3 in [`BACKLOG.md`](../BACKLOG.md). The chapters-slice's `applyExternalChaptersSnapshot` reducer (`src/store/chapters-slice.ts`) is one line by design — it only writes to `activeStream`.
3. **Snapshots are post-mutation.** The middleware reads `store.getState()` AFTER `next(action)` runs, so the broadcast reflects the merged slice state rather than the action's payload (which can be partial, e.g. an `applyAnalysisSnapshotTick` carrying only `phaseProgress`). Sending `action.payload` instead would lose all the slice-merged fields the receiving tab needs to render the pill correctly.
4. **Cross-bookId isolation is structural.** Every broadcast carries its slice's `bookId` inside the snapshot. The inbound reducer wholesale-replaces the slice's `activeStream` slot — no per-book per-chapter state is touched. A tab on book X receiving a tab-B-bookY snapshot correctly displays "book Y is in flight elsewhere" in the header pill without contaminating tab X's open-book state.
5. **Graceful degradation.** `typeof BroadcastChannel === 'function'` feature-detect in `src/store/broadcast-middleware.ts:99-101`. When absent (older browsers, some node-without-polyfill test runners), the middleware no-ops — the store still functions, outbound broadcasts silently skip, the cold-boot `/api/library/active-analyses` endpoint remains the correctness floor. `postMessage` errors (channel closed mid-tick during page unload) are swallowed with a `console.warn`.

## Test plan

### Automated coverage

- Vitest (`src/store/broadcast-middleware.test.ts`) — 15 cases:
  - Outbound: `setActiveStream` / `applyAnalysisSnapshotTick` / `clearActiveStream` on analysis; `setActiveStream` on chapters → channel `postMessage` called with the right kind + post-merge snapshot.
  - Outbound exclusion: `applyGenerationTick` (per-chapter row mutation) does NOT broadcast.
  - Outbound exclusion (echo-suppression layer 2): `applyExternalAnalysisSnapshot` / `applyExternalChaptersSnapshot` do NOT re-broadcast.
  - Inbound: a simulated `message` event dispatches the matching `applyExternal*Snapshot` reducer.
  - Echo suppression (layer 1): a spoofed inbound with our own `instanceId` is dropped.
  - Cross-bookId isolation: a sibling tab broadcasting bookId=Y replaces activeStream wholesale; per-chapter rows untouched.
  - Malformed inbound messages (null payload, unknown `kind`) are ignored.
  - Graceful degradation: `channel: null` does not throw; store dispatches still mutate state.
  - postMessage error swallowed without breaking the dispatch.
- Vitest (`src/store/analysis-slice.test.ts`) — 2 new cases under `applyExternalAnalysisSnapshot — cross-tab inbound`: replaces verbatim, accepts null.
- Vitest (`src/store/chapters-slice.test.ts`) — 2 new cases under `applyExternalChaptersSnapshot (cross-tab inbound, plan 63)`: replaces only `activeStream`, leaves per-chapter rows + pendingRegen + regenEpoch + currentBookId untouched (the cross-bookId isolation invariant).
- E2E: not landed in this PR. Two-tab Playwright coverage is awkward (requires multi-context with `browser.newContext()` + manual hashchange synchronisation); the Vitest cases pin the contract at a tighter seam.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`).

1. **Cold boot at `#/`** in tab A → expected stage = `{ kind: 'books' }`, library cards render.
2. **Open the same library URL in tab B.** Same `{ kind: 'books' }` stage in B.
3. **In tab A, click into a book → click Analyse.** Tab A enters analysing view; the top-bar `AnalysisPill` shows the running phase.
4. **Switch to tab B (do not refresh).** Within ~50 ms (one tick of the broadcast roundtrip in-browser), tab B's top-bar pill renders the same in-flight analysis snapshot — same bookTitle, same phase label, same progress. No network request to `/api/library/active-analyses` fired in tab B.
5. **In tab A, navigate to the Generate tab and start generation.** Tab A's generation pill activates.
6. **Tab B (still on the library view).** The generation pill appears in tab B's top-bar, mirroring tab A's progress in real time as `chapter_assembling` / `progress` / `chapter_complete` ticks flow.
7. **In tab A, close the analysis (Confirm cast → Generate-ready).** Tab A dispatches `clearActiveStream`. Tab B's analysis pill disappears within one broadcast tick.
8. **Disable `BroadcastChannel` in tab B (e.g. via DevTools `delete window.BroadcastChannel; location.reload()`).** Tab B falls back to the cold-boot `/api/library/active-analyses` lookup — pill still appears after page load, just without the live updates.

## Out of scope

- **Multi-tab catch-up race resilience** (BACKLOG Won't #3 — `docs/features/32-sticky-analysis.md`). This plan covers the cooperative cross-tab case (single user driving two tabs); two simultaneous writers on the same `bookId` still race on the server's `state.json` and that case remains parked under the single-user-per-workspace contract.
- **Conflict resolution for two simultaneous `state.json` writers** (BACKLOG Won't #9). Same trigger as Won't #3 — wakes when multi-user collab on a shared workspace becomes a real use case.
- **Broadcasting per-chapter rows or per-book cast / manuscript.** Deliberately excluded — duplicating those across tabs fans out regen side-effects and revisions writes, which is the racing case parked above. The narrow `activeStream`-only scope is the contract.
- **E2E Playwright spec.** Two-tab coverage requires multi-context plumbing the rest of the e2e suite doesn't use; the Vitest seams pin the contract tighter than a browser-level test could anyway (mocked channel = full control over send/receive ordering).

## Ship notes

- **Shipped:** 2026-05-19 on branch `feat/frontend-cross-tab-broadcast-sync`.
- **Behaviour delta vs spec:** none. Echo suppression doubled up (instanceId tag on the wire AND inbound-action allowlist short-circuit) instead of relying on either alone — defensive belt + braces.
- **Scope tightening:** the chapters-slice inbound reducer is strictly narrower than the analysis-slice one. Only the cross-book `activeStream` snapshot is mirrored; per-chapter rows + `pendingRegen` + `regenEpoch` + `currentBookId` stay per-tab. Tested in `chapters-slice.test.ts` under "applyExternalChaptersSnapshot (cross-tab inbound, plan 63)".
