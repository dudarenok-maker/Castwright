# Listener preview (POV)

> Status: stable
> Key files: `src/views/preview-listener.tsx`, `src/store/ui-slice.ts` (`setPreviewMode`)
> URL surface: none (overlay flag; preserves underlying stage URL)
> OpenAPI ops: none

## What this covers

Full-screen listener-POV preview: hides the editor chrome and shows just the cover, audiobook metadata, and chapter list as a reader/listener would see them. Useful for "how does my audiobook actually look from a user's chair?" without leaving the editor entirely.

## Invariants to preserve

- `ui.previewMode: boolean` is a flat overlay flag (`src/store/ui-slice.ts:30, 118`). Not stage-guarded — togglable from any `ready` view.
- Toggling preview does NOT change the URL. The underlying `stage` remains intact; closing preview returns to the same view/chapter/profile.
- `setPreviewMode(true)` shows the preview; `setPreviewMode(false)` hides it.
- Esc key is the documented exit; click-outside also dismisses.
- Preview must not modify `cast` / `manuscript` / `chapters` slices — read-only view.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to `#/books/<id>/manuscript?chapter=5&profile=p1`.

1. **Open preview** (toolbar button) → `previewMode = true`; full-screen overlay covers the editor. Cover + chapter list + audiobook metadata visible; editor chrome hidden.
2. **URL unchanged** — still `#/books/<id>/manuscript?chapter=5&profile=p1`.
3. **Press Esc** → `previewMode = false`; editor chrome reappears; chapter 5 + profile drawer still in their previous state.
4. **Toggle from another view** (e.g. `#/books/<id>/cast`) → preview opens; closing returns to cast view at the same scroll position.
5. **Preview while a modal is open** (e.g. regen modal) → either the modal is hidden under preview or preview suppresses it; pick one and document; test for no visual stacking glitches.

## Out of scope

- Audio playback inside preview (uses the same MiniPlayer; covered by `18-listen-view.md`).
- Mobile-specific preview layout — v1 is desktop-only.
- Sharing preview as a public link.
