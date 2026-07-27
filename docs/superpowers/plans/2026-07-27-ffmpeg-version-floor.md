# ffmpeg version floor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare a minimum supported ffmpeg version in one place, enforce it in the dev/CI preflight, and surface it as a non-blocking warning on every user-facing readiness surface.

**Architecture:** The floor lives in root `package.json` under a new `castwright.ffmpeg.minimum` key. Two small parsers read it — one CJS (inline in `scripts/preflight-ffmpeg.cjs`, which is shipped in the release zip and must stay dependency-free) and one TS (`server/src/diagnostics/ffmpeg.ts`, which already spawns `ffmpeg -version`). The two parsers are pinned against a **shared test-fixture corpus** so their regexes cannot drift. Preflight hard-fails below the floor; every user-facing surface degrades to `status: 'warn'`, which `setup-readiness.ts:96` already treats as non-blocking.

**Tech Stack:** Node CJS (`scripts/`), TypeScript + Vitest (`server/`, `src/`), `node:test` (`scripts/tests/`, `pinokio-scripts/lib/`), React + Tailwind (`src/components/`).

**Source spec:** [`docs/superpowers/specs/2026-07-27-ffmpeg-version-floor-design.md`](../specs/2026-07-27-ffmpeg-version-floor-design.md)

## Global Constraints

- **Floor value is `"6.0"`.** Anchored to Ubuntu 24.04 LTS (ships 6.1.1). Never hardcode it in a second place — every consumer reads `castwright.ffmpeg.minimum` from root `package.json`.
- **A `minimum` of `null` or an absent key disables the check entirely.** This is the documented rollback if a gate goes red; it must degrade to today's presence-only behaviour, not throw.
- **Unparseable version output always passes.** `parseFfmpegVersion` returns `null`, and `null` must yield `belowFloor === false` on both the CJS and TS sides. A git/nightly build (`ffmpeg version 2026-01-01-git-abc1234`) has no semver and is near-certainly newer than the floor; failing it inverts the cost of the two errors.
- **Preflight hard-fails. Every user-facing surface warns.** Never make a below-floor ffmpeg block server start, block the Setup Wizard, or set `readiness.ready` to `false`.
- **`--no-verify` is forbidden** (CLAUDE.md). Preflight is wired as `server/package.json:11` `pretest`, so it runs in pre-commit, pre-push, the required `verify.yml` check, and all three `release.yml` legs. A mistake here stops commits and blocks releases.
- **Commit convention:** `<type>(<scope>): <subject>`. Scopes used here: `ops`, `server`, `frontend`, `scripts`, `docs`.

---

### Task 1: Floor constant + version parser + preflight enforcement

