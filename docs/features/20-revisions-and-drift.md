# Revisions & drift

> Status: KNOWN: backend-pending
> Key files: `src/views/revision-diff.tsx`, `src/modals/drift-report.tsx`, `src/store/revisions-slice.ts` (`acceptAllPending`, `rejectAllPending`, `dismissDrift`), `src/lib/api.ts` (`pollRevisions`), `src/App.tsx` (poll effect)
> URL surface: indirect — revisions diff opens from `ready` views; drift report is a modal
> OpenAPI ops: `GET /api/books/:bookId/revisions` (mock returns canned; real returns empty)

## What this covers

Two related surfaces. **Revisions** are pending audio re-renders awaiting user accept/reject — produced by regen modals and the batch-regen flow. **Drift events** warn when a regenerated character's voice characteristics (tone, gender, age) have drifted from previously-recorded takes for that character. The App polls every 30 s while in a `ready` stage. Backend logic is currently stubbed; the UI is fully built.

## Invariants to preserve

- Polling interval is 30 s, only while `stage.kind === 'ready'` (effect in `src/App.tsx`). Other stages do not poll.
- `RevisionsResponse { pending: Revision[]; drift: DriftEvent[] }`. Empty arrays are valid (real backend returns this).
- `mockPollRevisions` returns `PENDING_REVISIONS` + `VOICE_DRIFT_EVENTS` fixtures (`src/lib/api.ts:283-289`). Real returns `{ pending: [], drift: [] }` (`src/lib/api.ts:615-619`) — by design, to keep the polling effect quiet without the backend wired.
- `acceptAllPending` / `rejectAllPending` clear the pending list atomically. Per-item accept/reject not in v1.
- `dismissDrift(id)` removes a single drift event; user can re-trigger by regenerating the character.
- Drift event shape (per `src/lib/types.ts:13`): `{ id, characterId, chapterId, severity, reason, previousVoice, currentVoice }`. `severity` is an enum (low/medium/high); UI surfaces it visually.
- The drift report modal is shown via `setShowDriftReport(true)`; closed via `setShowDriftReport(false)` (`src/store/ui-slice.ts:29, 117`).

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a `ready` book view.

1. **Wait 30 s** → polling fires; revisions slice updates from the canned fixture. Pending count badge updates in the toolbar.
2. **Open revision diff view** → list of pending drafts renders with character + chapter info; accept-all / reject-all CTAs visible.
3. **Click "Accept all"** → `revisions.pending` empties; toolbar badge clears; next poll re-populates from mock fixture (mock is stateless).
4. **Open drift report modal** → list of drift events renders with severity, reason, and previous-vs-current voice descriptors.
5. **Dismiss a drift event** → it disappears from the modal; re-opening shows the remaining events.
6. **Click "Regen character" from drift** → opens the per-character regen modal (`17-regenerate-this-or-forward.md`) pre-filled with the character + chapter.
7. **Real-mode regression check** — switch to `VITE_USE_MOCKS=false`. Polling still fires every 30 s; response is `{ pending: [], drift: [] }`; UI shows empty states silently (no error toast).

## KNOWN: scaffolded

- `realPollRevisions` returns empty arrays — no real backend logic yet.
- Per-item accept/reject UI doesn't exist; accept-all / reject-all only.
- Drift detection algorithm is not implemented server-side; mock fixture is the only source today.

## Out of scope

- Diff audio playback (a/b same-sentence) — UI shows metadata only in v1.
- Cross-book drift detection — single-book scope.
- Automatic auto-accept when drift severity is below threshold.
