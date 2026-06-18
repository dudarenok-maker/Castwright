---
status: stable
shipped: 2026-05-20
owner: null
---

# Exports in the book folder + Voice sync fixes

> Status: stable
> Key files: `server/src/routes/export.ts`, `server/src/workspace/paths.ts`,
> `server/src/workspace/atomic-rename.ts`, `server/src/export/sync-folder.ts`,
> `server/src/routes/user-settings.ts`, `server/src/routes/exports-portable.ts`,
> `src/modals/export-audiobook.tsx`, `src/lib/api.ts`, `openapi.yaml`
> URL surface: `#/books/<id>/listen` (export-modal UX); routes
> `POST/GET/DELETE /api/books/:bookId/exports/:id*`,
> `GET /api/books/:bookId/export/portable`,
> `POST /api/user/settings/sync-folder/test`
> OpenAPI ops: `createBookExport`, `getBookExport`, `downloadBookExport`,
> `testSyncFolderPath`

## Benefit / Rationale

Two pain points in the export pipeline, fixed together because they share
the same files.

- **User:** finished audiobook files now live in a visible
  `<bookDir>/exports/` folder sibling to `audio/` and `.audiobook/`,
  named `<slug>.m4b` / `<slug>.zip` / etc. — File Explorer can grab
  them without spelunking the hidden `.audiobook/` jail. The Voice
  tile's library folder now auto-saves on blur (no more "I typed it and
  it didn't stick" failure), surfaces server errors as a red banner,
  and gains a "Test" probe button that tells the user immediately
  whether the path they typed is actually writable.
- **Technical:** export artifacts are atomically written via a
  `<exports>/.<slug>.<ext>.partial-<id>` tmp + `renameWithRetry` so
  concurrent same-format builds can't corrupt each other.
  `renameWithRetry` now also tolerates EACCES + EIO so Drive for
  Desktop's virtual-FS hiccups don't surface as hard failures. Same-
  format re-exports revoke the older manifest so the queue de-dupes
  to one row per format.
- **Architectural:** clean separation between the user-pickup surface
  (`<bookDir>/exports/<filename>`) and the operational manifest jail
  (`<bookDir>/.audiobook/export-manifests/<exportId>.json`). The
  manifest stores `filename` only; the download route resolves the
  artifact path at read time so the workspace can move between
  machines without breaking download links. The portable bundle also
  writes a local copy so a backup is always sitting next to the
  audiobook.

## Architectural impact

- **New helpers** `bookExportsDir(bookDir)` and
  `bookExportManifestsDir(bookDir)` in `server/src/workspace/paths.ts`.
  Used by both the regular export route and the portable-bundle route.
- **New endpoint** `POST /api/user/settings/sync-folder/test` —
  `mkdir + writeFile probe + unlink`, returns `{ ok: true }` or
  `{ ok: false, code, message }`. Pure probe; no persistence.
  - **srv-22 (2026-06-18) behavior change:** the probe now **requires an
    existing directory** — it `lstat`s the path (rejecting symlinks) and
    returns `{ ok: false, code: 'ENOENT' }` for a missing/non-dir path
    instead of `mkdir({recursive:true})`-creating it. This removes an
    unauthenticated arbitrary-directory-creation primitive; "is the path I
    typed writable?" is still answered, but a bogus path is now a clear
    `ok:false` rather than a silently-created tree.
- **Invariants preserved:** the API contract (`BookExportJob` shape,
  `downloadUrl` route, `syncPath` semantic) is unchanged. The
  destination-tab UX (download vs sync-folder) is unchanged. The
  Voice tile's `appHint='voice'` collapse to M4B + sync-folder is
  unchanged.
- **Migration:** prior exports at the legacy
  `<bookDir>/.audiobook/exports/<exportId>/<filename>` location are
  ignored on rehydration. Their queue rows do not reappear. Users
  re-export the books they care about — per the design decision
  captured in the plan-mode clarifying questions.
- **Reversibility:** the new flat layout is forward-only. To roll
  back you'd revert this PR; existing artifacts at
  `<bookDir>/exports/<slug>.<ext>` would not be re-discovered by
  the prior code but the files themselves remain on disk.

## Invariants to preserve

- `bookExportsDir(bookDir)` in `server/src/workspace/paths.ts` is the
  one place that resolves the user-facing exports folder — a refactor
  that re-introduces a hidden subdir for visibility-of-artifacts
  reasons would silently violate the plan.
- `runExportJob` in `server/src/routes/export.ts:417+` writes single-
  file formats to a hidden `.<filename>.partial-<id>` first and
  renames at completion. Removing the partial pattern reopens the
  concurrent-clobber race.
- `revokeStaleSameFormat` is the only path that deletes a same-
  format-prior manifest from disk. Pruning manifests anywhere else
  would race with this and leave the queue inconsistent.
