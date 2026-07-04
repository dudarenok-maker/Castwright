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
