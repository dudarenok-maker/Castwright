---
status: stable
shipped: 2026-05-19
owner: null
---

# Per-book editorial notes

> Status: stable
> Key files: `src/store/book-meta-slice.ts`, `src/components/listen/listen-header.tsx`, `src/views/listen.tsx`, `src/store/persistence-middleware.ts`, `src/components/layout.tsx`, `src/lib/types.ts`, `src/lib/api.ts`, `server/src/workspace/scan.ts`, `server/src/routes/book-state.ts`
> URL surface: `#/books/<id>/listen` — the Notes card lives in the header region rendered by `ListenHeader` (plan 60 decomposition).
> OpenAPI ops: `PUT /api/books/{bookId}/state` with `slice='state'` and `patch.notes` (free-form string).

## Benefit / Rationale

- **User:** the workspace gains a per-book scratchpad — source attribution, license, narration intent, in-progress thoughts. Cheap to capture (single textarea, no toolbar) and visible inline on the Listen view so the context never goes stale relative to the audio output.
- **Technical:** `BookStateJson` gains an optional `notes?: string | null` field that round-trips through the same atomic state-write path every other editable metadata field uses (`narratorCredit`, `genre`, `publicationDate`, `description`). No new slice, no new endpoint.
- **Architectural:** keeps the `EditableBookMeta` slice as the single source of truth for book-level editorial metadata. Render uses `whitespace-pre-wrap` for line-break support so we don't ship a markdown parser dependency for v1.

## Architectural impact

- **New seam / extension point:** `BookStateJson.notes?: string | null` (server + frontend TS types) and `EditableBookMeta.notes: string | null` (slice). Both nullable; falsy values normalise to `null`.
- **Invariants preserved:**
  - **Plan 27 — book state persistence:** the field rides the same `slice='state'` PUT pipeline used by every other editable metadata field. No new route, no new file on disk.
  - **Plan 24 — OpenAPI source of truth:** `BookStateJson` is hand-written in TS today (`src/lib/types.ts` mirroring `server/src/workspace/scan.ts`), not generated from `openapi.yaml`. The new field follows that convention; when the schema is lifted into `openapi.yaml`, `notes` will travel with it.
  - **Plan 60 — listen decomposition:** the Notes card mounts inside `ListenHeader` (per-region sub-component owns book-meta surfaces), not inside the orchestrator `src/views/listen.tsx`. The orchestrator only threads the `notes` prop through.
- **Migration story:** `notes` is optional in both type declarations and the JSON shape. Books written before this plan reload cleanly with `notes` absent; the slice's hydrate maps absent → `null`, the server's `pickNotes` validator falls back to `state.notes ?? null` when the patch omits the field. No re-write of legacy state.json files is required.
- **Reversibility:** removing the field is a no-op for state.json files that never wrote it. Files that did write `notes` keep the field around as harmless extra JSON until the next write that omits it (server validators don't strip unknown fields, but a fresh persist will overwrite with the current shape).

## Invariants to preserve

- `EditableBookMeta` in `src/store/book-meta-slice.ts:22-34` MUST carry `notes: string | null` alongside the other editable fields. Adding it implicitly via `Partial` doesn't count — the slice's `hydrateFromBookState` reducer reads `state.notes ?? null` explicitly and the slice tests assert the full keyset.
- The Notes card in `src/components/listen/listen-header.tsx` MUST be rendered inside `ListenHeader`, not in `src/views/listen.tsx` directly. Plan 60 decomposed the listen view so that per-region behaviour stays out of the orchestrator.
- Line-break rendering uses Tailwind's `whitespace-pre-wrap` utility on the rendered paragraph. NO markdown renderer dependency. Full markdown (bold, links, headings) is an explicit follow-up if asked.
- `pickNotes` in `server/src/routes/book-state.ts` MUST preserve interior whitespace verbatim (markdown line breaks are load-bearing). It coerces trim-empty to `null` so the editor's "clear" gesture has a clean cleared-value signal.
- `persistenceMiddleware`'s `bookMeta/commitDraft` rule MUST include `notes` (and `description`) in the persisted patch — the slice fold-to-saved happens before the rule's `build` runs, so the post-commit values flow through one PUT.

## Test plan

### Automated coverage

- Vitest unit (`src/store/book-meta-slice.test.ts`) — asserts `hydrateFromBookState` surfaces `notes: null` when absent and `commitDraft` folds a multi-line notes edit into `saved[bookId]` with line breaks preserved.
- Vitest unit (`src/views/listen.test.tsx`) — asserts:
  - Typing into the `meta-notes` textarea dispatches `setDraftField('notes', value)`; the textarea renders as a `<textarea>` (not a single-line input).
  - Clearing or filling with whitespace-only content dispatches `null`.
  - The collapsible Notes card hides when notes is null / whitespace-only; renders collapsed by default with the first line as preview; expands on click; the body paragraph carries `whitespace-pre-wrap` so embedded `\n` characters paint as visible line breaks.
- Vitest server (`server/src/routes/book-state.test.ts`) — asserts the `slice='state'` PUT round-trips `notes` with multi-line content verbatim, preserves it when the patch omits it, stores explicit `null` when cleared, and coerces whitespace-only input to `null`.

### Manual acceptance walkthrough

1. Cold boot at `#/books/sb/listen` (mock mode). The Listen view loads; no Notes card appears (mock fixture's `notes` is `null`).
2. Scroll to the metadata editor at the bottom of the view; locate the **Notes** textarea below **Description**.
3. Type two paragraphs separated by a blank line, e.g.:
   ```
   Source: public-domain edition retrieved from Project Gutenberg.

   Narration intent: warm, slow, frequent pauses.
   ```
4. Click **Save changes**. The Listen header refreshes: a collapsible **Notes** card appears between the action row and the player region, showing the first line as preview.
5. Click the toggle. The body expands and renders both paragraphs with the blank-line gap preserved (visual line break, not an HTML `<br/>`).
6. Reload the page (`F5`). The Notes card stays — its content was persisted to `.audiobook/state.json` via the same write path as title/author.
7. Clear the textarea entirely → **Save changes**. The Notes card disappears on next render; `state.json` carries `"notes": null`.

## Out of scope

- Full markdown parsing (bold / italics / links / headings / lists). v1 only renders line breaks via `whitespace-pre-wrap`.
- Per-character / per-chapter notes (this field is book-scoped). A chapter-scoped notes surface is a separate follow-up if needed.
- Export of notes to M4B / MP3 metadata atoms. Notes are workspace-internal — by design they never leave the workspace; that's what `description` is for (M4B `desc` / `ldes`).
- Lifting `BookStateJson` into `openapi.yaml`. The schema lives in TS today (mirrored between `src/lib/types.ts` and `server/src/workspace/scan.ts`); when the shape is hoisted into the YAML, `notes` will travel with it.

## Ship notes

Shipped 2026-05-19 on branch `feat/frontend+server-editorial-notes` as part of the v1.4.0 Wave 3.S4 slate. Notes field rides the existing `bookMeta` slice (no new slice), the existing `slice='state'` PUT (no new endpoint), and the existing `ListenMetadataEditor` UX (no new modal). Line breaks render via `whitespace-pre-wrap`; no markdown renderer dependency added. Persistence middleware's `bookMeta/commitDraft` rule simultaneously gained `description` (previously missing — closes an undocumented gap from plan 33 / plan 18).
