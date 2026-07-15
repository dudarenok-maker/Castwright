# First-run Library Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New installs default their audiobook library to a discoverable `~/Castwright` folder (existing installs untouched), and first-run gains a Library step that shows the resolved path and lets the user change it.

**Architecture:** Two independent levers. **Lever A** (launchers): `launch.mjs` and `pinokio-scripts/lib/write-env.js` pick `~/Castwright` for a fresh install, keep the existing `<install>/workspace` when it already exists, and fall back to install-local if the home dir is unusable. **Lever B** (frontend): a new `StepLibrary` wizard step reusing the Account→Workspace field pattern. No server user-settings default changes — `workspaceDirOverride` stays `null`; the resolution precedence (`workspaceDirOverride` > `WORKSPACE_DIR` env > built-in fallback) is unchanged.

**Tech Stack:** Node ESM (`launch.mjs`) + CommonJS (`pinokio-scripts/`), `node:test` for launcher tests; React 18 + Redux Toolkit + Vitest/RTL for the wizard; Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-07-15-first-run-library-location-design.md` (re-reviewed GREEN 2026-07-15).

## Global Constraints

- **Default library location** = `<os.homedir()>/Castwright` (folder name exactly `Castwright`, no subfolder). Copied verbatim wherever referenced.
- **Migration invariant:** no existing install's library may become invisible. Every launcher default is guarded by a **directory-existence** check on the old location; relocation is fresh-install-only.
- **Boot-safety invariant:** never emit a `WORKSPACE_DIR` the server cannot `mkdir`. If `~/Castwright` is unresolvable/unwritable, fall back to the install-local default and log it.
- **Prefill/dirty rule (Lever B):** the editable input prefills from the **raw** `account.workspaceDirOverride ?? ''` (empty when unset), NOT the resolved `workspaceRoot`. Dirty = `input !== (workspaceDirOverride ?? '')`. An unedited step is not dirty and Save dispatches nothing.
- **No new API endpoint.** The "library already has books" signal comes from the existing `api.getLibrary()`.
- **Testing:** every task ships paired tests; no `.skip`. Design-token CSS vars only (no hex literals) in any new UI.
- **`~/Castwright`** shown to users as-is; internally `path.join(os.homedir(), 'Castwright')`.

---

## File Structure

**Lever A (launchers):**
- `pinokio-scripts/lib/write-env.js` — MODIFY: `buildEnvContents` takes a decided `workspaceDir`; add pure `defaultLibraryDir(homedir)` + `chooseFreshWorkspaceDir({appDir, homedir, workspaceExists})`; CLI does the mkdir writability probe.
- `pinokio-scripts/lib/write-env.test.js` — MODIFY: new signature + guard/fallback cases.
- `launch.mjs` — MODIFY: `planLaunch` computes `WORKSPACE_DIR` via the same resolvability logic; add pure `defaultLibraryDir(homedir)` + `chooseWorkspaceDir({installRoot, homedir, exists})`; add side-effecting `ensureWorkspaceWritable(chosen, fallback, mkdir)` used by the main run path.
- `scripts/tests/launch.test.mjs` — MODIFY: resolvability + writability cases.

**Lever B (wizard):**
- `src/components/setup/steps.ts` — MODIFY: add `'library'` to `StepId` + `STEPS` (after `defaults`).
- `src/lib/wiki-links.ts` — MODIFY: add `library: 'Account-and-Settings'` to `WIZARD_STEP_WIKI` (compile-forced by `satisfies`).
- `src/components/setup/step-library.tsx` — CREATE: the step.
- `src/components/setup/step-library.test.tsx` — CREATE: unit tests.
- `src/components/setup/setup-wizard.tsx` — MODIFY: `renderStep` `case 'library'` + `assertNever` default; `buildSummaryRows` new row + `lanCert` index fix; thread `libraryChanged` flag.
- `src/components/setup/setup-wizard.test.tsx` — MODIFY: step count 7→8; summary row.
- `src/components/setup/step-finish.tsx` — MODIFY: restart reminder when `libraryChanged`.

**Docs / ship:**
- `docs/features/218-pinokio-installer.md`, the fs-21 wizard plan — MODIFY.
- `docs/release-notes-next.md`, `RELEASE_NOTES.md` — MODIFY.
- `e2e/responsive/coverage.spec.ts` (or the setup e2e spec) — MODIFY: Library step renders.

---

## Task 1: Pinokio installer default (`write-env.js`)

**Files:**
- Modify: `pinokio-scripts/lib/write-env.js`
- Test: `pinokio-scripts/lib/write-env.test.js`

**Interfaces:**
- Produces: `defaultLibraryDir(homedir: string): string | null` — `join(homedir,'Castwright')` when `homedir` is a non-empty absolute path, else `null`.
- Produces: `chooseFreshWorkspaceDir({ appDir, homedir, workspaceExists }): string` — the resolvability-decided path (does NOT probe writability).
- Produces: `buildEnvContents({ exampleText, workspaceDir, envExists }): string | null` — now takes a decided `workspaceDir` (was computed internally).

- [ ] **Step 1: Write the failing tests** (replace the file's body with the new-signature suite)

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEnvContents,
  defaultLibraryDir,
  chooseFreshWorkspaceDir,
} = require('./write-env.js');

const EXAMPLE = ['# comment', 'PORT=8080', 'WORKSPACE_DIR=../audiobook-workspace', 'OTHER=keep-me'].join('\n');

test('defaultLibraryDir: absolute homedir -> <home>/Castwright', () => {
  assert.equal(defaultLibraryDir('/home/me'), require('node:path').join('/home/me', 'Castwright'));
});
test('defaultLibraryDir: empty/relative homedir -> null', () => {
  assert.equal(defaultLibraryDir(''), null);
  assert.equal(defaultLibraryDir('relative/dir'), null);
});

test('chooseFreshWorkspaceDir: fresh install, usable home -> <home>/Castwright', () => {
  const out = chooseFreshWorkspaceDir({ appDir: '/app', homedir: '/home/me', workspaceExists: false });
  assert.equal(out, require('node:path').join('/home/me', 'Castwright'));
});
test('chooseFreshWorkspaceDir: existing <appDir>/workspace -> keep it (migration guard)', () => {
  const out = chooseFreshWorkspaceDir({ appDir: '/app', homedir: '/home/me', workspaceExists: true });
  assert.equal(out, '/app/workspace');
});
test('chooseFreshWorkspaceDir: unusable home -> install-local fallback', () => {
  const out = chooseFreshWorkspaceDir({ appDir: '/app', homedir: '', workspaceExists: false });
  assert.equal(out, '/app/workspace');
});

test('buildEnvContents: returns null when .env exists (idempotent)', () => {
  assert.equal(buildEnvContents({ exampleText: EXAMPLE, workspaceDir: '/x', envExists: true }), null);
});
test('buildEnvContents: rewrites only the WORKSPACE_DIR line', () => {
  const out = buildEnvContents({ exampleText: EXAMPLE, workspaceDir: '/home/me/Castwright', envExists: false });
  assert.match(out, /^WORKSPACE_DIR=\/home\/me\/Castwright$/m);
  assert.match(out, /^PORT=8080$/m);
  assert.match(out, /^OTHER=keep-me$/m);
  assert.equal((out.match(/^WORKSPACE_DIR=/gm) || []).length, 1);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test pinokio-scripts/lib/write-env.test.js`
