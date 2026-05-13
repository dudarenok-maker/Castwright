# Revisions & drift

> Status: stable for drift; pending revisions still placeholder
> Key files: `src/views/revision-diff.tsx`, `src/modals/drift-report.tsx`, `src/store/revisions-slice.ts` (`acceptAllPending`, `rejectAllPending`, `dismissDrift`, `hydrateFromBookState`), `src/lib/api.ts` (`pollRevisions`), `src/components/layout.tsx` (poll effect), `server/src/routes/revisions.ts` (drift detector), `server/src/routes/generation.ts` (`characterSnapshots` write)
> URL surface: indirect — revisions diff opens from `ready` views; drift report is a modal
> OpenAPI ops: `GET /api/books/:bookId/revisions` (real backend computes drift from per-chapter snapshots)

## What this covers

Two related surfaces. **Revisions** are pending audio re-renders awaiting user accept/reject — produced by regen modals and the batch-regen flow. **Drift events** warn when a character's current cast attributes (tone, voice, gender, age, engine) have drifted from the snapshot captured when each chapter was synthesised. The App polls every 30 s while in a `ready` stage. The drift detector reads `audio/<slug>.segments.json#characterSnapshots` (written by the generation route at synthesis time) and diffs every speaking character against the live `cast.json`. Pending revisions are currently a placeholder in the response — they're written to `revisions.json` only by the regen-modal flow.

## Invariants to preserve

- Polling interval is 30 s, only while `stage.kind === 'ready'` (effect in `src/components/layout.tsx`). Other stages do not poll.
- `RevisionsResponse { pending: Revision[]; drift: DriftEvent[] }`. Empty arrays are valid.
- `mockPollRevisions` returns `PENDING_REVISIONS` + `VOICE_DRIFT_EVENTS` fixtures. The real backend computes drift live from segments-file snapshots vs current cast.
- `acceptAllPending` / `rejectAllPending` clear the pending list atomically. Per-item accept/reject not in v1.
- `dismissDrift(id)` removes the event from the slice AND records the id in `revisions-slice.dismissed`. The persistence middleware writes `{ pending, drift, dismissed }` to `.audiobook/revisions.json`; the backend detector filters its output by `dismissed` so the same event does not re-emerge on subsequent polls. `hydrateFromBookState` reloads the dismissed list on book open so dismissals union with subsequent ones rather than overwriting them.
- Drift event ids are stable: `drift:<chapterId>:<characterId>:<factor>` (`factor` ∈ `voice`, `gender`, `ageRange`, `warmth`, `pace`, `authority`, `emotion`). This means a dismiss is durable across polls — the same signal hashes to the same id.
- **Drift sensitivity** (`server/src/routes/revisions.ts`):
  - Hard signals (`voiceId`, `gender`, `ageRange` change) always emit `severity: 'severe'`.
  - Tone metric deltas: `< 25` → no event, `25–39` → `moderate`, `≥ 40` → `severe`. Threshold constants are `TONE_MODERATE = 25` and `TONE_SEVERE = 40` — change them in one place if the user reports false positives.
  - Missing fields on either side (snapshot omits a value, current cast doesn't set it) skip the comparison rather than treat it as drift.
  - Engine drift is intentionally not surfaced as its own factor: engine isn't in `cast.json` (the user selects an engine per generation run, not per character), so there's no current value to compare against. A voiceId swap covers the cross-engine case in practice because voice ids are engine-scoped.
- The drift report modal is shown via `setShowDriftReport(true)`; closed via `setShowDriftReport(false)` (`src/store/ui-slice.ts:29, 117`).
- Generation writes `characterSnapshots` into `audio/<slug>.segments.json` for every speaking character, capturing `tone`, `gender`, `ageRange`, `voiceId`, and `voiceEngine` at synthesis time. Older segments files written before this field landed are treated as "no signal" by the detector.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a `ready` book view.

1. **Wait 30 s** → polling fires; revisions slice updates from the canned fixture. Pending count badge updates in the toolbar.
2. **Open revision diff view** → list of pending drafts renders with character + chapter info; accept-all / reject-all CTAs visible.
3. **Click "Accept all"** → `revisions.pending` empties; toolbar badge clears; next poll re-populates from mock fixture (mock is stateless).
4. **Open drift report modal** → list of drift events renders with severity, reason, and previous-vs-current voice descriptors.
5. **Dismiss a drift event** → it disappears from the modal; re-opening shows the remaining events.
6. **Click "Regen character" from drift** → opens the per-character regen modal (`17-regenerate-this-or-forward.md`) pre-filled with the character + chapter.

**Real-mode regression check** (`VITE_USE_MOCKS=false`, server + sidecar running):

7. Generate one chapter end-to-end and confirm `audio/<slug>.segments.json` contains a `characterSnapshots` block with each speaking character's `tone`, `gender`, `ageRange`, `voiceId`, `voiceEngine`.
8. In the Cast view, swap a character's `voiceId`. Within 30 s the drift report surfaces a severe `voice` drift event for that character / chapter.
9. Adjust a character's `tone.warmth` by ≤ 24 → no event. By 25–39 → moderate event. By ≥ 40 → severe event.
10. Dismiss a drift event. Reload the page. Wait < 30 s. The event does NOT reappear (dismissed id is filtered server-side).

## KNOWN: scaffolded

- Per-item accept/reject UI doesn't exist; accept-all / reject-all only.
- Real `pending` is not populated by the drift detector — it's written only when the regen-modal flow PUTs to `slice: 'revisions'`. A severe drift event doesn't auto-queue a regen; the user clicks "Regen character" to trigger one.

## Out of scope

- Diff audio playback (a/b same-sentence) — UI shows metadata only in v1.
- Cross-book drift detection — single-book scope.
- Automatic auto-accept when drift severity is below threshold.
