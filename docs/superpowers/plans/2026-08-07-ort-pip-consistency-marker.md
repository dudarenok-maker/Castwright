# ONNX Runtime pip-consistency marker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every pip call into the sidecar venv from clobbering `onnxruntime-gpu`, by recording that `onnxruntime-gpu` provides the `onnxruntime` package.

**Architecture:** `planOrtSwap` gains a `marker` action that rides the plan its two consumers already execute. `install-ort.mjs` gains pure-fs primitives to write, identify and delete a minimal `onnxruntime-<version>.dist-info` marker. A boot-time `ensureOrtMarker` heals venvs bootstrapped before this change. No new dependencies, no subprocesses, no network.

**Tech Stack:** Node ESM (`.mjs`) for the sidecar scripts, TypeScript for `server/src`, Vitest for both. Server tests import the `.mjs` directly — the established pattern in `server/src/tts/install-ort-helpers.test.ts`.

**Design of record:** [`docs/superpowers/specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md`](../specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md) (revision 6, five adversarial review rounds). Issue: **#2192**.

## Global Constraints

- **No new dependencies.** Everything is `node:fs` / `node:path`.
- **No subprocess, no network, no `import onnxruntime`.** Every predicate is a file read. A provider probe would misread a GPU box whose CUDA DLLs fail to load, and would memory-map the very DLL #2192 is about.
- **Never match a distribution by directory name alone.** On cpu/amd/apple the *real* plain distribution has a byte-identical directory name to our marker.
- **Marker identity is `INSTALLER == "castwright-ort-marker"` AND an empty `RECORD`.** Both, always, before any delete or overwrite.
- **`RECORD` must stay empty** — that is what makes `pip uninstall` a safe no-op on it (spike-verified).
- Branch: `docs/docs-2192-qwen-ort-chokepoint` (already cut, worktree `C:\Claude\Projects\wt-2192-qwen-ort-chokepoint`). Rename to `fix/side-2192-ort-marker` before opening the PR.
- Commit convention: `<type>(<scope>): <subject>`. Scopes here: `side` (sidecar scripts), `server`, `docs`.
- Every assertion is mutation-checked: change the assertion's own line, confirm it fails, revert.

---

### Task 1: Venv path + distribution-name primitives

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs`
- Test: `server/src/tts/ort-marker-paths.test.ts`

**Interfaces:**
- Consumes: `installRecipe` from `./accelerator-profile.mjs` (already imported).
- Produces: `SWAP_ORT_PACKAGES: string[]`, `escapeDistName(name: string): string`, `sitePackagesDir(venvDir: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/ort-marker-paths.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SWAP_ORT_PACKAGES, escapeDistName, sitePackagesDir } from '../../tts-sidecar/scripts/install-ort.mjs';

describe('escapeDistName', () => {
  it('escapes per PEP 427 so the glob matches the real directory', () => {
    // pip writes onnxruntime_gpu-1.27.0.dist-info — underscore, not hyphen.
    expect(escapeDistName('onnxruntime-gpu')).toBe('onnxruntime_gpu');
    expect(escapeDistName('onnxruntime-directml')).toBe('onnxruntime_directml');
    expect(escapeDistName('onnxruntime')).toBe('onnxruntime');
  });
});

describe('SWAP_ORT_PACKAGES', () => {
  it('is derived from installRecipe, not hand-typed', () => {
    expect(SWAP_ORT_PACKAGES).toContain('onnxruntime-gpu');
    expect(SWAP_ORT_PACKAGES).not.toContain('onnxruntime');
  });
});

