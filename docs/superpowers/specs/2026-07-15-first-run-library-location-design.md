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

Applied at the two **launcher** default sites. Each site follows the **same
two-part rule** — a keep-existing guard AND a homedir-usability fallback — so
that (a) an existing library never vanishes and (b) a fresh install can never
be prevented from booting by an unusable home directory:

| Site | Today | New default | Keep-existing guard |
|---|---|---|---|
| `launch.mjs` (versioned install) | `<install>/workspace` | `~/Castwright` | If `<install>/workspace` **already exists on disk**, keep it (upgraders untouched); else use the fresh default. |
| `pinokio-scripts/lib/write-env.js` | `<appRoot>/workspace` | `~/Castwright` | If `server/.env` **already exists**, don't rewrite it (idempotent, unchanged). **AND** when writing a fresh `.env`: if `<appRoot>/workspace` **already exists on disk**, write that path, not `~/Castwright`. |

The second clause on the Pinokio row is a **new** guard the review surfaced:
`write-env.js` today guards only on `.env` presence, while `launch.mjs` guards
on the workspace **directory** presence. Without the added directory guard, a
Pinokio user whose `server/.env` is deleted/clobbered (re-install, manual edit)
would get a regenerated `.env` pointing at `~/Castwright`, silently orphaning
their existing `<appRoot>/workspace`. The two sites must use the **same
directory-existence guard**.

**Homedir-usability fallback (both sites).** `~/Castwright` introduces a new
boot-blocking dependency that today's install-local defaults don't have (their
parent dir was just created by the installer). If `os.homedir()` is empty/unset
or `~/Castwright` cannot be created, the launcher must **fall back to the
install-local default** (`<install>/workspace` / `<appRoot>/workspace`) and log
the fallback — never emit a `WORKSPACE_DIR` the server can't `mkdir`, since
`ensureWorkspace()`'s `mkdirSync` (`paths.ts:100-102`) throwing means the
server won't boot at all (strictly worse than a buried-but-working library).
The choice is made in the **launcher** (which runs before the server boots and
sets `WORKSPACE_DIR`), keeping `paths.ts`'s boot-time-`const` model intact.

The bare-checkout fallback in `server/src/workspace/paths.ts`
(`../castwright-workspace`) is **left unchanged** — developers set
`WORKSPACE_DIR` explicitly, and repointing the dev fallback would risk hiding
developers' existing data for no end-user benefit. A test pins that it stays
put.

A single shared helper computes the default so the value is not duplicated:

```
// reachable by both launcher trees
// Returns the fresh default, or null when the home dir is unusable
// (caller then keeps the install-local default).
export function defaultLibraryDir(homedir = os.homedir()) {
  if (!homedir || !path.isAbsolute(homedir)) return null;
  return path.join(homedir, 'Castwright');
}
```

Writability (as opposed to resolvability) is checked by the launcher attempting
to create the chosen directory and falling back on failure — see the
homedir-usability fallback above.

(`launch.mjs` and `pinokio-scripts/` are separate module trees; if a shared
import is awkward across them, the helper is duplicated as a small function in
each with a comment cross-referencing this spec. Decide at plan time — both are
acceptable; the value and the guard semantics are what must match.)

### The migration invariant

> **No existing install's library may become invisible.**

This is guaranteed structurally, not by a data move:

- **Pinokio** — `write-env.js` never rewrites an existing `server/.env`; AND on
  a fresh `.env` write, the new **directory-existence guard** keeps an existing
  `<appRoot>/workspace` (see Lever A). Both clauses are required — the file
  guard alone leaves the `.env`-deleted case orphaning the library.
- **Versioned** — `launch.mjs` recomputes `WORKSPACE_DIR` on every launch, so
  it needs the explicit **directory-existence guard**: an upgrader already has a
  populated `<install>/workspace`, which the guard detects and keeps; a fresh
  install has none, so it gets `~/Castwright`.
- **Account override** — `workspaceDirOverride` is highest precedence and lives
  in the shared per-user settings file (outside any install), so a power user's
  chosen path always wins regardless of the above.

**Known residual — the shared-override layer (accepted, documented).**
`readBootOverride` (`paths.ts:89-98`) reads `workspaceDirOverride` from the
**shared, cross-install** settings file (plan 122) — and a legacy per-checkout
path as a fallback — at highest precedence. Consequences the design accepts:

- A user who set an override on a now-deleted install, or who runs **two
  installs on one machine**, will see that saved path on a "fresh" install
  rather than `~/Castwright`. This is plan-122's intended "your settings follow
  you" behaviour, not a regression this work introduces — so it is **kept**, not
  fixed. The Library wizard step surfaces it honestly: when
  `workspaceSource === 'override'` the step notes "using a saved location from
  your Castwright settings" instead of presenting it as the default.
- The dangerous *accidental* version of this — the wizard itself writing an
  override when the user merely accepted the shown default — is closed by the
  Lever B prefill fix below (the step never writes an override for an unedited
  default), so a wizard run can no longer manufacture the stale value.

### Lever B — new "Library" wizard step

- Add `StepId 'library'` to `src/components/setup/steps.ts`, inserted **after
  `defaults`, before `lanCert`**. Title: **"Library"**.
- Add a `case 'library':` to the `renderStep` switch in
  `src/components/setup/setup-wizard.tsx`. That switch has **no `default` and no
  return-type annotation**, so a missing case is not a typecheck error — it
  silently renders blank. This work MUST add both the case AND an
  `assertNever(step)` default so any future omission fails to compile.
