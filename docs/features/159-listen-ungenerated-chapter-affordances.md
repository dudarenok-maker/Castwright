---
status: active
shipped: null
owner: null
---

# 159 — Listen-row affordances gated on generated audio

> Status: active
> Key files: `src/components/listen/listen-player-region.tsx`
> URL surface: `#/books/<id>/listen`
> OpenAPI ops: none

## Benefit / Rationale

- **User:** chapters that haven't generated audio yet no longer masquerade as
  playable. Before, a `queued` / `in_progress` / `failed` chapter rendered an
  active Play button, a "0:00" duration, and an active Share-clip button — all
  misleading (Play loads nothing; Share opens a modal that can't cut a clip from
  a zero-length window). Now the row reads as inert: Play + Share are disabled,
  and a state-aware label (`Queued` / `Generating…` / `Failed`) replaces the
  fake "0:00".
- **Technical:** no new state — reuses the existing `chapter.state === 'done'`
  "has audio" predicate (the same one `listen.tsx` already uses for the
  `completed` count). Pure presentational gating inside one component.
- **Architectural:** n/a — no new seam, no data-shape change.

## Architectural impact

- **New seam:** none. `ChapterListenRow` derives `hasAudio = chapter.state === 'done'`
  locally and branches the Play/Share `disabled` state + the duration-cell render
  off it.
- **Invariants preserved:** the `data-testid`s (`chapter-row-<id>`,
  `chapter-row-<id>-share-clip`) are unchanged so existing selectors keep
  resolving; the playing-row live-playhead path (plan 125) and the Resume pill
  (plan 47) are untouched (a non-done chapter can never be the current track).
  Regenerate + Rename stay active on every row.
- **Migration story:** none.
- **Reversibility:** revert the single-component diff.

## Invariants to preserve

- `ChapterListenRow` (`src/components/listen/listen-player-region.tsx`):
  `hasAudio = chapter.state === 'done'`. When `!hasAudio`: the Play button and
  the Share-clip button carry the `disabled` attribute, and the duration cell
  renders `statusLabel` (`in_progress` → `Generating…`, `failed` → `Failed`,
  else `Queued`) instead of `chapter.duration` / the live elapsed-total.
- The per-row Regenerate button is **never** gated on `hasAudio` — on a non-done
  chapter it can kick off / retry generation.

## Test plan

### Automated coverage

- Vitest unit (`src/components/listen/listen-player-region.test.tsx`,
  `describe('ungenerated-chapter affordances')`) — asserts, for a `queued`
  chapter: Play (`aria-label` "Chapter 1 not yet generated") and Share
  (`chapter-row-1-share-clip`) are `disabled`, the `Queued` label renders, and
  `0:00` does not; for `in_progress` → `Generating…`, `failed` → `Failed`;
  Regenerate stays enabled on a `queued` chapter; and a `done` chapter keeps
  Play + Share enabled with the real `10:00` duration shown.

### Manual acceptance walkthrough

1. **Listen view with a mixed book** at `#/books/<id>/listen` (at least one
   `done` chapter and one non-`done`).
2. **Done row** → Play + Share clickable, real duration shown — unchanged.
3. **Queued / in_progress / failed row** → Play + Share visibly disabled and
   unclickable; the duration column reads `Queued` / `Generating…` / `Failed`
   (Failed in a rose tint); Regenerate still works.

## Out of scope

- The share-clip modal's internal zero-duration guard (it already disables its
  confirm button when `durationSec === 0`) — unchanged; with the button now
  disabled it can no longer be opened from an ungenerated row anyway.

## Ship notes

(Filled in when status flips to `stable`.)
