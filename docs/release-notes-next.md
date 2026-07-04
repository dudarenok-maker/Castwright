<!--
Draft release notes for the NEXT version (technical register — this IS the
GitHub release body). bump-version.mjs feeds this file verbatim as the
annotated-tag message → release.yml, and now uses it by DEFAULT (no
--notes-file needed). Everything in this HTML comment is invisible in the
rendered release, so it never leaks into the body.

Keep it current for each release:
  1. Update the version marker below.
  2. Rewrite the body (theme paragraph → ## ✨ Headline features with
     ### … (new) subsections → emoji-themed sections → bold-lead bullets with
     (#PR) refs → **Full changelog:** vPREV...vNEW footer). v1.7.0 is the
     canonical example; see CONTRIBUTING.md "Release notes".

The marker is what bump-version checks: if it doesn't match the version being
cut, the bump refuses (so a stale file can't ship as the body). The
user-facing, brand-voice notes live separately in RELEASE_NOTES.md (#/release-notes).

release-notes-next-version: 1.11.0

Reopened after the v1.10.0 cut (2026-07-04). Body intentionally empty — each PR
appends its own entry here (before-shipping checklist item 4), so the 1.11.0
body accretes PR-by-PR rather than being reconstructed from git history at cut
time. The previous release's body shipped with the v1.10.0 tag annotation.
-->

- **Hardware guidance reconciled with castwright.ai.** The About page and the "Will it run on my machine?" device panel now say a 6 GB GPU gets you started and 8 GB is the sweet spot, matching the FAQ on the website (#1274).
- **`castwright.local` now works with no port typed, and the LAN certificate can be regenerated from inside the app.** A new port-443 forwarder relays to the existing `:8443` LAN HTTPS server; a "Regenerate certificate" button in the LAN Access card hot-swaps a fresh mkcert certificate into the running server with no restart. Also fixes a live CSRF-origin bug where mutating requests via `castwright.local`/`castwright.dev.local` 403'd (#1296).
- **Fixed: a chapter confirmed past the loud Qwen→Kokoro fallback gate could get permanently stuck at "line 0" and never dispatch.** `queue-dispatcher-middleware`'s reconcile was reading the Redux queue slice's `status` field to decide whether a just-closed stream was a park (`awaiting_confirm`) or a real completion — but nothing synchronizes that field with the `chapter_awaiting_fallback_confirm` SSE tick, so the field could still read the entry's pre-park `in_progress` status when the reconcile ran. That misread the park as a completion, which poisoned the dispatcher's in-memory de-dupe set for that entry — since the entry never actually leaves the live queue, nothing ever cleared the poison, so even after the user confirmed the fallback the entry was silently skipped forever. The reconcile now asks the stream runner directly (which already tracks this unambiguously off the SSE tick) instead of the racy Redux copy (#1284). Also memoized `selectQueueByBook`, an unmemoized selector that allocated a fresh array on every call and forced the queue modal to re-render on every store dispatch — a confirmed contributing factor to a `GenerationView` crash captured during the same investigation (#1285).

## ✨ Headline features

### Cast-first landing + pre-flight voice-readiness gate (new)

- **`confirmCast` now lands on the Cast view, not Manuscript** — the flow
  becomes confirm → Cast → Manuscript → Generate, with a new "Continue to
  manuscript" CTA on the Cast view's header action row.
- **A pre-flight voice-readiness gate** opens instead of the tier prompt when
  `startGenerationFlow` finds a speaking Qwen character with no designed
  voice: lists them (talk-time order), "Design full cast" as the primary
  action, "Proceed anyway — generic Kokoro fallback voices" for English
  books, a hard block (no proceed affordance) for non-English books.
- New reusable `src/store/voice-readiness-selectors.ts`
  (`selectUndesignedQwenCharacters` shares the cast view's exact
  `needsVoiceIds` semantics via `resolveVoiceStatus`) and `src/lib/cast-sort.ts`
  (`compareCastRows` extracted out of `views/cast.tsx`).
  `EnqueueInput`/`QueueEntry` gain an optional per-entry `fallbackConfirmed`
  flag, stamped at enqueue by the proceed-anyway path so the per-chapter
  `awaiting_fallback_confirm` gate doesn't re-prompt for that run's fresh
  chapters (later enqueues still get the per-chapter backstop).

## 🔧 Reliability

- **Title-narration synth call now wrapped in per-call timeout** (#1247, srv-51) — matches the defensive timeout protection added to every other synth call site, closing a gap where a wedged title narration could stall a chapter. No user-visible change under normal operation; defensive only.
- **`openapi.yaml`'s `QueueEnqueueRequest` now matches the real `/api/queue/enqueue` request shape** (#1264, srv-55) — was documented as `{ bookId, chapterIds[] }`; the route actually takes a per-entry `entries[]` array (new `QueueEnqueueEntry` schema: `id`, `bookId`, `chapterId`, `scope`, optional `characterId`/`modelKey`/`addedAt`/`fallbackConfirmed`). `src/lib/api-types.ts` regenerated to match. Docs/contract fix only — no runtime behaviour change.
- **Non-English chapters with an undesigned voice now fail immediately and clearly** (#1263) — previously they parked with a "Render anyway" offer that could never actually succeed on a non-English book, leading to a confirm→fail loop. The failure now names every affected character up front, persists so a reload shows "Failed" (not "Queued"), surfaces an immediate toast, and — since it's a deterministic per-book cast-configuration issue, not a systemic fault — no longer risks pausing the entire cross-book generation queue.