- The renameWithRetry retry list in
  `server/src/workspace/atomic-rename.ts` includes EACCES + EIO.
  Tightening it back to EPERM/EBUSY/ENOENT only would re-introduce
  the Drive-for-Desktop spurious failure mode.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/export.test.ts`) — three new specs:
  - "writes the artifact to the visible <bookDir>/exports folder
    (not .audiobook/)"
  - "revokes the older same-format manifest when a re-export of the
    same format finishes"
  - "different-format re-exports DO NOT revoke each other"
  - "rehydration drops manifests whose artifact has been deleted from
    the exports folder"
  - The existing "persists the manifest so a fresh server process can
    rehydrate the job" test is updated to assert the new paths.
- Vitest server (`server/src/workspace/atomic-rename.test.ts`, NEW) —
  parametrised retry test for EPERM / EBUSY / ENOENT / EACCES / EIO
  + immediate-throw for EROFS + max-attempts cap.
- Vitest server (`server/src/workspace/state-io.test.ts`) — the
  "non-retryable error" assertion swaps EACCES (now retryable) for
  EROFS so the no-retry contract stays explicit.
- Vitest server (`server/src/export/sync-folder.test.ts`) — two new
  specs that force a terminal rename failure inside a `My Drive`-shaped
  path and assert the Drive hint is prepended; a control assertion
  that non-Drive paths surface the raw error.
- Vitest server (`server/src/routes/user-settings.test.ts`) — four
  new specs for `POST /sync-folder/test`: writable path → ok, bogus
  drive letter → `{ ok: false, code }`, missing path → 400, empty
  path → 400.
- Vitest server (`server/src/routes/exports-portable.test.ts`) — new
  spec asserts the portable bundle's local copy at
  `<bookDir>/exports/<slug>.portable.zip` matches the streamed bytes.
- Vitest frontend (`src/modals/export-audiobook.test.tsx`) — six new
  specs under "ExportAudiobookModal — sync-folder UX (plan 79)":
  blur auto-save when dirty, no-save when clean, Test probe ✓ /
  Test probe ✗ with code, Test button disabled when empty, save-error
  banner renders from `account.error`.
- Playwright e2e (`e2e/exports-sync-folder.spec.ts`, NEW) — two
  golden-path specs: Voice tile renders the sync-folder body + Test
  button; typing a path + clicking Test renders the ✓ banner.

### Manual acceptance walkthrough

1. `npm install && npm start`. Open `#/books/<id>/listen` for a
   finished book.
2. Click **Voice** tile → modal opens with the Voice body in place.
3. Paste a Drive path (e.g. `G:\My Drive\Audiobooks`) → click
   **Test** → expect ✓ "Folder is writable."
4. Tab out of the input (blur) → modal stays open; the next time you
   open it the path is pre-filled with no Save click needed (caption
   reads "Saves to your Voice library at G:\\My Drive\\Audiobooks.").
5. Click **Export to Voice library** → wait for done.
6. Confirm `<bookDir>\exports\<slug>.m4b` exists in File Explorer.
7. Confirm `<bookDir>\.audiobook\export-manifests\<exportId>.json`
   exists.
8. Confirm the M4B also lands at `G:\My Drive\Audiobooks\<slug>.m4b`
   (Drive eventually mirrors to the phone).
9. Re-export the same book as M4B again → queue still shows ONE m4b
   row (the newer one); the prior manifest is gone.
10. Kick off an MP3.ZIP export of the same book → queue shows TWO
    rows (m4b + mp3-zip); different formats do not revoke each other.
11. Re-open the listen view → both rows survive via rehydration.

## Out of scope

- Migrating prior `.audiobook/exports/<exportId>/<filename>` artifacts.
  User re-exports what they care about.
- A general "show in OS file browser" affordance on the queue row.
  Worth a follow-up but separate.
- Validating that the user's sync folder is actually a real cloud
  sync watch path (vs. just any writable dir). The probe only confirms
  write access; Drive/OneDrive/Syncthing membership is the user's
  responsibility.
- Drive-specific OAuth integration. Out of scope — the file-drop
  model via sync clients is the intended sideload mechanism.

## Ship notes

Shipped 2026-05-20 via PR #77 (merge commit `8089253`) off branch
`fix/server-exports-relocate-and-voice-sync`. Four commits on the
branch:

- `a113b92` — server: relocate exports under `<bookDir>/exports`,
  widen `renameWithRetry` for EACCES/EIO, add the Drive-hint wrapper,
  ship the sync-folder write-probe endpoint, tee the portable bundle
  to a local copy.
- `9ba7714` — frontend + openapi: blur autosave, save-error banner,
  Test probe button, mock + real `api.testSyncFolderPath`, e2e spec.
- `7ae54a1` — plan 79 doc + `INDEX.md` entry.
- `9dd38ee` — CI hot-fix: the original sync-folder probe test used
  a bogus Windows drive letter (`Z:\nonexistent\...`) that on Linux
  CI just becomes a weird filename `mkdir({recursive:true})` happily
  creates. Swapped for a parent-is-a-file scenario (ENOTDIR surfaces
  on every platform).

No spec delta vs. the original plan body — all five sub-changes
landed as designed.