Expected: FAIL — `defaultLibraryDir`/`chooseFreshWorkspaceDir` not exported; `buildEnvContents` old signature.

- [ ] **Step 3: Implement** (replace `pinokio-scripts/lib/write-env.js`)

```js
// Generate server/.env from server/.env.example with WORKSPACE_DIR pointed at the
// fresh-install default (~/Castwright) — but only if server/.env does not already
// exist (idempotent), and keeping an existing <appDir>/workspace when present.
// See docs/superpowers/specs/2026-07-15-first-run-library-location-design.md.
//
// CLI: `node pinokio-scripts/lib/write-env.js [appDir]` — invoked by pinokio-scripts/install.js.

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, join, isAbsolute } = require('node:path');
const os = require('node:os');

/** Fresh-install default library dir, or null when the home dir is unusable. Pure. */
function defaultLibraryDir(homedir = os.homedir()) {
  if (!homedir || !isAbsolute(homedir)) return null;
  return join(homedir, 'Castwright');
}

/** Resolvability-only choice (no writability probe). Pure. */
function chooseFreshWorkspaceDir({ appDir, homedir = os.homedir(), workspaceExists }) {
  const installLocal = `${appDir}/workspace`;
  if (workspaceExists) return installLocal; // migration guard: keep an existing library
  return defaultLibraryDir(homedir) ?? installLocal; // resolvability fallback
}

/** Produce the .env contents, or null when .env already exists. Pure. */
function buildEnvContents({ exampleText, workspaceDir, envExists }) {
  if (envExists) return null;
  return exampleText.replace(/^WORKSPACE_DIR=.*$/m, `WORKSPACE_DIR=${workspaceDir}`);
}

module.exports = { buildEnvContents, defaultLibraryDir, chooseFreshWorkspaceDir };

// ---- CLI (acceptance-tested via the pure helpers above) ----
if (require.main === module) {
  const appDir = process.argv[2] || process.cwd();
  const examplePath = resolve('server', '.env.example');
  const envPath = resolve('server', '.env');
  const installLocal = `${appDir}/workspace`;

  let workspaceDir = chooseFreshWorkspaceDir({
    appDir,
    workspaceExists: existsSync(installLocal),
  });
  // Boot-safety: never emit a dir we can't create. Probe once; fall back on failure.
  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (err) {
    process.stdout.write(`[write-env] ${workspaceDir} not creatable (${err.code}); using ${installLocal}\n`);
    workspaceDir = installLocal;
  }

  const out = buildEnvContents({
    exampleText: readFileSync(examplePath, 'utf8'),
    workspaceDir,
    envExists: existsSync(envPath),
  });
  if (out === null) {
    process.stdout.write('[write-env] server/.env already exists — left untouched\n');
  } else {
    writeFileSync(envPath, out, 'utf8');
    process.stdout.write(`[write-env] wrote server/.env (WORKSPACE_DIR=${workspaceDir})\n`);
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test pinokio-scripts/lib/write-env.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add pinokio-scripts/lib/write-env.js pinokio-scripts/lib/write-env.test.js
git commit -m "feat(pinokio): default fresh installs to ~/Castwright, keep existing workspace"
```

---

## Task 2: Versioned launcher default (`launch.mjs`)

**Files:**
- Modify: `launch.mjs`
- Test: `scripts/tests/launch.test.mjs`