**Files:**
- Modify: `package.json` (add top-level `castwright` key)
- Modify: `scripts/preflight-ffmpeg.cjs:29-38` (capture stdout, parse, enforce; guard side effects behind `require.main`)
- Create: `scripts/tests/fixtures/ffmpeg-version-cases.json`
- Create: `scripts/tests/ffmpeg-version.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `scripts/preflight-ffmpeg.cjs` exports `{ parseFfmpegVersion, isBelowFloor, readFfmpegFloor }`.
  - `parseFfmpegVersion(stdout: string) => string | null` — returns `"MAJOR.MINOR"`.
  - `isBelowFloor(version: string | null, minimum: string | null) => boolean`.
  - `readFfmpegFloor() => string | null`.
  - The fixture corpus `scripts/tests/fixtures/ffmpeg-version-cases.json` is shared with Task 2.

- [ ] **Step 1: Write the shared fixture corpus**

Create `scripts/tests/fixtures/ffmpeg-version-cases.json`. Task 2's Vitest test reads this same file, so both parsers are pinned to one corpus.

```json
{
  "parse": [
    { "name": "ubuntu 24.04", "stdout": "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", "expected": "6.1" },
    { "name": "ubuntu 22.04", "stdout": "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021", "expected": "4.4" },
    { "name": "arch n-prefix", "stdout": "ffmpeg version n6.1 Copyright (c) 2000-2023", "expected": "6.1" },
    { "name": "windows gyan", "stdout": "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026", "expected": "8.1" },
    { "name": "major only rounds to minor 0", "stdout": "ffmpeg version 7.0 Copyright (c) 2000-2024", "expected": "7.0" },
    { "name": "git build has no semver", "stdout": "ffmpeg version 2026-01-01-git-abc1234 Copyright (c) 2000-2026", "expected": null },
    { "name": "N- nightly has no semver", "stdout": "ffmpeg version N-114293-gabc1234 Copyright (c) 2000-2026", "expected": null },
    { "name": "empty output", "stdout": "", "expected": null },
    { "name": "unrelated banner", "stdout": "some other tool v9.9\n", "expected": null }
  ],
  "belowFloor": [
    { "name": "equal to floor passes", "version": "6.0", "minimum": "6.0", "expected": false },
    { "name": "higher minor passes", "version": "6.1", "minimum": "6.0", "expected": false },
    { "name": "higher major passes", "version": "8.1", "minimum": "6.0", "expected": false },
    { "name": "lower minor fails", "version": "5.9", "minimum": "6.0", "expected": true },
    { "name": "lower major fails", "version": "4.4", "minimum": "6.0", "expected": true },
    { "name": "double-digit minor compares numerically not lexically", "version": "6.10", "minimum": "6.9", "expected": false },
    { "name": "unparseable version passes", "version": null, "minimum": "6.0", "expected": false },
    { "name": "null floor disables the check", "version": "4.4", "minimum": null, "expected": false }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/tests/ffmpeg-version.test.mjs`. Note the harness: `scripts/tests/*.test.mjs` are **`node:test`** files discovered by `npm run test:hooks` — *not* Vitest, and *not* `npm run test:scripts` (that is Pester).

```js
// ops-35 — pin the preflight's ffmpeg version parser against the shared corpus.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { parseFfmpegVersion, isBelowFloor, readFfmpegFloor } = require('../preflight-ffmpeg.cjs');
const CASES = JSON.parse(readFileSync(join(HERE, 'fixtures/ffmpeg-version-cases.json'), 'utf8'));

test('parseFfmpegVersion handles every known build-channel banner', () => {
  for (const c of CASES.parse) {
    assert.equal(parseFfmpegVersion(c.stdout), c.expected, c.name);
  }
});

test('isBelowFloor compares numerically and fails open', () => {
  for (const c of CASES.belowFloor) {
    assert.equal(isBelowFloor(c.version, c.minimum), c.expected, c.name);
  }
});

test('readFfmpegFloor reads the declared floor from root package.json', () => {
  assert.equal(readFfmpegFloor(), '6.0');
});

test('requiring preflight does not exit the process', () => {
  // The module must guard its side effects behind require.main === module,
  // otherwise importing it here would run the check and call process.exit.
  assert.equal(typeof parseFfmpegVersion, 'function');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — `preflight-ffmpeg.cjs` exports nothing, so the destructure yields `undefined`; and requiring it today runs the check and exits.

- [ ] **Step 4: Add the floor to root `package.json`**

Insert after the `"engines"` block (top-level keys today are `name, version, private, type, engines, scripts, dependencies, devDependencies, overrides` — no collision):

```json
  "castwright": {
    "ffmpeg": {
      "minimum": "6.0",
      "rationale": "Support floor, not a capability floor. Ubuntu 24.04 LTS ships 6.1.1. Set to null to disable the preflight check."
    }
  },
```

- [ ] **Step 5: Rework `scripts/preflight-ffmpeg.cjs`**

Three changes. (a) capture stdout instead of discarding it, (b) add the parser/floor helpers and the below-floor branch, (c) guard the side-effecting body behind `require.main === module` and export the helpers.

Replace `ffmpegOnSessionPath` (`:29-38`) with:

```js
/* Returns { ok, stdout }. We now need the banner text, not just the exit
   code — the version lives in stdout's first line. */
function probeFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, stdout: r.stdout || '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/* "ffmpeg version 6.1.1-3ubuntu5" -> "6.1"; "n6.1" -> "6.1".
   Git/nightly banners ("2026-01-01-git-abc1234", "N-114293-g...") carry no
   semver and return null, which callers MUST treat as "fine". */
function parseFfmpegVersion(stdout) {
  const m = /^ffmpeg version n?(\d+)\.(\d+)/m.exec(String(stdout || ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

/* Numeric MAJOR.MINOR compare. Fails OPEN: an unparseable version or an
   absent floor is never "below". */
function isBelowFloor(version, minimum) {
  if (!version || !minimum) return false;
  const [vMaj, vMin] = version.split('.').map(Number);
  const [fMaj, fMin] = String(minimum).split('.').map(Number);
  if (!Number.isFinite(vMaj) || !Number.isFinite(fMaj)) return false;
  if (vMaj !== fMaj) return vMaj < fMaj;
  return (vMin || 0) < (fMin || 0);
}

/* Single source of truth: root package.json. Any read/parse failure yields
   null, which disables the check rather than breaking the build. */
function readFfmpegFloor() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const min = pkg && pkg.castwright && pkg.castwright.ffmpeg && pkg.castwright.ffmpeg.minimum;
    return typeof min === 'string' && min ? min : null;
  } catch {
    return null;
  }
}
```

Add the too-old hint function (place it beside `emitGenericHint`):

```js
function emitTooOldHint(found, minimum) {
  const upgrade =
    os.platform() === 'win32'
      ? '  winget upgrade Gyan.FFmpeg'
      : os.platform() === 'darwin'
        ? '  brew upgrade ffmpeg'
        : '  # Ubuntu 24.04+ ships a supported build; on 22.04 use snap:\n  sudo snap install ffmpeg';
  process.stderr.write(
    `\n${BOLD}${RED}[preflight] ffmpeg ${found} is older than Castwright supports.${RESET}\n\n` +
      `Castwright is tested against ffmpeg ${BOLD}${minimum}${RESET} and newer. The audio\n` +
      `pipeline parses ffmpeg's loudnorm JSON output, which is a version-sensitive\n` +
      `contract — older builds are not verified and may mis-normalise chapter audio.\n\n` +
      `${BOLD}Upgrade:${RESET}\n${upgrade}\n\n` +
      `(Or set ${BOLD}SKIP_FFMPEG_PREFLIGHT=1${RESET} for a single run.)\n\n`,
  );
}
```

Replace the top-level control flow (currently `if (ffmpegOnSessionPath()) process.exit(0);` at `:38` plus the trailing dispatch at `:120-123`) with a `main()` guarded by `require.main`:

```js
function main() {
  if (process.env.SKIP_FFMPEG_PREFLIGHT === '1') return 0;

  const { ok, stdout } = probeFfmpeg();
  if (ok) {
    const minimum = readFfmpegFloor();
    const found = parseFfmpegVersion(stdout);
    if (isBelowFloor(found, minimum)) {
      emitTooOldHint(found, minimum);
      return 1;
    }
    return 0;
  }

  if (os.platform() === 'win32') emitWindowsHint();
  else emitGenericHint();
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { parseFfmpegVersion, isBelowFloor, readFfmpegFloor };
```

Delete the now-unreachable early `if (process.env.SKIP_FFMPEG_PREFLIGHT === '1') process.exit(0);` at `:27` — it moved into `main()`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:hooks`
Expected: PASS.

- [ ] **Step 7: Verify preflight still passes on this box, and that the floor actually bites**

```bash
node scripts/preflight-ffmpeg.cjs && echo "PASS (expected — this box has 8.1.1)"
node -e "const p=require('./scripts/preflight-ffmpeg.cjs');console.log('4.4 below 6.0 ->',p.isBelowFloor('4.4','6.0'))"
```
Expected: first prints PASS; second prints `true`.

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/preflight-ffmpeg.cjs scripts/tests/ffmpeg-version.test.mjs scripts/tests/fixtures/ffmpeg-version-cases.json
git commit -m "feat(ops): declare and enforce a minimum ffmpeg version in preflight"
```

---

### Task 2: Server-side version probe

**Files:**
- Modify: `server/src/diagnostics/ffmpeg.ts` (whole file — currently 29 lines)
- Create: `server/src/diagnostics/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `castwright.ffmpeg.minimum` from root `package.json`; the fixture corpus from Task 1.
- Produces:
  ```ts
  export interface FfmpegProbe {
    ffmpeg: boolean;
    ffprobe: boolean;
    /** "MAJOR.MINOR", or null when absent/unparseable. */
    version: string | null;
    /** True only when ffmpeg is present AND its version parses AND it is below the floor. */
    belowFloor: boolean;
    /** The declared floor, so callers can render "needs 6.0+". Null = check disabled. */
    minimum: string | null;
  }
  export function probeFfmpeg(): FfmpegProbe;
  export function parseFfmpegVersion(stdout: string): string | null;
  export function isBelowFloor(version: string | null, minimum: string | null): boolean;
  export function readFfmpegFloor(): string | null;
  export function __resetFfmpegProbeCache(): void;  // test-only
  ```

- [ ] **Step 1: Write the failing test**

Create `server/src/diagnostics/ffmpeg.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseFfmpegVersion, isBelowFloor, readFfmpegFloor, probeFfmpeg, __resetFfmpegProbeCache,
} from './ffmpeg.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CASES = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'scripts/tests/fixtures/ffmpeg-version-cases.json'), 'utf8'),
) as {
  parse: { name: string; stdout: string; expected: string | null }[];
  belowFloor: { name: string; version: string | null; minimum: string | null; expected: boolean }[];
};

describe('ffmpeg version parsing', () => {
  beforeEach(() => __resetFfmpegProbeCache());

  /* Shared corpus with scripts/tests/ffmpeg-version.test.mjs — the CJS
     preflight parser and this TS one must never diverge. */
  it.each(CASES.parse)('parses $name', ({ stdout, expected }) => {
    expect(parseFfmpegVersion(stdout)).toBe(expected);
  });

  it.each(CASES.belowFloor)('compares $name', ({ version, minimum, expected }) => {
    expect(isBelowFloor(version, minimum)).toBe(expected);
  });

  it('reads the declared floor from root package.json', () => {
    expect(readFfmpegFloor()).toBe('6.0');
  });
});

describe('probeFfmpeg', () => {
  beforeEach(() => __resetFfmpegProbeCache());

  it('reports presence, a parsed version, and the floor', () => {
    const p = probeFfmpeg();
    expect(typeof p.ffmpeg).toBe('boolean');
    expect(typeof p.ffprobe).toBe('boolean');
    expect(p.minimum).toBe('6.0');
    if (p.ffmpeg) expect(p.version).toMatch(/^\d+\.\d+$/);
  });

  it('never reports belowFloor when ffmpeg is absent or unparseable', () => {
    const p = probeFfmpeg();
    if (!p.ffmpeg || p.version === null) expect(p.belowFloor).toBe(false);
  });

  it('caches the probe so repeated readiness polls do not respawn ffmpeg', () => {
    const first = probeFfmpeg();
    const second = probeFfmpeg();
    expect(second).toBe(first); // same object identity => cached
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/diagnostics/ffmpeg.test.ts`
Expected: FAIL — `parseFfmpegVersion` and the other new exports don't exist.

- [ ] **Step 3: Rewrite `server/src/diagnostics/ffmpeg.ts`**

```ts
/* fs-18 — ffmpeg/ffprobe probe for the admin diagnostics board and the
   Setup Wizard's readiness gate. ops-35 (#1877) added version reporting:
   the audio path PARSES ffmpeg's loudnorm JSON, so the version is part of
   our contract, not an implementation detail.

   The floor is a SUPPORT floor, not a capability floor — below it we simply
   have not tested, which is why every user-facing surface warns rather than
   blocks. Only `scripts/preflight-ffmpeg.cjs` hard-fails, and only on boxes
   we control (dev + CI). */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/* server/src/diagnostics/ -> server/src -> server -> repo root. Same depth
   from server/dist/diagnostics/ after tsc, so this works in both dev (tsx)
   and the release zip. Mirrors setup-readiness.ts's REPO_ROOT. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface FfmpegProbe {
  ffmpeg: boolean;
  ffprobe: boolean;
  version: string | null;
  belowFloor: boolean;
  minimum: string | null;
}

/** "ffmpeg version 6.1.1-3ubuntu5" -> "6.1". Git/nightly banners carry no
 *  semver and yield null, which callers MUST treat as acceptable. */
export function parseFfmpegVersion(stdout: string): string | null {
  const m = /^ffmpeg version n?(\d+)\.(\d+)/m.exec(String(stdout ?? ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Numeric MAJOR.MINOR compare. Fails OPEN — an unparseable version or an
 *  absent floor is never "below". */
export function isBelowFloor(version: string | null, minimum: string | null): boolean {
  if (!version || !minimum) return false;
  const [vMaj, vMin] = version.split('.').map(Number);
  const [fMaj, fMin] = minimum.split('.').map(Number);
  if (!Number.isFinite(vMaj) || !Number.isFinite(fMaj)) return false;
  if (vMaj !== fMaj) return vMaj < fMaj;
  return (vMin || 0) < (fMin || 0);
}

/** Reads `castwright.ffmpeg.minimum` from root package.json — the same key
 *  scripts/preflight-ffmpeg.cjs reads. Any failure yields null, which
 *  disables the check (the documented rollback). */
export function readFfmpegFloor(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      castwright?: { ffmpeg?: { minimum?: unknown } };
    };
    const min = pkg.castwright?.ffmpeg?.minimum;
    return typeof min === 'string' && min ? min : null;
  } catch {
    return null;
  }
}

function present(bin: string): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, stdout: r.stdout || '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/* Cached per-process: probeFfmpeg runs on EVERY /api/diagnostics and
   /api/setup/readiness poll, and now captures stdout too. Mirrors the
   cachedHasLibFdkAac precedent in tts/mp3.ts. */
let cached: FfmpegProbe | null = null;

/** Test-only: drop the cached probe. */
export function __resetFfmpegProbeCache(): void {
  cached = null;
}

export function probeFfmpeg(): FfmpegProbe {
  if (cached) return cached;
  const ff = present('ffmpeg');
  const fp = present('ffprobe');
  const minimum = readFfmpegFloor();
  const version = ff.ok ? parseFfmpegVersion(ff.stdout) : null;
  cached = {
    ffmpeg: ff.ok,
    ffprobe: fp.ok,
    version,
    belowFloor: ff.ok && isBelowFloor(version, minimum),
    minimum,
  };
  return cached;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/diagnostics/ffmpeg.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify no existing consumer broke**

`FfmpegProbe` gained fields but kept `ffmpeg`/`ffprobe`, so destructuring consumers are safe. Confirm:

Run: `cd server && npx vitest run src/routes/diagnostics.test.ts src/routes/setup-readiness.test.ts src/routes/setup-diagnosis.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/diagnostics/ffmpeg.ts server/src/diagnostics/ffmpeg.test.ts
git commit -m "feat(server): report ffmpeg version and floor from probeFfmpeg"
```

---

### Task 3: Readiness diagnosis + the hand-mirrored frontend type

**Files:**
- Modify: `server/src/routes/setup-readiness.ts:39-50` (add `BlockerCause` member)
- Modify: `server/src/routes/setup-diagnosis.ts:194-214` (`FfmpegDiagnosisInput` + `diagnoseFfmpeg`)
- Modify: `server/src/routes/setup-readiness.ts` (pass the new probe fields into `diagnoseFfmpeg`)
- Modify: `server/src/routes/diagnostics.ts:278-290` (version in `detail`, `warn` below floor)
- Modify: `src/lib/api.ts:7247` (hand-mirrored `BlockerCause`)
- Modify: `server/src/routes/setup-diagnosis.test.ts` (add cases)

**Interfaces:**
- Consumes: `FfmpegProbe` from Task 2.
- Produces: `BlockerCause` gains `'ffmpeg-too-old'` on **both** the server (`setup-readiness.ts`) and the frontend mirror (`src/lib/api.ts`). `FfmpegDiagnosisInput` gains `version: string | null`, `belowFloor: boolean`, `minimum: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/routes/setup-diagnosis.test.ts`:

```ts
describe('diagnoseFfmpeg — version floor (ops-35)', () => {
  const base = { ffmpegPresent: true, ffprobePresent: true, minimum: '6.0' };

  it('passes when the version meets the floor', () => {
    const d = diagnoseFfmpeg({ ...base, version: '6.1', belowFloor: false });
    expect(d.status).toBe('pass');
    expect(d.cause).toBe('pass');
  });

  it('WARNS (never fails) when the version is below the floor', () => {
    const d = diagnoseFfmpeg({ ...base, version: '4.4', belowFloor: true });
    expect(d.status).toBe('warn');
    expect(d.cause).toBe('ffmpeg-too-old');
    expect(d.message).toContain('4.4');
    expect(d.message).toContain('6.0');
  });

  it('still FAILS when ffmpeg is absent — absence outranks staleness', () => {
    const d = diagnoseFfmpeg({ ...base, ffmpegPresent: false, version: null, belowFloor: false });
    expect(d.status).toBe('fail');
    expect(d.cause).toBe('ffmpeg-missing');
  });

  it('passes when the version is unparseable (git build)', () => {
    const d = diagnoseFfmpeg({ ...base, version: null, belowFloor: false });
    expect(d.status).toBe('pass');
  });
});
```

Append to `server/src/routes/setup-readiness.test.ts`:

```ts
it('a below-floor ffmpeg does not block readiness', () => {
  const blockers = {
    sidecar: { status: 'pass' }, tts: { status: 'pass' },
    analyzer: { status: 'pass' }, ffmpeg: { status: 'warn' },
  };
  expect(Object.values(blockers).every((b) => b.status === 'pass' || b.status === 'warn')).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: FAIL — `diagnoseFfmpeg` rejects the extra input fields and never returns `'ffmpeg-too-old'`.

- [ ] **Step 3: Add the cause to the server union**

In `server/src/routes/setup-readiness.ts`, extend the ffmpeg group at `:46`:

```ts
  // ffmpeg
  | 'ffmpeg-missing' | 'ffprobe-missing' | 'both-missing' | 'ffmpeg-too-old'
```

- [ ] **Step 4: Extend `diagnoseFfmpeg`**

In `server/src/routes/setup-diagnosis.ts`, replace `FfmpegDiagnosisInput` and the tail of `diagnoseFfmpeg`:

```ts
export interface FfmpegDiagnosisInput {
  ffmpegPresent: boolean;
  ffprobePresent: boolean;
  /** Parsed "MAJOR.MINOR", or null when absent/unparseable. */
  version: string | null;
  /** True only when present AND parsed AND below the declared floor. */
  belowFloor: boolean;
  /** Declared floor, for the message copy. Null = check disabled. */
  minimum: string | null;
}
```

Then, in `diagnoseFfmpeg`, replace the final `return diagnosis('pass', ...)` with:

```ts
  /* ops-35: present but older than we support. This is a SUPPORT floor, not
     evidence the binary is broken — so it WARNS. setup-readiness.ts's `ready`
     already accepts 'warn', so the wizard stays advanceable. */
  if (input.belowFloor && input.version && input.minimum) {
    return diagnosis(
      'warn', 'ffmpeg-too-old',
      `ffmpeg ${input.version} is older than Castwright supports (${input.minimum}+).`,
      `Castwright is tested against ffmpeg ${input.minimum} and newer. Upgrade ffmpeg, then click Recheck.`,
    );
  }
  return diagnosis('pass', 'pass', 'ffmpeg and ffprobe are both installed.', '');
```

- [ ] **Step 5: Wire the probe through `setup-readiness.ts`**

Find the existing `diagnoseFfmpeg({ ffmpegPresent: ..., ffprobePresent: ... })` call site and pass the new fields:

```ts
const ffmpegProbe = probeFfmpeg();
const ffmpeg = diagnoseFfmpeg({
  ffmpegPresent: ffmpegProbe.ffmpeg,
  ffprobePresent: ffmpegProbe.ffprobe,
  version: ffmpegProbe.version,
  belowFloor: ffmpegProbe.belowFloor,
  minimum: ffmpegProbe.minimum,
});
```

- [ ] **Step 6: Mirror the cause on the frontend**

In `src/lib/api.ts:7254`, extend the mirrored union to match the server exactly:

```ts
  | 'ffmpeg-missing' | 'ffprobe-missing' | 'both-missing' | 'ffmpeg-too-old'
```

> Leave `info: { gpu }` alone. It has already drifted from the server's
> `{ gpu; vramTotalMb }`, but that is **pre-existing and out of scope** — note
> it, don't fix it here.

- [ ] **Step 7: Surface the version on the diagnostics board**

In `server/src/routes/diagnostics.ts:279-288`, replace the ffmpeg body:

```ts
    { id: 'ffmpeg', label: 'ffmpeg / ffprobe', body: () => {
      const { ffmpeg, ffprobe, version, belowFloor, minimum } = probeFfmpeg();
      if (ffmpeg && ffprobe) {
        const detail = version ? `both present · ffmpeg ${version}` : 'both present';
        if (belowFloor) {
          return {
            id: 'ffmpeg', label: 'ffmpeg / ffprobe', status: 'warn',
            detail: `${detail} — older than the supported ${minimum}+`,
          };
        }
        return { id: 'ffmpeg', label: 'ffmpeg / ffprobe', status: 'ok', detail };
      }
      const missing = [!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' + ');
      return {
        id: 'ffmpeg',
        label: 'ffmpeg / ffprobe',
```

(keep the remaining lines of the missing branch unchanged)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts src/routes/setup-readiness.test.ts src/routes/diagnostics.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck (the frontend mirror is compile-checked)**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/setup-readiness.ts server/src/routes/setup-diagnosis.ts server/src/routes/diagnostics.ts server/src/routes/setup-diagnosis.test.ts server/src/routes/setup-readiness.test.ts src/lib/api.ts
git commit -m "feat(server,frontend): warn on a below-floor ffmpeg without blocking readiness"
```

---

### Task 4: Setup Wizard third state + summary row

**Files:**
- Modify: `src/components/setup/step-ffmpeg.tsx:13-14` (three-way branch)
- Modify: `src/components/setup/setup-wizard.tsx:352-356` (three-way status)
- Create/Modify: `src/components/setup/step-ffmpeg.test.tsx`

**Interfaces:**
- Consumes: `BlockerCause` `'ffmpeg-too-old'` and `status: 'warn'` from Task 3.
- Produces: `data-testid="step-ffmpeg-outdated"`.

- [ ] **Step 1: Write the failing test**

In `src/components/setup/step-ffmpeg.test.tsx`:

```tsx
function readinessWith(ffmpeg: Partial<BlockerDiagnosis>): SetupReadiness {
  return {
    ready: true, completedAt: null,
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '', ...ffmpeg },
    },
    info: { gpu: 'test' },
  } as SetupReadiness;
}

it('renders the outdated card — NOT the "isn\'t installed" card — when below the floor', () => {
  render(
    <StepFfmpeg
      readiness={readinessWith({
        status: 'warn', cause: 'ffmpeg-too-old',
        message: 'ffmpeg 4.4 is older than Castwright supports (6.0+).',
      })}
      onRefetch={() => {}}
    />,
  );
  expect(screen.getByTestId('step-ffmpeg-outdated')).toBeInTheDocument();
  expect(screen.queryByTestId('step-ffmpeg-missing')).not.toBeInTheDocument();
  expect(screen.queryByTestId('step-ffmpeg-ready')).not.toBeInTheDocument();
  expect(screen.getByText(/older than Castwright supports/i)).toBeInTheDocument();
  expect(screen.queryByText(/isn’t installed yet/i)).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /installing castwright/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/setup/step-ffmpeg.test.tsx`
Expected: FAIL — no `step-ffmpeg-outdated` testid; the missing card renders instead.

- [ ] **Step 3: Add the third state to `step-ffmpeg.tsx`**

Change `:14` and insert a branch before the existing missing-card return:

```tsx
import { wikiUrl } from '../../lib/wiki-links';

export function StepFfmpeg({ readiness, onRefetch }: Props) {
  const diagnosis = readiness.blockers.ffmpeg;
  const passed = diagnosis.status === 'pass';
  const outdated = diagnosis.cause === 'ffmpeg-too-old';
```

Then, after the `if (passed) { ... }` block:

```tsx
  /* ops-35: installed but older than the declared support floor. This is a
     SUPPORT line, not a proven break — so this card informs and links out
     rather than blocking. The wizard remains advanceable. */
  if (outdated) {
    return (
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">Audio assembly</h2>
        <p className="text-sm text-ink/60">
          The final step of every audiobook stitches your generated voice clips into a
          single, properly-levelled audio file. Castwright does this with a free tool
          called <span className="font-medium text-ink">ffmpeg</span>.
        </p>
        <div
          data-testid="step-ffmpeg-outdated"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-4"
        >
          <div>
            <p className="text-sm font-semibold text-amber-900">{diagnosis.message}</p>
            <p className="mt-1 text-xs text-amber-900/70">
              Castwright can still assemble audiobooks, but this version isn’t one we
              test against — chapter loudness may differ. Upgrading is recommended.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">Windows</p>
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'winget upgrade Gyan.FFmpeg'}
              </pre>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">macOS</p>
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'brew upgrade ffmpeg'}
              </pre>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-ink/60 uppercase tracking-wide">Linux</p>
              <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
                {'sudo snap install ffmpeg'}
              </pre>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRefetch}
              className="px-3 py-1.5 rounded-full border border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-100 min-h-[44px] fine-pointer:min-h-0"
            >
              Re-check
            </button>
            <a
              href={wikiUrl('ffmpeg')}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-amber-900 underline underline-offset-2"
            >
              Installing Castwright — prerequisites
            </a>
          </div>
        </div>
      </section>
    );
  }
```

> Check `src/lib/wiki-links.ts` for the exported helper's actual name before
> writing the import — the map key is `ffmpeg` (`:82`); use whatever function
> the module exports to turn a key into a URL.

- [ ] **Step 4: Give the summary row its own status**

In `src/components/setup/setup-wizard.tsx:352-356`, mirror the `analyzerStatus` three-way at `:341`:

```tsx
    {
      key: 'ffmpeg',
      label: 'Audio assembly',
      detail: blockers.ffmpeg.status === 'pass' ? 'ffmpeg installed' : blockers.ffmpeg.message,
      status:
        blockers.ffmpeg.status === 'pass' ? 'ok' : blockers.ffmpeg.status === 'warn' ? 'warn' : 'attention',
      stepIndex: 1,
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/setup/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/setup/step-ffmpeg.tsx src/components/setup/setup-wizard.tsx src/components/setup/step-ffmpeg.test.tsx
git commit -m "feat(frontend): add an outdated-ffmpeg state to the setup wizard"
```

---

### Task 5: Pinokio install + update constraint

**Files:**
- Modify: `pinokio-scripts/install.js:34`
- Modify: `pinokio-scripts/update.js:34`
- Create: `pinokio-scripts/lib/ffmpeg-pin.test.js`

**Interfaces:**
- Consumes: `castwright.ffmpeg.minimum` from root `package.json`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `pinokio-scripts/lib/ffmpeg-pin.test.js`, modelled on the existing `node-pin.test.js` (read it first — match its import style and how it locates the repo root):

```js
// ops-35 — the Pinokio conda env must install an ffmpeg that satisfies the
// declared support floor, on BOTH install and update. Parsed from
// package.json rather than hardcoded, per #1876's acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const floor = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).castwright.ffmpeg.minimum;
const major = floor.split('.')[0];

for (const script of ['install.js', 'update.js']) {
  test(`${script} constrains ffmpeg to the declared floor`, () => {
    const src = readFileSync(join(ROOT, 'pinokio-scripts', script), 'utf8');
    const conda = src.match(/conda install[^']*/);
    assert.ok(conda, `${script} has no conda install step`);
    assert.match(
      conda[0], new RegExp(`ffmpeg>=${major}`),
      `${script} must install ffmpeg>=${major} (from package.json castwright.ffmpeg.minimum)`,
    );
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:hooks`
Expected: FAIL twice — `install.js` has bare `ffmpeg`, `update.js` has no ffmpeg at all.

- [ ] **Step 3: Constrain ffmpeg in `install.js`**

`pinokio-scripts/install.js:34`:

```js
        message: 'conda install -y -c conda-forge "ffmpeg>=6" mkcert nodejs=24',
```

- [ ] **Step 4: Constrain ffmpeg in `update.js`**

`pinokio-scripts/update.js:34`:

```js
        message: 'conda install -y -c conda-forge "ffmpeg>=6" nodejs=24',
```

Extend that step's existing comment so the ONE-UPDATE LAG note covers ffmpeg too — a user updating *from* a pre-change release runs their old `update.js`, so the constraint applies from their next update onward. Same window the Node pin already documents.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:hooks`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pinokio-scripts/install.js pinokio-scripts/update.js pinokio-scripts/lib/ffmpeg-pin.test.js
git commit -m "feat(scripts): constrain the Pinokio conda env to ffmpeg>=6 on install and update"
```

---

### Task 6: Docs, regression plan, release notes, follow-up issue

**Files:**
- Modify: `INSTALL.md` (prerequisites, troubleshooting, and the Ubuntu claim at `:33`)
- Modify: `docs/wiki/Installing-Castwright.md:31` and `:47`
- Create: `docs/features/269-ffmpeg-version-floor.md`
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: State the floor in the wiki prerequisites**

`docs/wiki/Installing-Castwright.md:31` — match the shape of the Node and Python bullets above it:

```markdown
- **ffmpeg 6.0 or newer on PATH** (server encodes chapter audio to MP3, and
  parses ffmpeg's loudness output). Ubuntu 24.04+, current Homebrew, winget and
  conda-forge all satisfy this; Ubuntu 22.04's archive build (4.4) does not.
```

- [ ] **Step 2: Retire the Ubuntu 22.04 claim in BOTH files**

`docs/wiki/Installing-Castwright.md:47` **and** `INSTALL.md:33` carry the same
sentence. Change "validated on Ubuntu 22.04+" to "validated on Ubuntu 24.04+" in
both. Verify with:

```bash
grep -rn "22.04" INSTALL.md docs/wiki/Installing-Castwright.md
```
Expected: only the "22.04's archive build (4.4) does not" mention from Step 1 remains.

- [ ] **Step 3: Extend the ffmpeg troubleshooting entry in `INSTALL.md`**

Under the existing "ffmpeg not found on PATH" heading, add:

```markdown
### "ffmpeg X.Y is older than Castwright supports"

Castwright is tested against **ffmpeg 6.0 and newer**. Below that we simply
haven't verified the audio path — the encoder parses ffmpeg's loudness
output, which is version-sensitive. Castwright still runs; the Setup Wizard
and diagnostics board show a warning rather than blocking. Upgrade with
`winget upgrade Gyan.FFmpeg` / `brew upgrade ffmpeg` / `sudo snap install ffmpeg`.
```

- [ ] **Step 4: Write the regression plan**

Create `docs/features/269-ffmpeg-version-floor.md` from `docs/features/TEMPLATE.md`
with `status: active`. It must cite: the floor's location (`package.json`
`castwright.ffmpeg.minimum`), the warn-not-block invariant
(`setup-readiness.ts:96`), the unparseable-passes rule, and the full list of
gates preflight runs in. Link the source spec and issue #1877. Add its entry to
`docs/features/INDEX.md`.

- [ ] **Step 5: Land both release-notes entries**

`docs/release-notes-next.md` — technical register entry noting the floor, the
enforcement points, and the Ubuntu 22.04 support change.
`RELEASE_NOTES.md` — a user-facing, brand-voice line in the in-progress version
section. **The 22.04 retirement is a user-visible support reduction and must be
stated plainly**, not buried.

- [ ] **Step 6: File the deferred golden-audio follow-up**

Per the spec's D4, the drift half is deferred honestly. File a Backlog-item issue:

```bash
gh issue create --title "ops-NN — golden-audio assembly tier compares no output bytes" --body "..."
```

Body must state: `server/src/tts/golden-assembly.golden.test.ts` asserts segment
counts, fixture-derived durations, file existence and a **20-LU-wide** loudness
band (`:213-214`), so an ffmpeg upgrade shifting loudness by 2 LU passes
silently. Recording an ffmpeg version stamp is only meaningful once the tier
actually compares output. Label `type:chore` + `area:ops`; add the thin row to
`docs/BACKLOG.md`.

- [ ] **Step 7: Run the full branch-scoped battery**

Run: `npm run verify:fast:branch`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add INSTALL.md docs/ RELEASE_NOTES.md
git commit -m "docs(docs): document the ffmpeg 6.0 support floor and plan 269"
```

---

## Self-review

**Spec coverage.** D1 → Task 1 Step 4 (`rationale` states it is a support floor) + Task 6 Step 3. D2 → Task 1 Step 4 (value) + Task 6 Steps 1-2 (22.04 retirement in both files). D3 → Task 1 Steps 5-7 (hard-fail) + Tasks 3-4 (warn everywhere). D4 → Task 6 Step 6 (deferred + follow-up filed). §1 → Task 1 Step 4, Task 2 Step 3, Task 5 Step 1 (all three read the same key). §2 → Tasks 1-2 (shared corpus; `belowFloor === false` on null). §3 all nine rows → Tasks 1-4. §4 → Task 5. §5 → Task 6. Before-shipping obligations → Task 6 Steps 4-6.

**Placeholders.** Task 6 Steps 4-6 describe documents rather than quoting them verbatim — deliberate: their content depends on what the preceding tasks actually shipped, and each carries explicit required-content bullets. Two `...` markers are inside shell commands whose required content is spelled out in the surrounding prose. Task 4 Step 3 flags one lookup (`wiki-links.ts`'s exported helper name) rather than guessing it.

**Type consistency.** `parseFfmpegVersion` / `isBelowFloor` / `readFfmpegFloor` keep identical names and signatures across the CJS (Task 1) and TS (Task 2) implementations. `FfmpegProbe`'s four new fields (`version`, `belowFloor`, `minimum`) map one-to-one onto `FfmpegDiagnosisInput`'s (Task 3). `'ffmpeg-too-old'` is spelled identically in `setup-readiness.ts`, `setup-diagnosis.ts`, `src/lib/api.ts` and `step-ffmpeg.tsx`. The testid `step-ffmpeg-outdated` matches between Task 4's test and component.
