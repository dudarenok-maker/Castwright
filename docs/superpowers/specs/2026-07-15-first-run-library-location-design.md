# First-run library location — design

Status: draft
Date: 2026-07-15
Area: server + frontend + pinokio-scripts (setup wizard, workspace defaults)
Related: fs-21 first-run wizard, plan 218 (Pinokio installer), plan 122
(shared user-settings location)

## Problem

The audiobook **library** (the workspace root — `books/`, `voices/`,
`.backups/`, `voices.json`, telemetry, the cross-book queue) currently lands
**inside the install tree** for every real install, and the user is never told
or asked:

- **Versioned / npm install** (`launch.mjs`): `WORKSPACE_DIR = <install>/workspace`.
- **Pinokio install** (`pinokio-scripts/lib/write-env.js`): writes
  `WORKSPACE_DIR = <appRoot>/workspace` into `server/.env`, i.e. buried under
  `~/pinokio/api/<app>.git/app/workspace`.
- **Bare dev checkout** (`server/src/workspace/paths.ts` fallback):
  `../castwright-workspace` next to the repo.

This is worst for **Pinokio**:

1. **Discoverability** — the library sits deep under `~/pinokio/api/...`, where
   a non-technical user will never find their audiobooks in a file browser.
2. **Fragility** — it lives inside the Pinokio-managed app folder; a Pinokio
   "uninstall" takes the library with it.
3. **Silence** — first-run never surfaces where the library is or offers a
   better location.

The setting to relocate it already exists — `workspaceDirOverride` in
per-user settings, surfaced in **Account → Workspace** with a "restart
required" badge — but it is not offered during first-run, so the default is
what everyone gets.

## Goals

- New installs default their library to a **discoverable, install-independent**
  location that survives any app reinstall/upgrade.
- First-run **shows** the user where their library will live and lets them
  change it.
- **No existing install's library may become invisible.** Relocation applies
  to fresh installs only.

## Non-goals

- Auto-**moving** an existing (multi-GB) library. Out of scope — too slow and
  too risky; existing installs keep their current location untouched.
- A server self-restart mechanism. Changing the location keeps today's
  "restart required" model.