- Add the `library → <wiki page>` entry to the `WIZARD_STEP_WIKI` map in
  `src/lib/wiki-links.ts` (it `satisfies Record<StepId, WikiPage>`, so this is
  compile-time-enforced but must not be forgotten in the same change).
- New component `src/components/setup/step-library.tsx`, modeled on
  `step-defaults.tsx` and the Account → Workspace field. **The prefill/dirty
  split matters (this is the CRITICAL the review caught):**
  - **Read-only display** of the *resolved absolute path* from
    `account.workspaceRoot` (already in the slice — no new API field), e.g.
    "Your audiobooks will be saved to `C:\Users\you\Castwright`." This is
    display text, NOT the input's value.
  - **Editable input** prefilled from the **raw** `account.workspaceDirOverride
    ?? ''` — exactly as `account.tsx:46-47` does — i.e. **empty** when no
    override is set. Save dispatches `saveAccountSettings({ workspaceDirOverride
    })` with empty → `null` (Account view's normalisation).
  - Dirty = `input !== (account.workspaceDirOverride ?? '')`. Because both sides
    now live in raw-override space, an **unedited** step is **not** dirty, shows
    **no** badge, and Save writes **nothing** — so accepting the default can
    never manufacture an explicit override (closes the CRITICAL + the accidental
    half of the stale-override MAJOR).
  - When edited, renders the **same "restart required to take effect" badge**
    the Account view uses.
  - When `account.workspaceSource === 'override'`, add the provenance note from
    the migration-invariant section ("using a saved location from your
    Castwright settings").
  - **Non-empty-library degradation (MINOR the review caught):** the "empty at
    first run, nothing to move" copy only holds pre-first-book. When the
    workspace already contains books, the step must instead warn that changing
    the location does **not** move existing files and they'd need to be copied
    manually. Signal: reuse the existing library book count already available to
    the frontend (e.g. the library/readiness data the wizard has) rather than
    adding a new endpoint — confirm the exact source at plan time. The step
    still never hard-blocks; it degrades its copy.
  - **Never blocks wizard progression** — same contract as `step-defaults`
    (informational step; readiness gating is unaffected).
- `src/components/setup/step-finish.tsx` gains a one-line reminder **only when**
  the override is dirty: "Restart to move your library to `…`."

The Library step is intended as a **first-run** step. It is not readiness-gated
(it never blocks), so it can reappear if the wizard is re-entered after a
readiness regression with books already present — which is exactly why the
non-empty-library degradation above is required rather than optional.

## Testing (paired; required)

- **Frontend** — `src/components/setup/step-library.test.tsx`:
  - Read-only display shows `account.workspaceRoot`.
  - With **no** override set, the input is **empty**, the step is **not dirty**,
    the restart badge is **absent**, and Save dispatches **nothing** (the
    CRITICAL regression test — fails if the input is seeded from `workspaceRoot`).
  - Editing the input dispatches `saveAccountSettings({ workspaceDirOverride })`
    and shows the restart badge; clearing to empty saves `null`.
  - `workspaceSource === 'override'` renders the provenance note.
  - Non-empty library renders the "does not move existing files" warning; empty
    library renders the "nothing to move" copy.
  - Extend the existing wizard-coherence guardrail so `STEPS` / `StepId` / the
    `WIZARD_STEP_WIKI` map / the `renderStep` switch stay in lockstep. (The
    `assertNever` default makes a missing `renderStep` case a compile error;
    the guardrail test is the belt to that suspenders.)
- **Server / launchers**:
  - `launch.mjs` planLaunch test — existing-`workspace` guard keeps the old
    path; a fresh install resolves to `~/Castwright`; **homedir empty/unusable →
    falls back to `<install>/workspace`** (boot-safety regression test).
  - `pinokio-scripts/lib/write-env.test.js` — fresh `.env` + no existing
    workspace writes `WORKSPACE_DIR=<home>/Castwright`; fresh `.env` **with** an
    existing `<appRoot>/workspace` writes that path (the new directory guard);
    an existing `server/.env` is untouched; **homedir unusable → install-local**.
  - `defaultLibraryDir()` unit test — absolute homedir → `<home>/Castwright`;
    empty/relative homedir → `null`.
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

## Resolved review questions

The adversarial review (2026-07-15) raised three; all resolved in this revision:

1. **Prefill source / does Save write an override for an accepted default?**
   The editable input prefills from the **raw `workspaceDirOverride`** (empty
   when unset), NOT the resolved `workspaceRoot`; the resolved path is separate
   read-only display text. An unedited step is not dirty and Save writes
   nothing. (Lever B, CRITICAL.)
2. **Should `write-env.js` adopt the directory-existence guard?** Yes — both
   launcher sites now use the same directory guard, so a deleted/clobbered
   Pinokio `.env` no longer orphans an existing `<appRoot>/workspace`. (Lever A,
   MAJOR.)
3. **`~/Castwright` unresolvable/unwritable, and is the step first-run-only?**
   The launcher falls back to the install-local default (never emits an
   un-`mkdir`-able `WORKSPACE_DIR`). The Library step is intended first-run but
   is not readiness-gated, so it degrades its copy when books already exist
   rather than assuming an empty library. (Lever A + Lever B, MAJOR + MINOR.)

## Open questions

None blocking. Two plan-time implementation details (not design forks): the
shared-vs-duplicated `defaultLibraryDir()` helper, and the exact frontend source
for the "library already has books" signal used by the non-empty degradation.