describe('sitePackagesDir', () => {
  it('finds the Windows layout', () => {
    const venv = mkdtempSync(join(tmpdir(), 'venv-'));
    mkdirSync(join(venv, 'Lib', 'site-packages'), { recursive: true });
    expect(sitePackagesDir(venv)).toBe(join(venv, 'Lib', 'site-packages'));
  });

  it('finds the posix layout without needing the minor version', () => {
    const venv = mkdtempSync(join(tmpdir(), 'venv-'));
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages'), { recursive: true });
    expect(sitePackagesDir(venv)).toBe(join(venv, 'lib', 'python3.12', 'site-packages'));
  });

  it('returns null on a venv with no site-packages (half-built box)', () => {
    const venv = mkdtempSync(join(tmpdir(), 'venv-'));
    expect(sitePackagesDir(venv)).toBeNull();
  });

  it('returns null when the posix layout is ambiguous', () => {
    const venv = mkdtempSync(join(tmpdir(), 'venv-'));
    mkdirSync(join(venv, 'lib', 'python3.11', 'site-packages'), { recursive: true });
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages'), { recursive: true });
    expect(sitePackagesDir(venv)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ort-marker-paths.test.ts`
Expected: FAIL — `SWAP_ORT_PACKAGES is not exported` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `server/tts-sidecar/scripts/install-ort.mjs` (it already imports `installRecipe`; add `readdirSync`, `existsSync`, `join` imports as needed):

```js
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { installRecipe, PROFILES } from './accelerator-profile.mjs';

/** Distribution names that OWN the onnxruntime namespace on some profile.
 *  DERIVED from installRecipe, never hand-typed — a hand-typed list is a second
 *  source of truth for a set installRecipe already determines, and would miss a
 *  future onnxruntime-directml re-enable. */
export const SWAP_ORT_PACKAGES = [
  ...new Set(
    PROFILES.flatMap((p) =>
      ['win32', 'linux', 'darwin'].map((plat) => installRecipe(p, plat).ortPackage),
    ).filter((pkg) => pkg !== 'onnxruntime'),
  ),
];

/** PEP 427 escaping: pip writes `onnxruntime-gpu` to disk as `onnxruntime_gpu`.
 *  Globbing the UNESCAPED name matches zero directories — which, combined with
 *  the fail-loudly rule, would break every NVIDIA bootstrap. */
export function escapeDistName(name) {
  return name.replace(/[-_.]+/g, '_');
}

/** Resolve site-packages inside a venv dir. Pure fs — no interpreter spawn.
 *  Returns null when absent or ambiguous; callers treat null as "do nothing". */
export function sitePackagesDir(venvDir) {
  const win = join(venvDir, 'Lib', 'site-packages');
  if (existsSync(win)) return win;
  const libDir = join(venvDir, 'lib');
  if (!existsSync(libDir)) return null;
  const hits = readdirSync(libDir)
    .filter((d) => d.startsWith('python'))
    .map((d) => join(libDir, d, 'site-packages'))
    .filter((p) => existsSync(p));
  return hits.length === 1 ? hits[0] : null;
}
```

Check `accelerator-profile.mjs` exports `PROFILES`; it does (`export const PROFILES = ['nvidia','amd','apple','cpu']`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/ort-marker-paths.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check**

Change `escapeDistName`'s regex to `/-/g` — the `onnxruntime-gpu` case must still pass but add a temporary assertion `expect(escapeDistName('a.b')).toBe('a_b')` and confirm it fails. Revert. Then change `sitePackagesDir`'s `hits.length === 1` to `>= 1` and confirm the ambiguous test fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-marker-paths.test.ts
git commit -m "feat(side): add venv path and distribution-name primitives for the ORT marker

Refs #2192"
```

---

### Task 2: Marker write, identity and delete

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs`
- Test: `server/src/tts/ort-marker-io.test.ts`

**Interfaces:**
- Consumes: `escapeDistName` (Task 1).
- Produces: `MARKER_INSTALLER: string`, `isOurMarker(distInfoDir: string): boolean`, `writeOrtMarker(sitePackages: string, version: string): void`, `deleteOrtMarkerIfOurs(sitePackages: string): boolean`, `findPlainOrtDistInfos(sitePackages: string): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/ort-marker-io.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MARKER_INSTALLER, isOurMarker, writeOrtMarker, deleteOrtMarkerIfOurs, findPlainOrtDistInfos,
} from '../../tts-sidecar/scripts/install-ort.mjs';

function sp() { return mkdtempSync(join(tmpdir(), 'sp-')); }

/** A REAL plain onnxruntime distribution — byte-identical directory name to ours. */
function realPlainDist(root: string, version = '1.28.0') {
  const d = join(root, `onnxruntime-${version}.dist-info`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'METADATA'), `Metadata-Version: 2.1\nName: onnxruntime\nVersion: ${version}\n`);
  writeFileSync(join(d, 'INSTALLER'), 'pip\n');
  writeFileSync(join(d, 'RECORD'), 'onnxruntime/capi/_pybind_state.pyd,sha256=abc,123\n');
  return d;
}

describe('isOurMarker', () => {
  it('accepts a marker we wrote', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');
    expect(isOurMarker(join(root, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('REFUSES the real plain distribution (name is identical — identity is not)', () => {
    const root = sp();
    const real = realPlainDist(root);
    expect(isOurMarker(real)).toBe(false);
  });

  it('refuses a dir with our INSTALLER but a non-empty RECORD', () => {
    const root = sp();
    const d = join(root, 'onnxruntime-9.9.9.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'INSTALLER'), `${MARKER_INSTALLER}\n`);
    writeFileSync(join(d, 'RECORD'), 'something\n');
    expect(isOurMarker(d)).toBe(false);
  });
});

describe('writeOrtMarker', () => {
  it('writes METADATA, INSTALLER and an EMPTY RECORD', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');
    const d = join(root, 'onnxruntime-1.27.0.dist-info');
    expect(readFileSync(join(d, 'METADATA'), 'utf8')).toContain('Name: onnxruntime');
    expect(readFileSync(join(d, 'METADATA'), 'utf8')).toContain('Version: 1.27.0');
    expect(readFileSync(join(d, 'INSTALLER'), 'utf8').trim()).toBe(MARKER_INSTALLER);
    expect(readFileSync(join(d, 'RECORD'), 'utf8')).toBe('');
  });

  it('overwrites a STALE marker rather than skipping it', () => {
    const root = sp();
    writeOrtMarker(root, '1.26.0');
    writeOrtMarker(root, '1.27.0');
    expect(existsSync(join(root, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
    expect(existsSync(join(root, 'onnxruntime-1.26.0.dist-info'))).toBe(false);
  });
});

describe('deleteOrtMarkerIfOurs', () => {
  it('removes our marker and reports true', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');
    expect(deleteOrtMarkerIfOurs(root)).toBe(true);
    expect(existsSync(join(root, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('REFUSES to delete the real plain distribution', () => {
    const root = sp();
    const real = realPlainDist(root);
    expect(deleteOrtMarkerIfOurs(root)).toBe(false);
    expect(existsSync(real)).toBe(true);
  });

  it('is a no-op when nothing is present', () => {
    expect(deleteOrtMarkerIfOurs(sp())).toBe(false);
  });

  it('deletes ours even when a real distribution sits beside it', () => {
    const root = sp();
    const real = realPlainDist(root, '1.28.0');
    writeOrtMarker(root, '1.27.0');
    expect(deleteOrtMarkerIfOurs(root)).toBe(true);
    expect(existsSync(real)).toBe(true);
  });
});

describe('findPlainOrtDistInfos', () => {
  it('identity-tests EVERY match, not just the first', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');          // ours, sorts first
    const real = realPlainDist(root, '1.28.0');
    expect(findPlainOrtDistInfos(root)).toEqual([real]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ort-marker-io.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `install-ort.mjs` (extend the `node:fs` import with `mkdirSync`, `writeFileSync`, `readFileSync`, `rmSync`, `statSync`):

```js
export const MARKER_INSTALLER = 'castwright-ort-marker';

/** Every `onnxruntime-<version>.dist-info` in site-packages — ours AND real ones.
 *  The trailing `-\d` is what excludes `onnxruntime_gpu-…` (underscore at index 11). */
function ortDistInfoDirs(sitePackages) {
  if (!existsSync(sitePackages)) return [];
  return readdirSync(sitePackages)
    .filter((d) => /^onnxruntime-\d.*\.dist-info$/.test(d))
    .map((d) => join(sitePackages, d));
}

/** Ours ONLY if the INSTALLER is our sentinel AND the RECORD is empty.
 *  Name is never sufficient: the real plain distribution's directory name is
 *  byte-identical to ours. */
export function isOurMarker(distInfoDir) {
  try {
    const installer = readFileSync(join(distInfoDir, 'INSTALLER'), 'utf8').trim();
    if (installer !== MARKER_INSTALLER) return false;
    return readFileSync(join(distInfoDir, 'RECORD'), 'utf8').trim() === '';
  } catch {
    return false;
  }
}

/** Real (non-marker) plain onnxruntime distributions. Tests EVERY match — ours
 *  and a real one can coexist, so answering from the first is a false negative. */
export function findPlainOrtDistInfos(sitePackages) {
  return ortDistInfoDirs(sitePackages).filter((d) => !isOurMarker(d));
}

/** Write (or overwrite) the marker. Removes any stale marker first so the
 *  version can never lag the installed runtime. */
export function writeOrtMarker(sitePackages, version) {
  deleteOrtMarkerIfOurs(sitePackages);
  const dir = join(sitePackages, `onnxruntime-${version}.dist-info`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'METADATA'),
    `Metadata-Version: 2.1\nName: onnxruntime\nVersion: ${version}\n` +
      `Summary: Provided by ${SWAP_ORT_PACKAGES.join('/')} (same namespace, same API).\n`,
  );
  writeFileSync(join(dir, 'INSTALLER'), `${MARKER_INSTALLER}\n`);
  writeFileSync(join(dir, 'RECORD'), ''); // MUST stay empty — see the spec's Spike 2
}

/** Delete the marker if (and only if) we wrote it. Returns whether it removed one. */
export function deleteOrtMarkerIfOurs(sitePackages) {
  let removed = false;
  for (const dir of ortDistInfoDirs(sitePackages)) {
    if (!isOurMarker(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/ort-marker-io.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-check the safety-critical assertions**

One at a time, revert after each:
1. In `isOurMarker`, drop the `RECORD` check (`return true` after the INSTALLER match) → the non-empty-RECORD test must fail.
2. In `isOurMarker`, drop the INSTALLER check → "REFUSES the real plain distribution" and "REFUSES to delete the real plain distribution" must both fail.
3. In `findPlainOrtDistInfos`, return only `[dirs[0]]` filtered → the every-match test must fail.

If any mutation leaves the suite green, the test is not testing what it claims.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-marker-io.test.ts
git commit -m "feat(side): add ORT marker write, identity and guarded delete

Identity is INSTALLER + empty RECORD, never the directory name — the real
plain onnxruntime distribution has a byte-identical name.

Refs #2192"
```

---

### Task 3: Namespace ownership detection

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs`
- Test: `server/src/tts/ort-owner-detect.test.ts`

**Interfaces:**
- Consumes: `SWAP_ORT_PACKAGES` (Task 1).
- Produces: `detectOrtOwner(sitePackages: string): 'swap' | 'plain' | 'none'`.

Ownership comes from `onnxruntime/capi/build_and_package_info.py`, whose first line is
`package_name = 'onnxruntime-gpu'` on a GPU wheel (verified on the live dev venv). **Never**
from `get_available_providers()`: `__version__` is identical across builds, and a GPU install
whose CUDA DLLs fail to load reports CPU providers — which would delete a correct marker on
every boot.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/ort-owner-detect.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectOrtOwner } from '../../tts-sidecar/scripts/install-ort.mjs';

function venvWith(info: string | null, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'sp-'));
  const capi = join(root, 'onnxruntime', 'capi');
  mkdirSync(capi, { recursive: true });
  if (info !== null) writeFileSync(join(capi, 'build_and_package_info.py'), info);
  for (const f of extra) writeFileSync(join(capi, f), 'x');
  return root;
}

describe('detectOrtOwner', () => {
  it('reads the GPU wheel as a swap distribution', () => {
    const root = venvWith("package_name = 'onnxruntime-gpu'\n__version__ = '1.27.0'\n");
    expect(detectOrtOwner(root)).toBe('swap');
  });

  it('reads the CPU wheel as plain', () => {
    const root = venvWith("package_name = 'onnxruntime'\n__version__ = '1.28.0'\n");
    expect(detectOrtOwner(root)).toBe('plain');
  });

  it('falls back to the CUDA provider DLL when the info file is missing', () => {
    const root = venvWith(null, ['onnxruntime_providers_cuda.dll']);
    expect(detectOrtOwner(root)).toBe('swap');
  });

  it('reports plain when neither signal says GPU but the namespace exists', () => {
    const root = venvWith(null, ['_pybind_state.pyd']);
    expect(detectOrtOwner(root)).toBe('plain');
  });

  it('reports none for an ABSENT namespace — the interrupted-swap state', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    expect(detectOrtOwner(root)).toBe('none');
  });

  it('reports none for a gutted namespace (dir exists, capi empty)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    mkdirSync(join(root, 'onnxruntime', 'capi'), { recursive: true });
    expect(detectOrtOwner(root)).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ort-owner-detect.test.ts`
Expected: FAIL — `detectOrtOwner is not exported`.

- [ ] **Step 3: Write minimal implementation**

```js
/** Who owns site-packages/onnxruntime/ — decided from FILES the wheel ships.
 *  'swap'  → a swap distribution (onnxruntime-gpu / -directml)
 *  'plain' → the CPU build
 *  'none'  → absent or gutted (nothing importable)
 *  NEVER uses import/get_available_providers(): __version__ is identical across
 *  builds, and a GPU install with unloadable CUDA DLLs reports CPU providers. */
export function detectOrtOwner(sitePackages) {
  const capi = join(sitePackages, 'onnxruntime', 'capi');
  if (!existsSync(capi)) return 'none';
  let entries;
  try {
    entries = readdirSync(capi);
  } catch {
    return 'none';
  }
  if (entries.length === 0) return 'none';

  const infoPath = join(capi, 'build_and_package_info.py');
  if (existsSync(infoPath)) {
    try {
      const m = readFileSync(infoPath, 'utf8').match(/package_name\s*=\s*['"]([^'"]+)['"]/);
      if (m) return SWAP_ORT_PACKAGES.includes(m[1]) ? 'swap' : 'plain';
    } catch {
      /* fall through to the DLL signal */
    }
  }
  if (entries.some((e) => /^onnxruntime_providers_(cuda|rocm)\./.test(e))) return 'swap';
  return 'plain';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/ort-owner-detect.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check**

Change the `entries.length === 0` guard to `false` → the gutted-namespace test must fail. Change `SWAP_ORT_PACKAGES.includes(m[1])` to `m[1] !== 'onnxruntime'` and confirm the GPU/CPU tests still pass but add `expect(detectOrtOwner(venvWith("package_name = 'onnxruntime-silly'"))).toBe('plain')` — it must fail under the mutation. Revert both.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-owner-detect.test.ts
git commit -m "feat(side): detect ORT namespace ownership from wheel files, not a provider probe

Refs #2192"
```

---

### Task 4: Version read + `planOrtSwap` carries the marker action

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs`
- Test: `server/src/tts/install-ort-helpers.test.ts` (extend), `server/src/tts/ort-version-read.test.ts` (new)

**Interfaces:**
- Consumes: `escapeDistName` (Task 1).
- Produces: `readInstalledOrtVersion(sitePackages: string, ortPackage: string): string | null`; `planOrtSwap` return gains `marker: { action: 'write' | 'delete' }`. The **skip** variant gains `marker` but still carries **no** `ortPackage`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/tts/ort-version-read.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInstalledOrtVersion } from '../../tts-sidecar/scripts/install-ort.mjs';

function distInfo(root: string, dirName: string, version: string) {
  const d = join(root, dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'METADATA'), `Metadata-Version: 2.1\nName: x\nVersion: ${version}\n`);
}

describe('readInstalledOrtVersion', () => {
  it('resolves the ESCAPED directory name from the bare package name', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    distInfo(root, 'onnxruntime_gpu-1.27.0.dist-info', '1.27.0');
    // The input is the bare name with a HYPHEN; the directory has an UNDERSCORE.
    expect(readInstalledOrtVersion(root, 'onnxruntime-gpu')).toBe('1.27.0');
  });

  it('returns null when absent', () => {
    expect(readInstalledOrtVersion(mkdtempSync(join(tmpdir(), 'sp-')), 'onnxruntime-gpu')).toBeNull();
  });

  it('returns null when AMBIGUOUS (a stale dist beside the current one)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    distInfo(root, 'onnxruntime_gpu-1.26.0.dist-info', '1.26.0');
    distInfo(root, 'onnxruntime_gpu-1.27.0.dist-info', '1.27.0');
    expect(readInstalledOrtVersion(root, 'onnxruntime-gpu')).toBeNull();
  });
});
```

Append to `server/src/tts/install-ort-helpers.test.ts`:

```ts
describe('planOrtSwap marker action', () => {
  it('nvidia → write', () => {
    expect(planOrtSwap('nvidia', 'win32').marker).toEqual({ action: 'write' });
  });

  it('cpu, amd and apple → delete (they are NOT GPU-swap profiles)', () => {
    for (const p of ['cpu', 'amd', 'apple']) {
      expect(planOrtSwap(p, 'win32').marker).toEqual({ action: 'delete' });
    }
  });

  it('the skip variant carries NO ortPackage — a write there would glob undefined', () => {
    expect(planOrtSwap('cpu', 'win32').ortPackage).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/tts/ort-version-read.test.ts src/tts/install-ort-helpers.test.ts`
Expected: FAIL — `readInstalledOrtVersion` undefined; `.marker` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

```js
/** Version of the installed swap distribution, read from its dist-info METADATA.
 *  null when absent OR ambiguous — the caller treats null as fatal for a swap
 *  (better a loud install failure than a marker whose version is a guess). */
export function readInstalledOrtVersion(sitePackages, ortPackage) {
  if (!existsSync(sitePackages)) return null;
  const prefix = `${escapeDistName(ortPackage)}-`;
  const hits = readdirSync(sitePackages).filter(
    (d) => d.startsWith(prefix) && d.endsWith('.dist-info'),
  );
  if (hits.length !== 1) return null;
  try {
    const meta = readFileSync(join(sitePackages, hits[0], 'METADATA'), 'utf8');
    const m = meta.match(/^Version:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
```

In `planOrtSwap`, add `marker` to both variants:

```js
  if (ortPackage === 'onnxruntime') {
    return {
      action: 'skip',
      reason: 'plain onnxruntime from the overlay is correct; no swap',
      marker: { action: 'delete' },
    };
  }
  return {
    action: 'swap',
    ortPackage,
    marker: { action: 'write' },
    steps: [ /* unchanged */ ],
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/tts/ort-version-read.test.ts src/tts/install-ort-helpers.test.ts`
Expected: PASS. The pre-existing `planOrtSwap` assertions must still pass unchanged.

- [ ] **Step 5: Mutation-check**

Change `hits.length !== 1` to `hits.length === 0` → the ambiguous test must fail. Change the skip variant's marker to `{ action: 'write' }` → the cpu/amd/apple test must fail. Revert both.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-version-read.test.ts server/src/tts/install-ort-helpers.test.ts
git commit -m "feat(side): read the installed ORT version and carry a marker action in the swap plan

Refs #2192"
```

---

### Task 5: `applyOrtMarkerWrite` / `applyOrtMarkerDelete` — the plan-driven entry points

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs`
- Test: `server/src/tts/ort-marker-apply.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `applyOrtMarkerDelete(venvDir: string, plan): void`, `applyOrtMarkerWrite(venvDir: string, plan): void` (throws when the version is unreadable).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/ort-marker-apply.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOrtMarkerWrite, applyOrtMarkerDelete, planOrtSwap, writeOrtMarker,
} from '../../tts-sidecar/scripts/install-ort.mjs';

function venv(withGpuDist = false) {
  const root = mkdtempSync(join(tmpdir(), 'venv-'));
  const sp = join(root, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  if (withGpuDist) {
    const d = join(sp, 'onnxruntime_gpu-1.27.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime-gpu\nVersion: 1.27.0\n');
  }
  return { root, sp };
}

describe('applyOrtMarkerWrite', () => {
  it('writes the marker at the INSTALLED version', () => {
    const { root, sp } = venv(true);
    applyOrtMarkerWrite(root, planOrtSwap('nvidia', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('is a NO-OP when the plan says delete — a write on cpu has no ortPackage', () => {
    const { root, sp } = venv();
    applyOrtMarkerWrite(root, planOrtSwap('cpu', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('THROWS when the version cannot be read — never writes a guessed version', () => {
    const { root } = venv(false);
    expect(() => applyOrtMarkerWrite(root, planOrtSwap('nvidia', 'win32'))).toThrow(/version/i);
  });
});

describe('applyOrtMarkerDelete', () => {
  it('removes our marker on a delete plan', () => {
    const { root, sp } = venv();
    writeOrtMarker(sp, '1.27.0');
    applyOrtMarkerDelete(root, planOrtSwap('cpu', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('also removes it on a SWAP plan — the failure path calls this before rethrowing', () => {
    const { root, sp } = venv(true);
    writeOrtMarker(sp, '1.27.0');
    applyOrtMarkerDelete(root, planOrtSwap('nvidia', 'win32'));
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('never throws on a venv with no site-packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    expect(() => applyOrtMarkerDelete(root, planOrtSwap('cpu', 'win32'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ort-marker-apply.test.ts`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

```js
/** Delete our marker. Safe on every plan and every venv shape — the failure
 *  path calls it with a SWAP plan before re-throwing. */
export function applyOrtMarkerDelete(venvDir, _plan) {
  const sp = sitePackagesDir(venvDir);
  if (!sp) return;
  deleteOrtMarkerIfOurs(sp);
}

/** Write the marker. NO-OP unless the plan says write — the skip variant has no
 *  ortPackage, so a write there would glob `undefined-*` and either resolve
 *  nothing or overwrite the REAL plain distribution. */
export function applyOrtMarkerWrite(venvDir, plan) {
  if (plan?.marker?.action !== 'write') return;
  const sp = sitePackagesDir(venvDir);
  if (!sp) throw new Error(`ORT marker: no site-packages under ${venvDir}`);
  const version = readInstalledOrtVersion(sp, plan.ortPackage);
  if (!version) {
    throw new Error(
      `ORT marker: could not read the installed ${plan.ortPackage} version (absent or ambiguous)`,
    );
  }
  writeOrtMarker(sp, version);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/ort-marker-apply.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check**

Remove the `plan?.marker?.action !== 'write'` guard → the cpu no-op test must fail. Replace the `if (!version) throw` with `writeOrtMarker(sp, version ?? '0.0.0')` → the throw test must fail. Revert both.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-marker-apply.test.ts
git commit -m "feat(side): add plan-gated marker write/delete entry points

Refs #2192"
```

---

### Task 6: `ensureOrtMarker` — the boot-time self-heal

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs`
- Test: `server/src/tts/ort-ensure-marker.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `ensureOrtMarker(venvDir: string, log?: (m: string) => void): 'wrote' | 'deleted' | 'clobbered' | 'noop'`. **Never throws.**

The five states from the spec, and the required outcome for each:

| Namespace owner | Real plain dist present? | Our marker present? | Outcome |
|---|---|---|---|
| swap | no | no | `wrote` |
| swap | no | yes | `noop` |
| swap | **yes** | either | `clobbered` — refuse, log the remedy |
| plain | — | yes | `deleted` |
| none (interrupted swap) | — | yes | `deleted` |
| none | — | no | `noop` |

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/ort-ensure-marker.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureOrtMarker, writeOrtMarker } from '../../tts-sidecar/scripts/install-ort.mjs';

function venv({ owner, realDist }: { owner: 'swap' | 'plain' | 'none'; realDist?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'venv-'));
  const sp = join(root, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  if (owner !== 'none') {
    const capi = join(sp, 'onnxruntime', 'capi');
    mkdirSync(capi, { recursive: true });
    const name = owner === 'swap' ? 'onnxruntime-gpu' : 'onnxruntime';
    writeFileSync(join(capi, 'build_and_package_info.py'), `package_name = '${name}'\n`);
  }
  if (owner === 'swap') {
    const d = join(sp, 'onnxruntime_gpu-1.27.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime-gpu\nVersion: 1.27.0\n');
  }
  if (realDist) {
    const d = join(sp, 'onnxruntime-1.28.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime\nVersion: 1.28.0\n');
    writeFileSync(join(d, 'INSTALLER'), 'pip\n');
    writeFileSync(join(d, 'RECORD'), 'onnxruntime/x,sha256=a,1\n');
  }
  return { root, sp };
}

describe('ensureOrtMarker', () => {
  it('writes a marker on a healthy GPU venv bootstrapped before this change', () => {
    const { root, sp } = venv({ owner: 'swap' });
    expect(ensureOrtMarker(root)).toBe('wrote');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('is idempotent — second run is a no-op', () => {
    const { root } = venv({ owner: 'swap' });
    ensureOrtMarker(root);
    expect(ensureOrtMarker(root)).toBe('noop');
  });

  it('REFUSES on a clobbered venv and names the remedy', () => {
    const { root, sp } = venv({ owner: 'swap', realDist: true });
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m) => lines.push(m))).toBe('clobbered');
    expect(existsSync(join(sp, 'onnxruntime-1.28.0.dist-info'))).toBe(true);
    expect(lines.join('\n')).toContain('install-ort.mjs');
  });

  it('deletes a lying marker when the CPU build owns the namespace', () => {
    const { root, sp } = venv({ owner: 'plain' });
    writeOrtMarker(sp, '1.27.0');
    expect(ensureOrtMarker(root)).toBe('deleted');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('deletes a lying marker after an INTERRUPTED SWAP — no runtime at all', () => {
    const { root, sp } = venv({ owner: 'none' });
    writeOrtMarker(sp, '1.27.0');
    expect(ensureOrtMarker(root)).toBe('deleted');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('never throws on a venv that does not exist', () => {
    const gone = join(tmpdir(), 'definitely-not-a-venv-2192');
    rmSync(gone, { recursive: true, force: true });
    expect(() => ensureOrtMarker(gone)).not.toThrow();
    expect(ensureOrtMarker(gone)).toBe('noop');
  });

  it('never creates a site-packages tree on a half-built venv', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    ensureOrtMarker(root);
    expect(existsSync(join(root, 'Lib', 'site-packages'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ort-ensure-marker.test.ts`
Expected: FAIL — `ensureOrtMarker is not exported`.

- [ ] **Step 3: Write minimal implementation**

```js
/** Boot-time self-heal for venvs bootstrapped before the marker existed.
 *  Pure fs: no pip, no network, no subprocess, no `import onnxruntime`.
 *  NEVER throws — its caller runs during server startup. */
export function ensureOrtMarker(venvDir, log = () => {}) {
  // `log` is caller-supplied (index.ts passes console.log by default, but any
  // caller can pass anything). Every call site below goes through this wrapper
  // so a THROWING log can never escape ensureOrtMarker — including from inside
  // the catch block that exists to guarantee this function never throws.
  const safeLog = (msg) => {
    try {
      log(msg);
    } catch {
      /* never let a caller-supplied log defeat the never-throws guarantee */
    }
  };
  try {
    const sp = sitePackagesDir(venvDir);
    if (!sp) return 'noop';
    const owner = detectOrtOwner(sp);
    const realPlain = findPlainOrtDistInfos(sp);

    if (owner === 'swap' && realPlain.length > 0) {
      safeLog(
        '[ort-marker] A stray real plain onnxruntime dist-info coexists with the GPU build\'s files. ' +
          'This corrupts pip\'s dependency resolution — a landmine for the next ' +
          'pip operation. The GPU build\'s files currently own the namespace, but the inconsistency must be repaired. ' +
          'Refusing to write a marker that would certify this bad state. Repair with:\n' +
          '  CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>',
      );
      return 'clobbered';
    }
    if (owner === 'swap') {
      const existing = ortMarkerVersion(sp);
      if (existing !== null) return 'noop';
      const pkg = SWAP_ORT_PACKAGES.find((p) => readInstalledOrtVersion(sp, p) !== null);
      const version = pkg ? readInstalledOrtVersion(sp, pkg) : null;
      if (!version) return 'noop';
      writeOrtMarker(sp, version);
      safeLog(`[ort-marker] recorded onnxruntime ${version} as provided by ${pkg}.`);
      return 'wrote';
    }
    // owner is 'plain' or 'none' — any marker of ours is a lie.
    if (deleteOrtMarkerIfOurs(sp)) {
      if (owner === 'none') {
        safeLog(
          '[ort-marker] No onnxruntime runtime is installed. ' +
            'The recorded swap marker has been removed. Kokoro cannot load at all in this state. ' +
            'Repair with:\n' +
            '  CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>',
        );
      } else {
        // owner === 'plain'
        safeLog(
          '[ort-marker] This venv now uses only plain onnxruntime (CPU build). The recorded swap marker ' +
            'has been removed. Kokoro will run without GPU acceleration.',
        );
      }
      return 'deleted';
    }
    return 'noop';
  } catch (err) {
    safeLog(`[ort-marker] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 'noop';
  }
}

/** Version recorded by OUR marker, or null when we have not written one. */
function ortMarkerVersion(sitePackages) {
  for (const dir of ortDistInfoDirs(sitePackages)) {
    if (!isOurMarker(dir)) continue;
    const m = /onnxruntime-(.+)\.dist-info$/.exec(dir.replace(/\\/g, '/').split('/').pop());
    if (m) return m[1];
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/ort-ensure-marker.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the two states that killed earlier revisions**

1. Remove the `realPlain.length > 0` branch → the clobbered test must fail (and note the marker would have been written over the real distribution).
2. Change the final branch to `if (owner === 'plain')` only → the interrupted-swap test must fail.
3. Remove the outer `try/catch` → the nonexistent-venv test must fail.

Revert each.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-ensure-marker.test.ts
git commit -m "feat(side): add ensureOrtMarker boot-time self-heal

Covers the clobbered and interrupted-swap venv states; refuses rather than
writing a marker over a real plain distribution.

Refs #2192"
```

---

### Task 7: Wire `bootstrap-venv.mjs`

**Files:**
- Modify: `server/tts-sidecar/scripts/bootstrap-venv.mjs`
- Test: `server/src/tts/bootstrap-venv-helpers.test.ts` (extend)

**Interfaces:**
- Consumes: `applyOrtMarkerDelete`, `applyOrtMarkerWrite` (Task 5).
- Produces: no new exports. `installForProfile` gains an injectable marker seam as its last positional parameter, defaulting to the real implementations.

Ordering, from the spec and non-negotiable:
- **delete** at `installForProfile`'s **function entry** — before the AMD torch pre-install, the AMD→CPU fallback (`cpu.txt` carries an explicit `onnxruntime` line), the nvidia torch pre-install, and both overlay installs.
- **write** as the **last statement inside** the `if (ort.action === 'swap')` block.
- **delete** again on the swap-failure path, before re-throwing.

- [ ] **Step 1: Write the failing test**

Append to `server/src/tts/bootstrap-venv-helpers.test.ts`:

```ts
describe('installForProfile ORT marker wiring', () => {
  function harness(profile: string, { failSwap = false } = {}) {
    const calls: string[] = [];
    const runPip = (args: string[]) => {
      calls.push(`pip ${args.join(' ')}`);
      if (failSwap && args[0] === 'install' && args.includes('--force-reinstall')) return false;
      return true;
    };
    const marker = {
      del: () => { calls.push('marker:delete'); },
      write: () => { calls.push('marker:write'); },
    };
    return { calls, runPip, marker, profile };
  }

  it('deletes the marker BEFORE any overlay install', () => {
    const h = harness('cpu');
    installForProfile('py', 'cpu', h.runPip, 'win32', '/venv', h.marker);
    const firstPip = h.calls.findIndex((c) => c.startsWith('pip install -r'));
    expect(h.calls.indexOf('marker:delete')).toBeLessThan(firstPip);
  });

  it('writes the marker only after a successful nvidia swap', () => {
    const h = harness('nvidia');
    installForProfile('py', 'nvidia', h.runPip, 'win32', '/venv', h.marker);
    const swapIdx = h.calls.findIndex((c) => c.includes('--force-reinstall'));
    expect(h.calls.indexOf('marker:write')).toBeGreaterThan(swapIdx);
  });

  it('never writes on cpu', () => {
    const h = harness('cpu');
    installForProfile('py', 'cpu', h.runPip, 'win32', '/venv', h.marker);
    expect(h.calls).not.toContain('marker:write');
  });

  it('deletes the marker when the swap FAILS, before rethrowing', () => {
    const h = harness('nvidia', { failSwap: true });
    expect(() => installForProfile('py', 'nvidia', h.runPip, 'win32', '/venv', h.marker)).toThrow();
    // one delete at entry, one on the failure path
    expect(h.calls.filter((c) => c === 'marker:delete')).toHaveLength(2);
    expect(h.calls).not.toContain('marker:write');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/bootstrap-venv-helpers.test.ts`
Expected: FAIL — `marker:delete` never recorded (the parameter is ignored).

- [ ] **Step 3: Write minimal implementation**

In `bootstrap-venv.mjs`, import the entry points and add the seam:

```js
import { planOrtSwap, applyOrtMarkerDelete, applyOrtMarkerWrite } from './install-ort.mjs';

const REAL_MARKER = { del: applyOrtMarkerDelete, write: applyOrtMarkerWrite };
```

Change the signature and body:

```js
function installForProfile(venvPy, profile, runPip = defaultRunPip, platform = process.platform, venvDir = null, marker = REAL_MARKER) {
  const plan = planOrtSwap(profile, platform);
  // Delete FIRST: cpu.txt carries an explicit `onnxruntime` line, and the
  // AMD->CPU fallback below installs it. A stale marker present at that moment
  // makes pip skip the real install.
  if (venvDir) marker.del(venvDir, plan);

  /* …existing torch pre-install / overlay install / AMD fallback, unchanged… */

  const ort = plan;
  if (ort.action === 'swap') {
    log(`swapping ONNX runtime → the ${profile} GPU build`);
    for (const step of ort.steps) {
      if (!runPip(step)) {
        if (venvDir) marker.del(venvDir, ort);
        throw new Error(`ONNX runtime swap failed (pip ${step.join(' ')}) for the ${profile} overlay`);
      }
    }
    if (venvDir) marker.write(venvDir, ort);
  }
  return profile;
}
```

Replace the existing `const ort = planOrtSwap(profile, platform);` line with the hoisted `plan` above — one plan, computed once, used by both halves.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/bootstrap-venv-helpers.test.ts`
Expected: PASS — new tests plus all pre-existing ones.

- [ ] **Step 5: Mutation-check**

Move the entry `marker.del` to just before the swap block → the "before any overlay install" test must fail. Remove the failure-path `marker.del` → the swap-failure test must fail. Revert both.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/bootstrap-venv.mjs server/src/tts/bootstrap-venv-helpers.test.ts
git commit -m "feat(side): apply the ORT marker from bootstrap-venv, delete-first ordering

Refs #2192"
```

---

### Task 8: Wire `upgrade/apply.ts` (with the injection seam it lacks)

**Files:**
- Modify: `server/src/upgrade/apply.ts`
- Test: `server/src/upgrade/apply-ort-marker.test.ts`

**Interfaces:**
- Consumes: `applyOrtMarkerDelete`, `applyOrtMarkerWrite` (Task 5).
- Produces: `createApplySteps` accepts an optional `deps` object `{ run?, markerDel?, markerWrite? }`. Default behaviour is unchanged.

`pipInstall`'s real body has **zero** test coverage today — `apply.test.ts` replaces the whole
member with a stub. Without this seam the apply half ships untested.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/upgrade/apply-ort-marker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createApplySteps } from './apply.js';

function harness(profile: 'nvidia' | 'cpu') {
  const calls: string[] = [];
  process.env.ACCELERATOR = profile;
  const deps = {
    run: vi.fn(async (_py: string, args: string[]) => { calls.push(`pip ${args.join(' ')}`); }),
    markerDel: vi.fn(() => { calls.push('marker:delete'); }),
    markerWrite: vi.fn(() => { calls.push('marker:write'); }),
  };
  const steps = createApplySteps({ venvDir: '/venv', log: () => {} }, deps);
  return { calls, steps, deps };
}

describe('pipInstall ORT marker wiring', () => {
  it('deletes before the first pip call', async () => {
    const h = harness('cpu');
    await h.steps.pipInstall('/rel');
    expect(h.calls[0]).toBe('marker:delete');
  });

  it('writes after the swap on nvidia', async () => {
    const h = harness('nvidia');
    await h.steps.pipInstall('/rel');
    expect(h.calls[h.calls.length - 1]).toBe('marker:write');
  });

  it('never writes on cpu', async () => {
    const h = harness('cpu');
    await h.steps.pipInstall('/rel');
    expect(h.calls).not.toContain('marker:write');
  });

  it('deletes and does not write when a swap step throws', async () => {
    const h = harness('nvidia');
    h.deps.run.mockImplementation(async (_py: string, args: string[]) => {
      h.calls.push(`pip ${args.join(' ')}`);
      if (args.includes('--force-reinstall')) throw new Error('boom');
    });
    await expect(h.steps.pipInstall('/rel')).rejects.toThrow('boom');
    expect(h.calls.filter((c) => c === 'marker:delete')).toHaveLength(2);
    expect(h.calls).not.toContain('marker:write');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/upgrade/apply-ort-marker.test.ts`
Expected: FAIL — `createApplySteps` takes one argument; `deps` ignored.

- [ ] **Step 3: Write minimal implementation**

```ts
import { applyOrtMarkerDelete, applyOrtMarkerWrite } from '../../tts-sidecar/scripts/install-ort.mjs';

export interface ApplyStepDeps {
  run?: (py: string, args: string[], cwd: string) => Promise<void>;
  markerDel?: (venvDir: string, plan: unknown) => void;
  markerWrite?: (venvDir: string, plan: unknown) => void;
}

export function createApplySteps(opts: CreateApplyStepsOpts, deps: ApplyStepDeps = {}): ApplySteps {
  const runFn = deps.run ?? run;
  const markerDel = deps.markerDel ?? applyOrtMarkerDelete;
  const markerWrite = deps.markerWrite ?? applyOrtMarkerWrite;
  // …
    pipInstall: async (releaseDir) => {
      const profile = effectiveProfile();
      const sidecar = join(releaseDir, 'server', 'tts-sidecar');
      const plan = planOrtSwap(profile, process.platform);
      markerDel(venvDir, plan);                       // BEFORE the first pip call

      const torch = planTorchPreinstall(profile, process.platform);
      if (torch.action === 'install') {
        await runFn(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', ...torch.wheels], releaseDir);
      }
      await runFn(venvPython, ['-m', 'pip', 'install', '-r', join(sidecar, 'requirements', overlayFileForProfile(profile))], releaseDir);

      if (plan.action === 'swap') {
        try {
          for (const step of plan.steps) await runFn(venvPython, ['-m', 'pip', ...step], releaseDir);
        } catch (err) {
          markerDel(venvDir, plan);
          throw err;
        }
        markerWrite(venvDir, plan);                   // LAST statement of pipInstall
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/upgrade/`
Expected: PASS — new file plus the pre-existing `apply.test.ts`.

- [ ] **Step 5: Mutation-check**

Move `markerDel` to after the overlay install → the "deletes before the first pip call" test must fail. Remove the `catch` → the throw test must fail. Revert both.

- [ ] **Step 6: Commit**

```bash
git add server/src/upgrade/apply.ts server/src/upgrade/apply-ort-marker.test.ts
git commit -m "feat(server): apply the ORT marker on the upgrade path, with an injectable seam

createApplySteps had no seam, so pipInstall's body was untested.

Refs #2192"
```

---

### Task 9: Wire the `install-ort.mjs` CLI and server boot

**Files:**
- Modify: `server/tts-sidecar/scripts/install-ort.mjs` (CLI block), `server/src/index.ts`, `server/src/diagnostics/venv.ts`
- Test: `server/src/tts/ort-venv-resolver.test.ts`

**Interfaces:**
- Consumes: `ensureOrtMarker` (Task 6).
- Produces: `resolveSidecarVenvDir(repoRoot: string): string` exported from `server/src/diagnostics/venv.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/ort-venv-resolver.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { resolveSidecarVenvDir, sidecarVenvPresent } from '../diagnostics/venv.js';

const saved = process.env.SIDECAR_VENV_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.SIDECAR_VENV_DIR;
  else process.env.SIDECAR_VENV_DIR = saved;
});

describe('resolveSidecarVenvDir', () => {
  it('defaults to the in-repo venv', () => {
    delete process.env.SIDECAR_VENV_DIR;
    expect(resolveSidecarVenvDir('/repo')).toBe(join('/repo', 'server', 'tts-sidecar', '.venv'));
  });

  it('honours SIDECAR_VENV_DIR (the versioned-install override)', () => {
    process.env.SIDECAR_VENV_DIR = '/opt/app/venv';
    expect(resolveSidecarVenvDir('/repo')).toBe('/opt/app/venv');
  });

  it('sidecarVenvPresent still works after the extraction', () => {
    delete process.env.SIDECAR_VENV_DIR;
    expect(typeof sidecarVenvPresent('/nope')).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ort-venv-resolver.test.ts`
Expected: FAIL — `resolveSidecarVenvDir` not exported.

- [ ] **Step 3: Write minimal implementation**

In `server/src/diagnostics/venv.ts`:

```ts
export function resolveSidecarVenvDir(repoRoot: string): string {
  return process.env.SIDECAR_VENV_DIR ?? join(repoRoot, 'server', 'tts-sidecar', '.venv');
}

export function sidecarVenvPresent(repoRoot: string): boolean {
  const base = resolveSidecarVenvDir(repoRoot);
  return existsSync(join(base, 'bin', 'python')) || existsSync(join(base, 'Scripts', 'python.exe'));
}
```

In `server/src/index.ts`, inside `main()` and **before `app.listen`** (not inside its callback, which is downstream of an `enforceSingleSidecarOwner` that can `process.exit`):

```ts
import { ensureOrtMarker } from '../tts-sidecar/scripts/install-ort.mjs';
import { resolveSidecarVenvDir } from './diagnostics/venv.js';

// #2192 — record that onnxruntime-gpu provides `onnxruntime`, so no later pip
// call clobbers the GPU runtime. Pure fs, never throws.
ensureOrtMarker(resolveSidecarVenvDir(bootRepoRoot), (m) => console.log(m));
```

In `install-ort.mjs`'s CLI block, after the swap steps succeed and on the skip branch, so the hand-run invocation #2192's workaround publishes also maintains the marker:

```js
  const venvDir = join(dirname(python), '..');
  if (plan.action === 'skip') {
    process.stdout.write(`[install-ort] skip — ${plan.reason}.\n`);
    applyOrtMarkerDelete(venvDir, plan);
    process.exit(0);
  }
  // …after the step loop…
  applyOrtMarkerWrite(venvDir, plan);
```

Note the skip branch currently returns **before** reading `argv[2]`; move the `python` read above it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/ort-venv-resolver.test.ts && npx vitest run src/diagnostics/`
Expected: PASS, and `models-status` / `tts/venv-bootstrap` callers of `sidecarVenvPresent` unaffected.

- [ ] **Step 5: Verify boot wiring by hand**

Run: `cd server && npm run dev`
Expected: server starts; on this dev box (healthy nvidia venv, no marker yet) the log shows
`[ort-marker] recorded onnxruntime 1.27.0 as provided by onnxruntime-gpu.`
Then confirm: `server/tts-sidecar/.venv/Scripts/python.exe -m pip check` → `No broken requirements found.`

**This is the first end-to-end proof the fix works.** Stop and report if it does not appear.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts server/src/diagnostics/venv.ts server/tts-sidecar/scripts/install-ort.mjs server/src/tts/ort-venv-resolver.test.ts
git commit -m "feat(server): ensure the ORT marker at boot and from the install-ort CLI

Refs #2192"
```

---

### Task 10: `install-whisper.mjs` — drop `-U`, add `-c`

**Files:**
- Modify: `server/tts-sidecar/scripts/install-whisper.mjs`
- Test: `server/src/tts/install-whisper-steps.test.ts`

**Interfaces:**
- Produces: `whisperPipInstallArgs(constraintsPath: string): string[]`.

Independent of the marker. `:96` runs `pip install -U faster-whisper` with no constraints
against a package `base.txt:45` pins to `>=1.0,<2.0`; `-U` can walk it past its own pin, and
where absent pip resolves to latest — a 2.x would install cleanly in violation.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/install-whisper-steps.test.ts
import { describe, it, expect } from 'vitest';
import { whisperPipInstallArgs } from '../../tts-sidecar/scripts/install-whisper.mjs';

describe('whisperPipInstallArgs', () => {
  it('constrains the install and does NOT pass -U', () => {
    const args = whisperPipInstallArgs('/tmp/constraints.txt');
    expect(args).toEqual(['-m', 'pip', 'install', 'faster-whisper', '-c', '/tmp/constraints.txt']);
    expect(args).not.toContain('-U');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/install-whisper-steps.test.ts`
Expected: FAIL — the module exports nothing, so the import fails.

- [ ] **Step 3: Write minimal implementation**

In `install-whisper.mjs`:

```js
import { writeSanitizedConstraintsFile } from './pip-constraints.mjs';

/** Pip args for the faster-whisper install. No -U: base.txt pins
 *  faster-whisper>=1.0,<2.0 and -U can walk it past that pin. */
export function whisperPipInstallArgs(constraintsPath) {
  return ['-m', 'pip', 'install', 'faster-whisper', '-c', constraintsPath];
}
```

Replace the call site:

```js
  step('Installing faster-whisper (pinned via base.txt)...');
  const constraints = writeSanitizedConstraintsFile(join(SIDECAR_DIR, 'requirements', 'base.txt'));
  if (run(python, whisperPipInstallArgs(constraints), env) !== 0) {
```

Update the file header (`:12-13`) and the log line so they no longer claim "pulls ctranslate2 + av" — on a bootstrapped box this step is now a no-op.

Guard the CLI so importing the module stays inert, matching `install-qwen3.mjs:434`:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/install-whisper-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Add `'-U'` back into the returned array → the test must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-whisper.mjs server/src/tts/install-whisper-steps.test.ts
git commit -m "fix(side): constrain the faster-whisper install and drop -U

-U could walk faster-whisper past base.txt's >=1.0,<2.0 pin.

Refs #2192"
```

---

### Task 11: Widen the `windowsHide` guard without breaking it

**Files:**
- Modify: `server/src/spawn-windows-hide.test.ts`
- Possibly modify: `server/tts-sidecar/scripts/ensure-python312.mjs`, `scripts/run-sidecar-tests.mjs`

**Interfaces:** none.

The guard's `EXTERNAL_FILES` is a hardcoded list. This change makes `install-ort.mjs` far more
load-bearing, and moving spawns around a hardcoded list is how it goes vacuously green.
**Keep the list as a floor and ADD a glob** — replacing it drops `launch.mjs` (repo root, and
it contains no `pip` string at all).

- [ ] **Step 1: Write the failing test**

Extend the file so `EXTERNAL_FILES` becomes `[...EXTERNAL_FILES_FLOOR, ...pipSpawners()]`, where
`pipSpawners()` globs `server/tts-sidecar/scripts/*.mjs` and `scripts/*.mjs` and keeps files
whose **comment- and string-blanked** source matches `/-m['"]?\s*,?\s*['"]pip/`.

- [ ] **Step 2: Run to see which files it newly selects**

Run: `cd server && npx vitest run src/spawn-windows-hide.test.ts`
Expected: FAIL, naming any newly-selected file that lacks `windowsHide`.

- [ ] **Step 3: Fix the offenders**

Add `windowsHide: true` to every spawn the guard now names. `scripts/run-sidecar-tests.mjs`
(`:54`, `:70`) and `server/tts-sidecar/scripts/ensure-python312.mjs` (`:49`, `:65`, `:86`) are the
expected candidates — fix them rather than excluding them; a hidden parent does not stop a
grandchild popping a console on Windows, which is the rule the guard exists to enforce.

- [ ] **Step 4: Run to verify green**

Run: `cd server && npx vitest run src/spawn-windows-hide.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check the guard still bites**

Temporarily delete `windowsHide: true` from `install-ort.mjs`'s pip spawn → the guard must
fail, naming that file. Revert. **If it stays green, the glob is not selecting the file and
the widening achieved nothing.**

- [ ] **Step 6: Commit**

```bash
git add server/src/spawn-windows-hide.test.ts server/tts-sidecar/scripts/ensure-python312.mjs scripts/run-sidecar-tests.mjs
git commit -m "test(server): widen the windowsHide guard to every pip spawner outside server/src

Refs #2192"
```

---

### Task 12: Docs, regression plan and release notes

**Files:**
- Create: `docs/features/282-ort-pip-consistency-marker.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/testing/onbox-acceptance-register.md`, `docs/testing/onbox-acceptance-register-live-view.html`
- Create: `docs/testing/ort-marker-onbox-acceptance.md`

**Interfaces:** none.

- [ ] **Step 1: Write the regression plan**

`docs/features/282-ort-pip-consistency-marker.md`, frontmatter `status: active`. Key files, the
eight venv states table, the invariants (identity = INSTALLER + empty RECORD; delete-first
ordering; write gated on the plan), and the manual acceptance walkthrough.

- [ ] **Step 2: Add the INDEX entry**

Under the sidecar area in `docs/features/INDEX.md`.

- [ ] **Step 3: Both release-notes documents**

`docs/release-notes-next.md` — technical, PR-refed. `RELEASE_NOTES.md` — one brand-voice line
in the in-progress version section, e.g. *"Installing Qwen3 or Whisper no longer disturbs your
GPU speech runtime."*

- [ ] **Step 4: On-box acceptance — all three surfaces**

Add rows to `docs/testing/onbox-acceptance-register.md` for the six acceptance cases in the
spec, create the run sheet, and hand-edit the live view. Then:

```bash
npm run check:onbox-register
```

Before publishing the live view, save the currently-live page locally and run
`npm run check:onbox-register -- --against-published <file>`.

- [ ] **Step 5: Verify**

```bash
npm run verify:fast:branch
```

- [ ] **Step 6: Commit**

```bash
git add docs/ RELEASE_NOTES.md
git commit -m "docs(docs): add plan 282, release notes and on-box rows for the ORT marker

Refs #2192"
```

---

## Self-review

**Spec coverage.** Every §Components item maps to a task: marker primitives → 1–2, ownership
→ 3, version + plan → 4, entry points → 5, self-heal → 6, `bootstrap-venv` → 7, `apply.ts`
(with the seam) → 8, CLI + boot → 9, whisper → 10, guard → 11, docs → 12. The eight venv states
are each an assertion in Task 6. The delete-first ordering is asserted in Tasks 7 and 8.

**Placeholders.** None — every code step carries real code, every test step real assertions.

**Type consistency.** `applyOrtMarkerDelete`/`applyOrtMarkerWrite` are named identically in
Tasks 5, 7, 8 and 9. `deleteOrtMarkerIfOurs` (not `deleteOrtMarker`) is used consistently from
Task 2 onward. `sitePackagesDir` takes a **venv dir**, `readInstalledOrtVersion` /
`detectOrtOwner` / `findPlainOrtDistInfos` take **site-packages** — Task 5 is the only place
that converts between them.

**Known gap, deliberate.** Task 9 Step 5 is the first end-to-end proof; Tasks 1–8 are unit-level
only. That is intentional — the alternative is mutating a real venv in the unit suite.