**Interfaces:**
- Produces (ESM exports): `defaultLibraryDir(homedir): string | null` (same semantics as Task 1).
- Produces: `chooseWorkspaceDir({ installRoot, homedir, exists }): string` — resolvability-only; existing `<installRoot>/workspace` wins, else `~/Castwright`, else `<installRoot>/workspace`.
- Produces: `ensureWorkspaceWritable(chosen, fallback, mkdir): string` — side-effecting; returns `chosen` if `mkdir(chosen,{recursive:true})` succeeds, else `fallback` (mkdir injected for tests).
- Consumes: existing `planLaunch({ installRoot, baseEnv, readDir, exists, readPointer })` (`launch.mjs:51`). `planLaunch` uses `chooseWorkspaceDir` for `shared.WORKSPACE_DIR` (resolvability only — it stays pure). Writability is applied by the run path, not `planLaunch`.

- [ ] **Step 1: Write the failing tests** (append to `scripts/tests/launch.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { defaultLibraryDir, chooseWorkspaceDir, ensureWorkspaceWritable, planLaunch } from '../../launch.mjs';

test('defaultLibraryDir: absolute -> <home>/Castwright; empty -> null', () => {
  assert.equal(defaultLibraryDir('/home/me'), join('/home/me', 'Castwright'));
  assert.equal(defaultLibraryDir(''), null);
});

test('chooseWorkspaceDir: fresh install + usable home -> ~/Castwright', () => {
  const out = chooseWorkspaceDir({ installRoot: '/inst', homedir: '/home/me', exists: () => false });
  assert.equal(out, join('/home/me', 'Castwright'));
});
test('chooseWorkspaceDir: existing <install>/workspace -> keep it', () => {
  const out = chooseWorkspaceDir({ installRoot: '/inst', homedir: '/home/me', exists: (p) => p === join('/inst', 'workspace') });
  assert.equal(out, join('/inst', 'workspace'));
});
test('chooseWorkspaceDir: unusable home -> install-local', () => {
  const out = chooseWorkspaceDir({ installRoot: '/inst', homedir: '', exists: () => false });
  assert.equal(out, join('/inst', 'workspace'));
});

test('ensureWorkspaceWritable: mkdir ok -> chosen', () => {
  const out = ensureWorkspaceWritable('/a/Castwright', '/inst/workspace', () => {});
  assert.equal(out, '/a/Castwright');
});
test('ensureWorkspaceWritable: mkdir throws -> fallback', () => {
  const out = ensureWorkspaceWritable('/a/Castwright', '/inst/workspace', () => { throw new Error('EACCES'); });
  assert.equal(out, '/inst/workspace');
});

test('planLaunch: release mode, fresh install, uses ~/Castwright for WORKSPACE_DIR', () => {
  const plan = planLaunch({
    installRoot: '/inst',
    baseEnv: {},
    homedir: '/home/me',
    exists: (p) => p === '/inst/releases' || p === '/inst/.current-version' || p === '/inst/releases/v1.0.0',
    readDir: () => ['v1.0.0'],
    readPointer: () => '1.0.0',
  });
  assert.equal(plan.mode, 'release');
  assert.equal(plan.envOverrides.WORKSPACE_DIR, join('/home/me', 'Castwright'));
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test scripts/tests/launch.test.mjs`
Expected: FAIL — new exports missing; `planLaunch` doesn't accept `homedir` / still uses `join(installRoot,'workspace')`.

- [ ] **Step 3: Implement** — in `launch.mjs`:

Add imports at top (near the existing `node:fs`/`node:path` imports):

```js
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir as osHomedir } from 'node:os';
```

Add the helpers (after `highestReleaseVersion`):

```js
/** Fresh-install default library dir, or null when the home dir is unusable. Pure. */
export function defaultLibraryDir(homedir = osHomedir()) {
  if (!homedir || !isAbsolute(homedir)) return null;
  return join(homedir, 'Castwright');
}

/** Resolvability-only workspace choice. Existing <installRoot>/workspace wins
    (migration guard); else ~/Castwright; else install-local. Pure. */
export function chooseWorkspaceDir({ installRoot, homedir = osHomedir(), exists = existsSync }) {
  const installLocal = join(installRoot, 'workspace');
  if (exists(installLocal)) return installLocal;
  return defaultLibraryDir(homedir) ?? installLocal;
}

/** Boot-safety: return `chosen` if creatable, else `fallback`. mkdir injected for tests. */
export function ensureWorkspaceWritable(chosen, fallback, mkdir = (p) => mkdirSync(p, { recursive: true })) {
  try {
    mkdir(chosen);
    return chosen;
  } catch {
    return fallback;
  }
}
```

In `planLaunch`, thread `homedir` through and replace the `WORKSPACE_DIR` line:

```js
export function planLaunch({ installRoot, baseEnv = {}, readDir = readdirSync, exists = existsSync, readPointer, homedir = osHomedir() }) {
  // ... unchanged up to `const shared = {` ...
  const shared = {
    WORKSPACE_DIR: chooseWorkspaceDir({ installRoot, homedir, exists }),
    SIDECAR_VENV_DIR: join(installRoot, 'venv'),
    // ... rest unchanged ...
  };
  // ... unchanged ...
}
```

In the file's **main run path** (the non-exported bottom of `launch.mjs` that calls `planLaunch` and spawns), after computing the plan and before spawning, apply the writability probe ONLY for a fresh `~/Castwright` (never mkdir-probe an install-local path the installer owns):

```js
if (plan.mode === 'release' && plan.envOverrides.WORKSPACE_DIR) {
  const installLocal = join(installRoot, 'workspace');
  if (plan.envOverrides.WORKSPACE_DIR !== installLocal) {
    plan.envOverrides.WORKSPACE_DIR = ensureWorkspaceWritable(plan.envOverrides.WORKSPACE_DIR, installLocal);
  }
}
```

(If `launch.mjs`'s bottom is not structured to allow this, wrap the plan→spawn glue in a small function; keep `planLaunch` pure. Confirm the exact insertion point by reading `launch.mjs` lines 100–end.)

- [ ] **Step 3b: Fix the EXISTING regressing assertion.** `scripts/tests/launch.test.mjs:50` (the release-mode test) asserts `plan.envOverrides.WORKSPACE_DIR === join(INSTALL, 'workspace')` with an `exists` set that does NOT include `<install>/workspace` and passes no `homedir`. After this change `chooseWorkspaceDir` returns `join(realHome,'Castwright')` and the assertion fails machine-dependently. Update that test to force install-local by passing `homedir: ''` to its `planLaunch(...)` call (or add `join(INSTALL,'workspace')` to its `exists` set). Do this in the same edit as Step 1.

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test scripts/tests/launch.test.mjs`
Then confirm the hook lane is green: `npm run test:hooks`
Expected: PASS, including the amended existing release-mode test.

- [ ] **Step 5: Commit**

```bash
git add launch.mjs scripts/tests/launch.test.mjs
git commit -m "feat(scripts): versioned launcher defaults fresh installs to ~/Castwright"
```

---

## Task 3: `StepLibrary` component + unit test (isolated)

**Files:**
- Create: `src/components/setup/step-library.tsx`
- Test: `src/components/setup/step-library.test.tsx`

**Interfaces:**
- Produces: `StepLibrary` React component with props `{ readiness: SetupReadiness; onLibrarySaved?: () => void }`. (`readiness` for contract uniformity, unused; `onLibrarySaved` lets the wizard latch a session flag — Task 4/5.)
- Consumes: `useAppSelector`/`useAppDispatch` (`src/store`), `saveAccountSettings` (`src/store/account-slice`), `api.getLibrary` (`src/lib/api`), `SetupReadiness` type (`src/lib/api`).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { accountSlice } from '../../store/account-slice';
import { StepLibrary } from './step-library';
import { api } from '../../lib/api';
import type { SetupReadiness } from '../../lib/api';

const READINESS = { ready: true, completedAt: null, blockers: {} as never, info: { gpu: 'CPU' } } as unknown as SetupReadiness;

// Store idiom — mirrors step-defaults.test.tsx:53-65. NO default export exists;
// use accountSlice.reducer + accountSlice.getInitialState() (also fully resolves
// the account shape — do NOT hand-build AccountState).
type AccountPreload = Partial<ReturnType<typeof accountSlice.getInitialState>>;
function makeStore(over: AccountPreload = {}) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: { ...accountSlice.getInitialState(), ...over } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}
// getLibrary() shape is { authors: [{ name, series: [{ name, books: [] }] }] }.
const EMPTY_LIB = { authors: [] };
const TWO_BOOKS = { authors: [{ name: 'A', series: [{ name: 'S', books: [{}, {}] }] }] };

beforeEach(() => {
  vi.spyOn(api, 'getLibrary').mockResolvedValue(EMPTY_LIB as never);
});

describe('StepLibrary', () => {
  it('shows the resolved workspaceRoot as read-only display', async () => {
    render(<Provider store={makeStore({ workspaceRoot: 'C:\\Users\\me\\Castwright', workspaceSource: 'default' })}>
      <StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/C:\\Users\\me\\Castwright/)).toBeInTheDocument();
  });

  it('with no override: input empty, not dirty, no restart badge, Save disabled, no dispatch', async () => {
    const store = makeStore({ workspaceDirOverride: null });
    const spy = vi.spyOn(store, 'dispatch');
    render(<Provider store={store}><StepLibrary readiness={READINESS} /></Provider>);
    const input = await screen.findByLabelText(/library folder/i) as HTMLInputElement;
    expect(input.value).toBe('');               // REGRESSION: fails if seeded from workspaceRoot
    expect(screen.queryByText(/restart/i)).not.toBeInTheDocument();
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
    // No account/save action dispatched (getLibrary's fetch may dispatch nothing on this slice).
    const saveCalls = spy.mock.calls.filter(
      ([a]) => typeof a === 'object' && a !== null && String((a as { type?: string }).type).includes('account/save'),
    );
    expect(saveCalls).toHaveLength(0);
  });

  it('editing then Save dispatches workspaceDirOverride and calls onLibrarySaved', async () => {
    const store = makeStore({ workspaceDirOverride: null });
    const onSaved = vi.fn();
    render(<Provider store={store}><StepLibrary readiness={READINESS} onLibrarySaved={onSaved} /></Provider>);
    const input = await screen.findByLabelText(/library folder/i);
    fireEvent.change(input, { target: { value: 'D:\\Books' } });
    expect(screen.getByText(/restart/i)).toBeInTheDocument();     // dirty badge
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('workspaceSource "override" renders the provenance note', async () => {
    render(<Provider store={makeStore({ workspaceSource: 'override', workspaceDirOverride: 'D:\\Books' })}>
      <StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/saved location from your Castwright settings/i)).toBeInTheDocument();
  });

  it('non-empty library renders the "does not move existing files" warning', async () => {
    vi.spyOn(api, 'getLibrary').mockResolvedValue(TWO_BOOKS as never);
    render(<Provider store={makeStore()}><StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/does not move existing files/i)).toBeInTheDocument();
  });

  it('empty library renders the "nothing to move" copy', async () => {
    render(<Provider store={makeStore()}><StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/nothing to move/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- src/components/setup/step-library.test.tsx`
Expected: FAIL — `step-library` module not found.

- [ ] **Step 3: Implement** `src/components/setup/step-library.tsx`

```tsx
/* First-run — Step: Library.
   Shows where the audiobook library lives on disk (resolved workspaceRoot) and
   lets the user change it. Changing needs a server restart; the first-run
   library is empty so there's nothing to move — UNLESS books already exist, in
   which case we warn that changing the path does not move them.
   See docs/superpowers/specs/2026-07-15-first-run-library-location-design.md. */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SetupReadiness } from '../../lib/api';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveAccountSettings } from '../../store/account-slice';

interface Props {
  readiness: SetupReadiness;
  /** Latches a wizard-session flag so the Finish step can remind about the restart. */
  onLibrarySaved?: () => void;
}

const INPUT_CLS =
  'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30';

export function StepLibrary({ readiness: _readiness, onLibrarySaved }: Props) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);
  const persisted = account.workspaceDirOverride ?? '';

  const [input, setInput] = useState<string>(persisted);
  const [hasBooks, setHasBooks] = useState<boolean>(false);

  // Re-sync the input when the slice rehydrates (mirrors step-defaults).
  useEffect(() => {
    setInput(account.workspaceDirOverride ?? '');
  }, [account.hydrated, account.workspaceDirOverride]);

  // Non-empty-library signal — reuse the existing library listing, no new endpoint.
  // getLibrary() returns { authors: [{ series: [{ books: [] }] }] } — books are
  // nested three deep, so flatten (house idiom, src/lib/api.sample.test.ts:15).
  useEffect(() => {
    let alive = true;
    api
      .getLibrary()
      .then((lib) => {
        const count = lib.authors.flatMap((a) => a.series.flatMap((s) => s.books)).length;
        if (alive) setHasBooks(count > 0);
      })
      .catch(() => alive && setHasBooks(false)); // safe default: treat as empty
    return () => {
      alive = false;
    };
  }, []);

  const dirty = input !== persisted;

  const onSave = () => {
    dispatch(saveAccountSettings({ workspaceDirOverride: input.trim() === '' ? null : input.trim() }));
    onLibrarySaved?.();
  };

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-ink">Library</h2>

      <p className="text-sm text-ink/60">
        This is where Castwright keeps your audiobooks on disk. New installs use a
        folder in your home directory so it's easy to find and survives app updates.
      </p>

      {/* Read-only resolved path (NOT the input's value). */}
      <div className="rounded-2xl border border-ink/10 bg-canvas px-4 py-3">
        <p className="text-xs text-ink/55">Your audiobooks will be saved to</p>
        <p className="text-sm font-medium text-ink break-all">{account.workspaceRoot || '(unknown)'}</p>
        {account.workspaceSource === 'override' && (
          <p className="mt-1 text-xs text-ink/50">Using a saved location from your Castwright settings.</p>
        )}
      </div>

      <div>
        <label htmlFor="setup-library-path" className="block text-sm font-medium text-ink mb-1">
          Change library folder
        </label>
        <input
          id="setup-library-path"
          aria-label="Library folder"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="(leave empty to use the default)"
          className={INPUT_CLS}
        />
        {dirty && (
          <p className="mt-2 text-xs text-amber-800 bg-amber-100 rounded-full px-3 py-1 inline-block">
            Restart the server to apply this change.
          </p>
        )}
        <p className="mt-2 text-xs text-ink/55">
          {hasBooks
            ? 'You already have audiobooks here. Changing this does not move existing files — you would need to copy them across yourself.'
            : 'Your library is empty, so there is nothing to move. On a Pinokio install, Stop and Start to apply.'}
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty}
            className="min-h-[44px] fine-pointer:min-h-0 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-medium hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- src/components/setup/step-library.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-library.tsx src/components/setup/step-library.test.tsx
git commit -m "feat(frontend): add StepLibrary first-run step (prefill from raw override)"
```

---

## Task 4: Wire the Library step into the wizard

**Files:**
- Modify: `src/components/setup/steps.ts`
- Modify: `src/lib/wiki-links.ts`
- Modify: `src/components/setup/setup-wizard.tsx`
- Test: `src/components/setup/setup-wizard.test.tsx`, `src/lib/wiki-links.test.ts` (auto-covers)

**Interfaces:**
- Consumes: `StepLibrary` (Task 3).
- Produces: `StepId` now includes `'library'`; `STEPS` has 8 entries; `renderStep` handles `'library'` and is exhaustive via `assertNever`.

- [ ] **Step 1: Update `setup-wizard.test.tsx` for the 8th step.** The suite stubs the step components and renders `SetupWizard` with **no redux `<Provider>`**, so the real `StepLibrary` (which uses `useAppSelector`/`api.getLibrary`) would throw when paged to. Make ALL of these edits:

  1. **Add a `step-library` stub** alongside the others (near line 43-45):

```tsx
vi.mock('./step-library', () => ({
  StepLibrary: () => <div data-testid="step-library-stub">library</div>,
}));
```

  2. **Add its testid** to the `STEP_TESTIDS` array (line 85), inserted after `'step-defaults-stub'` and before `'step-lan-cert-stub'`:

```tsx
  'step-defaults-stub',
  'step-library-stub',
  'step-lan-cert-stub',
```

  3. **Bump every `of 7` string** to `of 8` — lines 140 (test title), 149, 167, 183, 234, 287 (`/step N of 7/i` → the count changes to 8; the last-step assertion at 234 becomes `/step 8 of 8/i`).
  4. **Bump the two paging loops** that walk to the last step: `for (let i = 0; i < 6; i++)` → `< 7` at lines 230 and 249 (one extra Next to reach the now-8th step).
  5. The comment at 284 ("step 2 of 7") → "step 2 of 8"; the ffmpeg row still maps to step index 1, unchanged.
  6. **Add a Library assertion:**

```tsx
it('guided mode reaches the Library step', () => {
  render(<SetupWizard readiness={READINESS} mode="guided" onRefetch={() => {}} onFinish={() => {}} />);
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: /next/i }));
  expect(screen.getByTestId('step-library-stub')).toBeInTheDocument();
  expect(screen.getByText(/step 6 of 8/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- src/components/setup/setup-wizard.test.tsx`
Expected: FAIL — new Library assertion + `of 8` strings not yet satisfied by the wizard.

- [ ] **Step 3: Implement**

`src/components/setup/steps.ts` — add to the union and the array (after `defaults`):

```ts
export type StepId =
  | 'environment' | 'ffmpeg' | 'analysis' | 'voice' | 'defaults' | 'library' | 'lanCert' | 'finish';

export const STEPS: { id: StepId; title: string }[] = [
  { id: 'environment', title: 'Environment' },
  { id: 'ffmpeg', title: 'ffmpeg' },
  { id: 'analysis', title: 'Analysis' },
  { id: 'voice', title: 'Voice' },
  { id: 'defaults', title: 'Defaults' },
  { id: 'library', title: 'Library' },
  { id: 'lanCert', title: 'LAN access' },
  { id: 'finish', title: 'Finish' },
];
```

`src/lib/wiki-links.ts` — add the mapping (the `satisfies Record<StepId, WikiPage>` makes this a COMPILE error until added):

```ts
export const WIZARD_STEP_WIKI = {
  environment: 'Installing-Castwright',
  ffmpeg: 'Installing-Castwright',
  analysis: 'Analysis-and-the-Analyzer',
  voice: 'Voice-Engines',
  defaults: 'Account-and-Settings',
  library: 'Account-and-Settings',
  lanCert: 'Mobile-Tablet-and-Companion-App',
  finish: 'Generating-Audio',
} satisfies Record<StepId, WikiPage>;
```

`src/components/setup/setup-wizard.tsx`:

1. Import + assertNever helper at top:

```tsx
import { StepLibrary } from './step-library';

function assertNever(x: never): never {
  throw new Error(`Unhandled wizard step: ${String(x)}`);
}
```

2. Thread a session flag through the wizard. In `SetupWizard`, add:

```tsx
const [libraryChanged, setLibraryChanged] = useState(false);
```

Pass `libraryChanged` + `onLibraryChanged={() => setLibraryChanged(true)}` down through `GuidedWizard`/`ReEntryFlow` into `renderStep` (mirror the existing `voiceNeeds`/`onChooseVoiceNeeds` threading — add two params to each function signature and the `renderStep` call site).

3. `renderStep` — add the case and the exhaustiveness default:

```tsx
    case 'defaults':
      return <StepDefaults readiness={readiness} />;
    case 'library':
      return <StepLibrary readiness={readiness} onLibrarySaved={onLibraryChanged} />;
    case 'lanCert':
      return <StepLanCert />;
    case 'finish':
      return <StepFinish readiness={readiness} onFinish={onFinish} onTryDemoBook={onTryDemoBook} libraryChanged={libraryChanged} />;
    default:
      return assertNever(id);
```

(`renderStep` gains params `libraryChanged: boolean` and `onLibraryChanged: () => void`.)

5. **Declare the `StepFinish.libraryChanged` prop in THIS task** so the tree typechecks green between Task 4 and Task 5 (passing an undeclared prop is a TS2322 error). In `src/components/setup/step-finish.tsx`, add the optional prop to `Props` and accept it (rendering it is Task 5):

```tsx
interface Props {
  readiness: SetupReadiness;
  onFinish: () => void;
  onTryDemoBook?: () => void;
  /** True when the user changed the library location earlier in the wizard (Task 5 renders the reminder). */
  libraryChanged?: boolean;
}
export function StepFinish({ readiness: _readiness, onFinish, onTryDemoBook, libraryChanged: _libraryChanged }: Props) {
```

(The `_libraryChanged` underscore keeps lint happy until Task 5 uses it. Commit `step-finish.tsx` with this task.)

4. `buildSummaryRows` — insert a `library` row after `defaults` and **fix `lanCert`'s `stepIndex` 5→6** (the insertion shifts it):

```ts
    {
      key: 'defaults', label: 'Defaults', detail: 'New-book starting points', status: 'ok', stepIndex: 4,
    },
    {
      key: 'library', label: 'Library', detail: 'Where audiobooks are saved', status: 'ok', stepIndex: 5,
    },
    {
      key: 'lanCert', label: 'LAN access', detail: 'Phone/tablet HTTPS certificate', status: 'ok', stepIndex: 6,
    },
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- src/components/setup/setup-wizard.test.tsx src/lib/wiki-links.test.ts`
Then typecheck (catches a missed `renderStep` case / wiki map): `npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/steps.ts src/lib/wiki-links.ts src/components/setup/setup-wizard.tsx src/components/setup/setup-wizard.test.tsx src/components/setup/step-finish.tsx
git commit -m "feat(frontend): wire Library step into the setup wizard + summary board"
```

---

## Task 5: Finish-step restart reminder

**Files:**
- Modify: `src/components/setup/step-finish.tsx`
- Test: `src/components/setup/step-finish.test.tsx` (create if absent, else extend)

**Interfaces:**
- Consumes: `libraryChanged?: boolean` prop — already DECLARED on `StepFinish.Props` in Task 4 (as `_libraryChanged`). This task renders the reminder body and reads `useAppSelector(s => s.account.workspaceDirOverride)` to name the target path.

- [ ] **Step 1: Write the failing test** (`src/components/setup/step-finish.test.tsx` — create; if a StepFinish test already exists, extend it instead)

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { accountSlice } from '../../store/account-slice';
import { StepFinish } from './step-finish';
import { api } from '../../lib/api';
import type { SetupReadiness } from '../../lib/api';

const READINESS = { ready: true, completedAt: null, blockers: {} as never, info: { gpu: 'CPU' } } as unknown as SetupReadiness;

function store(over: Partial<ReturnType<typeof accountSlice.getInitialState>> = {}) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: { ...accountSlice.getInitialState(), ...over } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

// StepFinish's smoke-test button calls api.runSmokeTest lazily; stub so mount is inert.
beforeEach(() => {
  vi.spyOn(api, 'runSmokeTest').mockResolvedValue({ ok: true, url: '' } as never);
});

describe('StepFinish library reminder', () => {
  it('shows restart reminder when libraryChanged', () => {
    render(<Provider store={store({ workspaceDirOverride: 'D:\\Books' })}>
      <StepFinish readiness={READINESS} onFinish={() => {}} libraryChanged /></Provider>);
    expect(screen.getByText(/Restart .* to move your library/i)).toBeInTheDocument();
    expect(screen.getByText(/D:\\Books/)).toBeInTheDocument();
  });
  it('hides it when not changed', () => {
    render(<Provider store={store()}><StepFinish readiness={READINESS} onFinish={() => {}} libraryChanged={false} /></Provider>);
    expect(screen.queryByText(/move your library/i)).not.toBeInTheDocument();
  });
});
```

Note: StepFinish did not previously read redux, so wrapping it in a `<Provider>` here is new — that's why the test builds a store.

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- src/components/setup/step-finish.test.tsx`
Expected: FAIL — reminder not rendered (`_libraryChanged` is unused from Task 4).

- [ ] **Step 3: Implement** — in `step-finish.tsx`, replace the Task-4 placeholder param with a live one, add the redux read, and render the reminder:

```tsx
import { useAppSelector } from '../../store';
// Props already declares libraryChanged?: boolean (Task 4). Change the destructure:
export function StepFinish({ readiness: _readiness, onFinish, onTryDemoBook, libraryChanged }: Props) {
  const target = useAppSelector((s) => s.account.workspaceDirOverride);
  // ... existing useState hooks unchanged ...
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-ink">Ready to perform</h2>
      {libraryChanged && (
        <p className="text-xs text-amber-800 bg-amber-100 rounded-2xl px-4 py-2">
          Restart the server to move your library to <span className="font-medium break-all">{target}</span>.
        </p>
      )}
      {/* ...rest of the existing section unchanged... */}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- src/components/setup/step-finish.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-finish.tsx src/components/setup/step-finish.test.tsx
git commit -m "feat(frontend): remind to restart on Finish when library location changed"
```

---

## Task 6: e2e coverage, docs, release notes, issue link

**Files:**
- Modify: `e2e/responsive/coverage.spec.ts` (or the existing setup e2e spec — confirm which drives the wizard) — assert the Library step renders.
- Modify: `docs/features/218-pinokio-installer.md`, the fs-21 wizard plan doc.
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`.
- Modify: `docs/features/INDEX.md` only if a plan moves.

- [ ] **Step 1: e2e** — the guided wizard needs satisfied readiness to page through, which mock mode may not provide. Primary approach: assert the **re-entry summary board** shows the new row via its testid `setup-summary-row-library` (added in Task 4). Identify the spec that already exercises the setup wizard by grepping `e2e/` for `setup-summary` / `data-testid="setup-` and extend the nearest one; if none drives the wizard, add a minimal `e2e/setup-library.spec.ts`. Run: `npm run test:e2e -- <spec>`. Expected: PASS. If neither the guided step nor the summary row is reachable in mock mode, record that explicitly in the PR (the Task 3–5 unit/component coverage is the real gate) rather than shipping a hollow spec.

- [ ] **Step 2: Docs** — in `docs/features/218-pinokio-installer.md`, document that `write-env.js` now defaults a fresh install's `WORKSPACE_DIR` to `~/Castwright` (keeping an existing `<appRoot>/workspace`, falling back if home is unusable). In the fs-21 wizard plan, add the Library step to the step list.

- [ ] **Step 3: Release notes** — append to `docs/release-notes-next.md` (technical, PR-refed) and a brand-voice line to the top in-progress section of `RELEASE_NOTES.md`:
  - Technical: "New installs keep the audiobook library in a discoverable `~/Castwright` folder (existing installs unchanged); first-run adds a Library step to confirm or change it."
  - Brand: "Your audiobooks now live in an easy-to-find Castwright folder in your home directory — and first-run setup lets you point it wherever you like."

- [ ] **Step 4: Issue link** — file/confirm a GitHub issue (area: setup wizard / fs-21; or a fresh Backlog item) and note `Closes #NN` for the PR body. Add a thin row to `docs/BACKLOG.md` if it's a new tracked item.

- [ ] **Step 5: Commit**

```bash
git add e2e docs RELEASE_NOTES.md
git commit -m "test(e2e),docs: cover Library wizard step + document ~/Castwright default"
```

---

## Self-Review

**Spec coverage:**
- Lever A default relocation → Tasks 1 (Pinokio) + 2 (versioned launcher). Dev fallback deliberately unchanged (no task touches `paths.ts` default). ✓
- Migration invariant (dir-existence guards both sites) → Task 1 `chooseFreshWorkspaceDir` + Task 2 `chooseWorkspaceDir`, with tests. ✓
- Boot-safety / homedir fallback, split into resolvability (pure) + writability (side-effecting) → Task 1 (`chooseFreshWorkspaceDir` pure + CLI mkdir probe) & Task 2 (`chooseWorkspaceDir` pure + `ensureWorkspaceWritable` injected-mkdir test). ✓ (carry-forward #2)
- Lever B step + prefill/dirty CRITICAL fix → Task 3 (input from raw override; regression test asserts empty). ✓
- renderStep case + assertNever + summary-row index fix → Task 4. ✓
- Non-empty-library degradation via `api.getLibrary()` (no new endpoint) → Task 3. ✓ (carry-forward #3)
- Provenance note when `workspaceSource==='override'` → Task 3. ✓
- Finish reminder → Task 5. ✓
- wizard-coherence guardrail (`wiki-links.test.ts` iterates STEPS) auto-covers the new step → Task 4 runs it. ✓
- Docs + release notes ×2 + issue link → Task 6. ✓

**Placeholder scan:** No TBD/TODO. Two "confirm at plan time" notes remain as explicit implementer verifications (exact `launch.mjs` bottom insertion point; which e2e spec drives the wizard) — each names precisely what to check, not a deferred design decision.

**Type consistency:** `defaultLibraryDir`/`chooseFreshWorkspaceDir`/`chooseWorkspaceDir`/`ensureWorkspaceWritable`/`buildEnvContents` signatures are consistent across tasks and their tests. `StepLibrary` prop `onLibrarySaved` (Task 3) is fed by the wizard's `onLibraryChanged` (Task 4); `StepFinish` prop `libraryChanged` (Task 5) matches the wizard's threaded state. `WIZARD_STEP_WIKI['library'] = 'Account-and-Settings'` is a valid `WikiPage`.

## Plan-review fold (2026-07-15)

Adversarial plan review (Opus) found 2 CRITICAL + 3 MAJOR against the real code; all folded:

- **[CRITICAL] `getLibrary()` shape** — returns `{ authors: [{ series: [{ books }] }] }`, not `{ books }`. Task 3 now flattens `authors.flatMap(a => a.series.flatMap(s => s.books))` (house idiom, `api.sample.test.ts:15`); test mocks use the `{ authors: [...] }` shape.
- **[CRITICAL] no default reducer export** — Task 3 & 5 tests now use `accountSlice.reducer` + `accountSlice.getInitialState()` (mirrors `step-defaults.test.tsx:53-65`), which also removes the hand-waved `baseAccount()`.
- **[MAJOR] Task 4 breaks `setup-wizard.test.tsx`** — Task 4 Step 1 now adds the `./step-library` stub, the `STEP_TESTIDS` entry, bumps every `of 7`→`of 8` (lines 140/149/167/183/234/287) and the `< 6`→`< 7` loops (230/249).
- **[MAJOR] Task 2 regresses `launch.test.mjs:50`** — Task 2 Step 3b amends that assertion (`homedir: ''`).
- **[MAJOR] Task 4→5 red typecheck** — `StepFinish.libraryChanged` prop is now DECLARED in Task 4 (as `_libraryChanged`); Task 5 renders it. Tree stays green between tasks.

Confirmed-fine (reviewer): `launch.mjs:102-126` `main()` is the writability-probe insertion point; `buildEnvContents` has no external caller; `renderStep` has no `default`; `Account-and-Settings.md` exists; the Finish reminder correctly keys off the session flag not `dirty`.

## Carry-forward #1 (helper duplication) — decided

`launch.mjs` is ESM, `pinokio-scripts/` is CommonJS. A shared module across the two trees is awkward; `defaultLibraryDir` is duplicated (≈4 lines) in each with a comment cross-referencing this spec. Accepted per the spec's Open Questions.