- Changing the `exportSyncFolder` feature (the separate "copy *finished* books
  to OneDrive/Syncthing" path). Unrelated.

## Key constraint: restart required

`WORKSPACE_ROOT` in `server/src/workspace/paths.ts` is resolved **once at
module load** (a `const` the rest of the server caches). Changing the library
location therefore always needs a **server restart** to take effect. First-run
is the ideal moment: the library is empty, so there is nothing to migrate — at
worst the user restarts once before importing their first book.

Resolution precedence (unchanged):
`workspaceDirOverride` (user-settings, shared across installs) >
`WORKSPACE_DIR` env > built-in fallback.

## Design

Two independent levers plus one migration invariant.

### Lever A — relocate the default to `~/Castwright`

New default library location = `<os.homedir()>/Castwright` (e.g.
`C:\Users\you\Castwright`, `/home/you/Castwright`). Top-level home folder:
discoverable, brand-named, **not** cloud-synced (unlike `~/Documents` on
Windows, which is frequently OneDrive-redirected and would push GBs of
intermediate working audio to the cloud), and independent of any install dir.

Applied at the two **launcher** default sites, each guarded so existing
libraries never vanish:

| Site | Today | New default | Migration guard |
|---|---|---|---|
| `launch.mjs` (versioned install) | `<install>/workspace` | `~/Castwright` | If `<install>/workspace` **already exists**, keep it (upgraders untouched); else `~/Castwright`. |
| `pinokio-scripts/lib/write-env.js` | `<appRoot>/workspace` | `~/Castwright` | Already idempotent — only writes `server/.env` when absent. Existing Pinokio installs keep their path; only **fresh** installs get `~/Castwright`. |

The bare-checkout fallback in `server/src/workspace/paths.ts`
(`../castwright-workspace`) is **left unchanged** — developers set
`WORKSPACE_DIR` explicitly, and repointing the dev fallback would risk hiding
developers' existing data for no end-user benefit. A test pins that it stays
put.

A single shared helper computes the default so the value is not duplicated:

```
// e.g. scripts/lib or a small shared module reachable by both launchers
export function defaultLibraryDir() {
  return path.join(os.homedir(), 'Castwright');
}
```

(`launch.mjs` and `pinokio-scripts/` are separate module trees; if a shared
import is awkward across them, the helper is duplicated as a 2-line function in
each with a comment cross-referencing this spec. Decide at plan time — both are
acceptable; the value and the guard semantics are what must match.)

### The migration invariant

> **No existing install's library may become invisible.**

This is guaranteed structurally, not by a data move:

- **Pinokio** — `write-env.js` never rewrites an existing `server/.env`, so an
  existing install keeps its `WORKSPACE_DIR=<appRoot>/workspace`.
- **Versioned** — `launch.mjs` recomputes `WORKSPACE_DIR` on every launch, so
  it needs the explicit **existence guard**: an upgrader already has a populated
  `<install>/workspace`, which the guard detects and keeps; a fresh install has
  none, so it gets `~/Castwright`.
- **Account override** — `workspaceDirOverride` is highest precedence and lives
  in the shared per-user settings file (outside any install), so a power user's
  chosen path always wins regardless of the above.

### Lever B — new "Library" wizard step

- Add `StepId 'library'` to `src/components/setup/steps.ts`, inserted **after
  `defaults`, before `lanCert`**. Title: **"Library"**.
- New component `src/components/setup/step-library.tsx`, modeled on
  `step-defaults.tsx` and the Account → Workspace field:
  - Displays the **resolved absolute path** using `account.workspaceRoot`
    (already present in the account slice — no new API field), e.g.
    "Your audiobooks will be saved to `C:\Users\you\Castwright`."
  - Editable path input, prefilled from the resolved location. Save dispatches
    `saveAccountSettings({ workspaceDirOverride })` (empty → `null`, matching
    the Account view's normalisation).
  - When edited away from the persisted value, renders the **same
    "restart required to take effect" badge** the Account view already uses
    (dirty = `workspaceDirOverride !== persistedOverride`).
  - Copy notes the library is empty at first run, so there is nothing to move;
    Pinokio users Stop/Start to apply.
  - **Never blocks wizard progression** — same contract as `step-defaults`
    (informational step; readiness gating is unaffected).
- `src/components/setup/step-finish.tsx` gains a one-line reminder **only when**
  the override is dirty: "Restart to move your library to `…`."

## Testing (paired; required)

- **Frontend** — `src/components/setup/step-library.test.tsx`:
  renders the resolved path; editing the input dispatches
  `saveAccountSettings`; the restart badge appears only when dirty. Extend the
  existing wizard-coherence guardrail so `STEPS` / `StepId` / the
  `WIZARD_STEP_WIKI` map stay in lockstep when the new step is added.
- **Server / launchers**:
  - `launch.mjs` planLaunch test — existing-`workspace` guard keeps the old
    path; a fresh install resolves to `~/Castwright`.
  - `pinokio-scripts/lib/write-env.test.js` — fresh install writes
    `WORKSPACE_DIR=<home>/Castwright`; an existing `server/.env` is untouched.
  - A `paths` test asserting the bare-checkout fallback is **deliberately
    unchanged** (`../castwright-workspace`).
- **e2e** — one case in the setup coverage/responsive spec asserting the
  Library step renders (UI crosses router/redux/layout seams).

## Ship checklist deltas

- Update `docs/features/218-pinokio-installer.md` and the fs-21 wizard plan to
  document the new default + step.
- Append entries to **both** `docs/release-notes-next.md` (technical) and
  `RELEASE_NOTES.md` (brand voice): new installs now keep the library in a
  discoverable `~/Castwright` folder; first-run lets you confirm or change it.
- Issue linkage: link the fs-21 / setup-wizard area issue, or file a fresh
  Backlog issue if none fits, with `Closes #NN`.

## Open questions

None blocking. The shared-vs-duplicated `defaultLibraryDir()` helper decision
(above) is a plan-time implementation detail, not a design fork.
