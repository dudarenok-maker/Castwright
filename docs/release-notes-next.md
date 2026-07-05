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
- **Fixed: the GPU-arbitration semaphore charged VRAM-budget tokens for kokoro/qwen/coqui synth and Qwen VoiceDesign calls even when the engine was confirmed running on CPU or Apple Silicon (MPS), needlessly serialising multi-engine generation on hardware with no discrete VRAM to protect.** A new per-engine device cache (fed from the sidecar's existing per-engine `devices` health-poll data) now gates these semaphore acquires — and the pre-load analyzer-eviction guard — on the engine's actual runtime device rather than a config-knob guess. Also fixes Coqui's own `auto` device resolution, which had no MPS branch (unlike Qwen's), so it always ran on CPU on Apple Silicon even when MPS was available (#1324).
- **Fixed: a chapter confirmed past the loud Qwen→Kokoro fallback gate could get permanently stuck at "line 0" and never dispatch.** `queue-dispatcher-middleware`'s reconcile was reading the Redux queue slice's `status` field to decide whether a just-closed stream was a park (`awaiting_confirm`) or a real completion — but nothing synchronizes that field with the `chapter_awaiting_fallback_confirm` SSE tick, so the field could still read the entry's pre-park `in_progress` status when the reconcile ran. That misread the park as a completion, which poisoned the dispatcher's in-memory de-dupe set for that entry — since the entry never actually leaves the live queue, nothing ever cleared the poison, so even after the user confirmed the fallback the entry was silently skipped forever. The reconcile now asks the stream runner directly (which already tracks this unambiguously off the SSE tick) instead of the racy Redux copy (#1284). Also memoized `selectQueueByBook`, an unmemoized selector that allocated a fresh array on every call and forced the queue modal to re-render on every store dispatch — a confirmed contributing factor to a `GenerationView` crash captured during the same investigation (#1285).
- **Fixed: a chapter's binary `audio.mp3` could 500 with an empty body and nothing in the logs, even though the file existed on disk and the JSON metadata endpoint for the same chapter served fine.** `chapter-audio.ts`'s `res.sendFile` call runs through Express's `send` module, which treats any ancestor path segment starting with `.` (e.g. a workspace nested under a `.claude/worktrees/<name>/castwright-workspace` checkout — exactly how Claude Code's own parallel-agent worktrees are laid out) as a "dotfile" and, under the default `dotfiles:'ignore'` policy, silently turns the request into a 404-shaped internal error; the route's catch-all then flattened that into an opaque 500 regardless of the real error. `audio.path` is fully server-computed from a validated bookId/chapterId lookup, never client input, so the dotfile guard was a pure false positive here — now passes `dotfiles: 'allow'` and logs the real error message/status so a genuine future failure isn't silent (#1290).
- **Fixed: the Books view could overflow horizontally on a phone.** `WorkspacePathRow`'s workspace-path `<span>` (`src/components/library/library-chrome.tsx`) carried a fixed `max-w-[520px]` with no responsive breakpoint, so a realistic (long) workspace path forced the page 232px wider than a 390px phone viewport instead of truncating with an ellipsis. Now caps at `calc(100vw-10rem)` below the `sm:` breakpoint, reverting to the original 520px cap at tablet/desktop widths (#1298).
- **Fixed: the Books view still overflowed horizontally by ~2px on a phone even with a short workspace path.** The filter-pills + Cards/Table view-mode-toggle row in `library-chrome.tsx` was the only flex row in that component missing `flex-wrap`, so at 390px width the two non-wrapping children's combined intrinsic width narrowly exceeded the available space. Added `flex-wrap` to match every sibling row in the same component; since `justify-between` left-aligns a lone item once it wraps to its own line, the toggle also switched from `justify-between` to `ml-auto` so it stays right-anchored whether or not it wraps (#1325).

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
