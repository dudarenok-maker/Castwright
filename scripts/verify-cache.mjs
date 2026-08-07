#!/usr/bin/env node
// Verify-cache runner — replaces the &&-chain in `npm run verify`. Each step
// computes a SHA-256 of its inputs (filtered from `git ls-files`) + lockfile
// hashes + an optional tool fingerprint; matches against `.verify-cache.json`
// to skip steps whose inputs haven't changed since the last green run. See
// docs/features/archive/50-verify-cache.md for the design.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lowConcurrency } from './test-concurrency.mjs';
import { resolveVenvPython } from './run-sidecar-tests.mjs';
import { scrubGitEnv } from './git-env.mjs';

const SCHEMA_VERSION = 1;
const CACHE_FILENAME = '.verify-cache.json';

// Pipeline ordering — preserve today's `verify` chain exactly.
// Reorder with care; the same order is what shows up in the runner output.
export const STEPS = [
  {
    name: 'lint',
    inputs: {
      globs: ['**/*.{ts,tsx,js,jsx,cjs,mjs}'],
      extraFiles: ['eslint.config.mjs', '.prettierrc', '.prettierignore'],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'typecheck',
    inputs: {
      globs: ['src/**', 'server/src/**'],
      /* server/package.json (bare, NOT the lockfile): stepTouchedByDiff's
         includeLockfiles branch below only special-cases the literal
         server/package-lock.json path, so a manual server dependency/types
         edit that hasn't been `npm install`-ed into the lockfile yet
         invalidated NOTHING here (verified against the live module: it
         touched zero steps) — a real local-cache + CI-scope hole, since a
         new/removed server dependency's types can change `tsc`'s output.
         Added as an explicit extraFiles entry (not a stepTouchedByDiff
         lockfile-branch extension) to avoid also making this step hash the
         FULL server lockfile the way `includeLockfiles: ['server']` would. */
      extraFiles: [
        'tsconfig.json',
        'server/tsconfig.json',
        'vite.config.ts',
        'vitest.config.ts',
        'server/package.json',
      ],
      includeLockfiles: ['root', 'server'],
    },
  },
  {
    /* Drift guard: fails if server/.env.example is out of sync with the
       config registry. Cheap — just renders the block and diffs. Placed
       before tests so a divergent registry is caught early. */
    name: 'config:check',
    inputs: {
      globs: ['server/src/config/*.ts'],
      // server/package.json: same gap/fix as `typecheck` above — see that
      // step's comment. Least certain of the five: config:check's own
      // pass/fail doesn't read package.json content, but it's a
      // server-tagged step per the branch owner's explicit ruling.
      extraFiles: [
        'server/.env.example',
        'server/scripts/sync-env-example.ts',
        'server/package.json',
      ],
      includeLockfiles: [],
    },
  },
  {
    name: 'test:hooks',
    inputs: {
      /* fixtures/** is an input because ffmpeg-version.test.mjs drives its
         cases from scripts/tests/fixtures/ffmpeg-version-cases.json at RUNTIME
         — no module-graph edge, so without this a fixture-only diff (the
         intended way to add a drift case) would skip the very test it adds.
         Same #1847 trap test:pinokio's comment below documents. */
      globs: [
        'scripts/**/*.{mjs,cjs}',
        'scripts/tests/fixtures/**',
        /* .github/workflows/** is an input because this step's own tests
           (verify-cache.test.mjs) assert stepTouchedByDiff against real
           workflow paths, so a workflow-only diff must stay in scope for the
           step that exercises those assertions. Without this, a
           workflow-only diff — precisely the edit that breaks the wiring —
           prints [cached] and the assertion sits stale-green. Same #1847
           trap as fixtures/** above (defect D, #2119 review). */
        '.github/workflows/**',
        /* .github/actions/** is now ALSO a `computeShared` member (ops-21,
           #2152, resolving the "open question" #2146 left here) — the
           composite setup action needs every leg able to catch a soft
           failure in it, not just this one. The glob stays here too, and
           deliberately: `shared` only widens the pre-commit/pre-push scope
           filter — the `scopeShared` guard at the head of `runPipeline`'s
           per-step loop (cited by name, not line, because a bare line
           number is exactly what staled here last time — don't "helpfully"
           add one back); the input-hash cache below that filter runs per
           step regardless of scope. With no step's glob matching, a LOCAL
           actions-only diff would move no step's input hash, so every step
           would print [cached] and the run would gate nothing — `shared`
           alone would quietly re-open the exact hole this glob was added to
           close. Do NOT delete this glob because "shared covers it" — shared
           covers CI; this glob is what makes the local cache notice the
           diff. It is now ALSO scripts/tests/setup-action.test.mjs's input:
           that test `readFileSync`s .github/actions/setup/action.yml at
           RUNTIME, not via a module-graph edge, so without this glob an
           actions-only diff would leave that test stale-green on the very
           file it exists to check — same #1847 trap as fixtures/** above. */
        '.github/actions/**',
        /* .husky/** is covered TODAY only by verify.yml's `hooks` bash
           matcher, which A2 deletes — and it is an input to no step, so
           without this a .husky-only PR would run zero legs after A2.
           release-manifest.test.mjs's sample-path array includes
           .husky/pre-commit as a literal string fed to a pure classifier —
           it does not read the file from disk (plan review round 2 named
           the wrong file/mechanism; M1, #2146 review). */
        '.husky/**',
      ],
      /* preflight-ffmpeg.cjs is an input because ffmpeg-version.test.mjs
         requires it — a diff that breaks the parser must run its own test.
         RELEASE_NOTES.md / docs/release-notes-next.md / release-notes-gate.mjs
         are inputs because release-notes-gate.test.mjs asserts the mojibake
         gate against those real committed files at RUNTIME (#1956) — same
         #1847 trap as fixtures/** above: without them, a notes-only diff
         (exactly the shape that would reintroduce the corruption) never
         busts this step's input hash and the assertion sits stale-green.
         bump-version.mjs is the same trap (PR #2007 review, Minor 9):
         bump-version.test.mjs reads it as TEXT at RUNTIME (mirrors it into a
         throwaway repo, see `setupRepo`), not via a module-graph edge, so a
         bump-version.mjs-only diff would otherwise leave this step
         stale-green locally (CI is unaffected: verify.yml's `^scripts/`
         match already covers it).
         check-onbox-register.mjs and the two on-box register files are the
         same trap once more: check-onbox-register.test.mjs imports the first
         and reads the other two as TEXT at RUNTIME, asserting the live view
         still agrees with the markdown. Without them here, a register-only
         diff — precisely the edit that drifts the two apart — prints
         [cached] and the cross-check sits stale-green. */
      extraFiles: [
        'scripts/validate-commit-msg.mjs',
        'scripts/preflight-ffmpeg.cjs',
        'RELEASE_NOTES.md',
        'docs/release-notes-next.md',
        'scripts/release-notes-gate.mjs',
        'scripts/bump-version.mjs',
        'scripts/check-onbox-register.mjs',
        'docs/testing/onbox-acceptance-register.md',
        'docs/testing/onbox-acceptance-register-live-view.html',
        // launch.mjs lives at the repo root, outside scripts/**, so the
        // widened glob above doesn't reach it — launch.test.mjs imports it
        // directly (ops-18, #2115).
        'launch.mjs',
        // install-qwen3.mjs lives under server/tts-sidecar/scripts/, outside
        // scripts/**; the sidecar step's own globs only cover **/*.py +
        // requirements*.txt, so nothing else picks this up either.
        // install-qwen3-base17.test.mjs and install-qwen3-flash-attn.test.mjs
        // both import it (ops-18, #2115).
        'server/tts-sidecar/scripts/install-qwen3.mjs',
        // pip-constraints.mjs is a DIRECT import of install-qwen3.mjs itself
        // (which this PR hand-added above) — install-qwen3.test.mjs's two
        // dependents (install-qwen3-base17.test.mjs,
        // install-qwen3-flash-attn.test.mjs) reach it transitively via that
        // edge. No dedicated test imports it directly, so without this entry
        // a pip-constraints.mjs-only diff prints [cached] and both tests sit
        // stale-green (ops-17c review, #2115).
        'server/tts-sidecar/scripts/pip-constraints.mjs',
        // pinokio.js sits at the repo root, outside scripts/**, so the
        // widened glob above doesn't reach it — pinokio-entry.test.mjs loads
        // it via createRequire + require('../../pinokio.js') (reproducing
        // Pinokio's own CJS kernel loader), which is a genuine direct import
        // edge the guard's `require()`-blind regex previously missed
        // (ops-17c review, #2115).
        'pinokio.js',
        // eslint.config.mjs is a RUNTIME/subprocess dependency, not a module
        // import: eslint-guardrail.test.mjs spawns `npx eslint` against this
        // real file to prove a planted violation is rejected. No
        // module-graph edge exists, so without this entry an
        // eslint.config.mjs-only diff (e.g. deleting the guarded rule)
        // prints [cached] here — only the separate `lint` step re-runs,
        // which proves nothing about the guardrail test itself
        // (ops-17c review, #2115).
        'eslint.config.mjs',
        // menu.js is a TRANSITIVE dep: pinokio-entry.test.mjs asserts on the
        // menu() item list, which is implemented here and reached via
        // pinokio.js. Editing it used to leave test:hooks [cached] locally,
        // while in cloud it set pinokio=true — running test:pinokio, a
        // DIFFERENT suite from the test that asserts on it (#2120a).
        'pinokio-scripts/lib/menu.js',
        // schemas.ts is reached from diff-analysis-ab.mjs, which imports it
        // with a .js specifier per the TypeScript convention.
        'server/src/handoff/schemas.ts',
        // #2012: knob-docs-sync.test.mjs reads BOTH of these as TEXT at
        // RUNTIME (regex extraction, not a module-graph edge) to assert every
        // registry.ts KNOBS[].label has a matching Advanced-Settings.md table
        // row. Without them here, a diff to either file alone (exactly the
        // shape that could drift the two apart) prints [cached] and the
        // guard never re-runs — same #1847 runtime-read trap as fixtures/**
        // above.
        'server/src/config/registry.ts',
        'docs/wiki/Advanced-Settings.md',
        // #2053: the SAME trap one file over (PR #2159 review, finding 3).
        // check-import-cycles.test.mjs asserts this allowlist's STRUCTURE and
        // runs under test:hooks — but the file was an input to `check:cycles`
        // only, which is cloud/full-verify-only. An allowlist-only commit
        // therefore left test:hooks [cached] locally and skipped its CI leg,
        // so the structural test never ran on the one diff shape it exists
        // to catch.
        'server/madge-cycles-allowlist.json',
      ],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'check:budget-poll',
    inputs: {
      /* Its own step rather than widening test:hooks' inputs: this scans
         server/src/**\/*.test.ts at RUNTIME, and server tests are the hottest
         surface in the repo. Folding them into test:hooks would bust a ~25s
         cache on every server test edit; as its own ~1s step it costs almost
         nothing AND it runs on a server-only staged diff, which is exactly
         the case verify:fast:scoped used to skip. */
      globs: ['server/src/**/*.test.ts'],
      extraFiles: ['scripts/check-no-budget-poll.mjs'],
    },
  },
  {
    name: 'test:pinokio',
    inputs: {
      globs: ['pinokio-scripts/**'],
      /* package.json is an input because node-pin.test.js reads `engines.node`
         at RUNTIME to check the conda `nodejs=` pin still satisfies the floor.
         Without it the input hash ignores the one file that change lives in, so
         a floor raise touching nothing under pinokio-scripts/ prints [cached]
         and the drift guard never runs — green locally on exactly the
         regression it exists to catch. (Cloud CI still fires it: verify.yml's
         `shared` scope matches root package.json. This closes the LOCAL half.)
         Same shape as the runtime-read pin that went inert under
         `vitest --changed` in #1847. */
      extraFiles: ['pinokio.js', 'scripts/run-pinokio-tests.mjs', 'package.json'],
      includeLockfiles: [],
    },
  },
  {
    name: 'test',
    inputs: {
      globs: ['src/**'],
      extraFiles: [
        'vitest.config.ts',
        'vite.config.ts',
        'index.html',
        /* api.clone-voice.test.ts pins the clone-transcript cap against the
           contract, so an openapi-only edit must bust this step's cache —
           otherwise the local run reports [cached] and the pin never fires. */
        'openapi.yaml',
      ],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'test:server',
    inputs: {
      globs: ['server/src/**'],
      /* openapi.yaml: voice-library.test.ts pins the clone-transcript cap
         against it (see the `test` step above for the same reasoning).
         ffmpeg-version-cases.json: diagnostics/ffmpeg.test.ts drives its
         parser cases from that file at runtime, sharing the corpus with the
         CJS preflight parser so the two cannot drift. Without it here, a
         fixture-only diff re-checks only the CJS side.
         repair-cast-id-drift.mjs: cast-resolve.repair-pass-contract.test.ts
         imports it directly (#2130) — it lives outside server/src/**, so
         without this line an edit there reports [cached] and the contract
         test never re-runs against it.
         server/package.json: same lockfile-vs-manifest gap as `typecheck`
         above — includeLockfiles below only special-cases the literal
         server/package-lock.json path, so a manifest-only server dependency
         edit invalidated nothing (verified against the live module). */
      extraFiles: [
        'server/vitest.config.ts',
        'server/tsconfig.json',
        'openapi.yaml',
        'scripts/tests/fixtures/ffmpeg-version-cases.json',
        'scripts/repair-cast-id-drift.mjs',
        'server/package.json',
      ],
      includeLockfiles: ['server'],
    },
  },
  {
    /* Plan 45 (vitest pool tuning) — 10 hot files (analyzer/gemini + routes test
       files) run serially in a separate vitest invocation so their
       mkdtempSync + module-import contention can't trip the main
       parallel test:server battery. Cache invalidates on the same
       inputs since the file list is wholly inside server/src/**. */
    name: 'test:server-slow',
    inputs: {
      globs: ['server/src/**'],
      // server/package.json: same gap/fix as `test:server` above.
      extraFiles: [
        'server/vitest.config.slow.ts',
        'server/vitest.config.ts',
        'server/tsconfig.json',
        'server/package.json',
      ],
      includeLockfiles: ['server'],
    },
  },
  {
    /* #2053: madge's --circular pass over server/src is not free on this
       graph, so (per the repo-owner decision recorded on the issue) it's
       cloud/full-`npm run verify`-only, same tier as test:e2e/test:server-
       slow/test:scripts/test:pinokio below — NOT one of the three local
       `--steps` CSVs in package.json. See verify-cache.test.mjs's
       CLOUD_OR_FULL_VERIFY_ONLY_STEPS allowlist, which this name must also
       be added to or that guard fails the build (#2120/#2154 shipped this
       exact trap once already). */
    name: 'check:cycles',
    inputs: {
      globs: ['server/src/**'],
      extraFiles: [
        'server/madge-cycles-allowlist.json',
        // The madge VERSION is pinned inside this script's `npx --yes
        // madge@8.0.0` spawn line rather than in server/package.json (see the
        // script header for why it is not a devDependency), so this one file
        // covers both "the guard logic changed" and "the tool version
        // changed". No server manifest/lockfile input is needed here.
        'scripts/check-import-cycles.mjs',
      ],
    },
  },
  {
    name: 'test:scripts',
    inputs: {
      globs: [
        'scripts/lib/**',
        'scripts/tests/**/*.Tests.ps1',
        'scripts/tests/**/*.ps1',
        // run-golden-tests.Tests.ps1 shadows qwen_tts/torch/TTS onto
        // PYTHONPATH via these stub .py files at RUNTIME (see that test's own
        // BeforeAll block) — no module-graph edge, so without this glob a
        // stub-only diff (exactly the shape that would need re-verifying)
        // printed [cached] here. Same #1847 runtime-read trap `test:hooks`'s
        // fixtures/** entry documents; verified by reading the test file
        // before adding this, not assumed.
        'scripts/tests/fixtures/**',
      ],
      extraFiles: ['scripts/tests/run.ps1'],
      includeLockfiles: ['root'],
    },
    toolFingerprint: pesterFingerprint,
  },
  {
    name: 'test:sidecar',
    inputs: {
      /* Widened to the WHOLE sidecar tree (matching the legacy CI regex
         `^server/tts-sidecar/`, restored after A2's derivation narrowed it to
         .py/requirements/pytest.ini only — an under-declaration: any file in
         this tree, including non-.py sources, docs, and install scripts, can
         affect the pytest suite or its bootstrap). Safe without an explicit
         exclusion for .venv/**, models/, .coqui/, voices/, or sample.* —
         verified those are the exact paths .gitignore excludes under
         server/tts-sidecar/ (root .gitignore lines 108-113), and every
         diffFiles/fileList this glob is tested against already comes from
         `git diff`/`git ls-files --exclude-standard`, which never surfaces a
         gitignored path in the first place — so there's no churn risk to
         guard against, and globToRegex has no exclusion syntax to express one
         with regardless. */
      globs: ['server/tts-sidecar/**'],
      extraFiles: [
        'server/tts-sidecar/run-tests.ps1',
        // The npm script now invokes this instead; run-tests.ps1 is retained
        // for direct local/PowerShell use, so BOTH are inputs.
        'scripts/run-sidecar-tests.mjs',
        // M3 (#2146 review): '**/*.py' misses this — it has no .py extension
        // — so a pytest.ini-only diff (e.g. changing markers or addopts)
        // printed [cached] locally with nothing to invalidate the step.
        'server/tts-sidecar/pytest.ini',
      ],
      includeLockfiles: [],
    },
    toolFingerprint: sidecarFingerprint,
  },
  {
    name: 'test:e2e',
    inputs: {
      globs: ['src/**', 'e2e/**'],
      /* index.html: same gap/fix as `build`'s extraFiles entry below — it
         carries the self-hosted webfonts <link>, the body's Tailwind
         classes, and the #root mount div, all three of which determine what
         Playwright mounts and what the visual baselines render. Without this,
         an index.html-only diff ran zero e2e shards (workflow-wiring review
         Finding 1). */
      extraFiles: ['playwright.config.ts', 'vite.config.ts', '.env.e2e', 'index.html'],
      includeLockfiles: ['root'],
    },
  },
  {
    /* Plan 37 (visual baselines) — visual baselines run in a separate serial
       step so they can't race the parallel test:e2e battery for the
       Vite dev server. Same `globs` as test:e2e so the cache invalidates
       whenever a source file or e2e spec changes. */
    name: 'test:e2e:visual',
    inputs: {
      globs: ['src/**', 'e2e/**'],
      // index.html: same reasoning as test:e2e's extraFiles entry above —
      // it directly determines what the visual baselines screenshot.
      extraFiles: ['playwright.config.ts', 'vite.config.ts', '.env.e2e', 'index.html'],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'build',
    inputs: {
      globs: ['src/**', 'server/src/**'],
      // server/package.json: same gap/fix as `typecheck`/`test:server` above.
      extraFiles: [
        'vite.config.ts',
        'tsconfig.json',
        'server/tsconfig.json',
        'index.html',
        'scripts/sync-docs-to-public.mjs',
        'server/package.json',
      ],
      includeLockfiles: ['root', 'server'],
    },
  },
];

export function parseFlags(argv) {
  let steps = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--steps') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        steps = parseStepsCsv(next);
        i += 1;
      } else {
        steps = [];
      }
    } else if (a.startsWith('--steps=')) {
      steps = parseStepsCsv(a.slice('--steps='.length));
    }
  }
  return {
    noCache: argv.includes('--no-cache'),
    steps,
    scopeStaged: argv.includes('--scope-staged'),
    scopeBranch: argv.includes('--scope-branch'),
  };
}

function parseStepsCsv(csv) {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pure decision function — no I/O. Returns 'run' | 'skip'.
export function decide({ stepName, currentHash, cache, noCache }) {
  if (noCache) return 'run';
  const entry = cache?.steps?.[stepName];
  if (!entry || typeof entry.inputHash !== 'string') return 'run';
  return entry.inputHash === currentHash ? 'skip' : 'run';
}

// SHA-256 hex of a Buffer or string.
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// SHA-256 hex of a single file's bytes. Missing file → empty marker so a
// later add/delete flips the hash naturally without throwing.
export function hashFile(absPath) {
  try {
    return sha256Hex(readFileSync(absPath));
  } catch {
    return '__missing__';
  }
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// Pre-sorted [posixPath, fileHash] entries → SHA-256 of `${path}\0${hash}\n` joined.
export function hashEntries(entries) {
  const h = createHash('sha256');
  for (const [path, hash] of entries) {
    h.update(`${path}\0${hash}\n`);
  }
  return h.digest('hex');
}

// Compose a step's input hash. Pure function; takes all dependencies as args.
export function composeInputHash({
  stepName,
  sortedFileEntries,
  lockHashes,
  nodeVer,
  schemaVer,
  toolFingerprint,
}) {
  const block = [
    stepName,
    String(schemaVer),
    nodeVer,
    toolFingerprint ?? '',
    lockHashes?.root ?? '',
    lockHashes?.server ?? '',
    hashEntries(sortedFileEntries),
  ].join('\n');
  return sha256Hex(block);
}

// Tolerant load: missing or corrupt file → empty default cache.
export function loadCache(absPath) {
  const empty = { schemaVersion: SCHEMA_VERSION, steps: {} };
  if (!existsSync(absPath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(absPath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.schemaVersion === SCHEMA_VERSION &&
      parsed.steps &&
      typeof parsed.steps === 'object'
    ) {
      return parsed;
    }
    return empty;
  } catch {
    return empty;
  }
}

// Atomic save: write `<path>.tmp` then rename. Retry once on EBUSY (Windows
// antivirus shadow). Cache is best-effort, not load-bearing — a failed save
// just means the next run won't have the latest entry.
export function saveCache(absPath, cache) {
  const tmp = `${absPath}.tmp`;
  const payload = JSON.stringify(cache, null, 2);
  writeFileSync(tmp, payload, 'utf8');
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    if (err && err.code === 'EBUSY') {
      const until = Date.now() + 60;
      while (Date.now() < until) {
        // tiny spin; <50ms total
      }
      try {
        renameSync(tmp, absPath);
      } catch {
        // give up — best-effort
      }
    }
  }
}

// Convert a glob list like `src/**` or `**/*.{ts,tsx}` into a single regex
// that matches against POSIX-normalized relative paths. Supports `**`, `*`,
// and a brace-list extension (`{ts,tsx,js}`); doesn't need to be a full
// glob implementation — our STEPS table only uses these forms.
function globToRegex(glob) {
  let i = 0;
  let out = '^';
  while (i < glob.length) {
    const c = glob[i];
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const parts = glob
        .slice(i + 1, close)
        .split(',')
        .map((s) => s.replace(/[.+^$|()[\]\\]/g, '\\$&'));
      out += `(?:${parts.join('|')})`;
      i = close + 1;
    } else if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; bare `**` matches anything
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (/[.+^$|()[\]\\]/.test(c)) {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out);
}

// Filter a flat POSIX file list against a step's globs + extraFiles. Returns
// a sorted, deduped list of POSIX-normalized relative paths.
export function selectStepFiles({ fileList, step }) {
  const regexes = (step.inputs.globs ?? []).map(globToRegex);
  const set = new Set();
  for (const f of fileList) {
    for (const re of regexes) {
      if (re.test(f)) {
        set.add(f);
        break;
      }
    }
  }
  for (const extra of step.inputs.extraFiles ?? []) {
    set.add(toPosix(extra));
  }
  return [...set].sort();
}

// --- Scope filter (pre-commit) -------------------------------------------
// Diff-driven gate that sits IN FRONT of the input-hash cache: a step whose
// scope the staged diff never touched is skipped outright, regardless of cache
// state. This closes the hole where a flaked prior run (no green entry) forces
// an out-of-scope suite to re-run. Mirrors the scope detection in
// .github/workflows/verify.yml; the STEPS `inputs.globs` ARE the scope map.

// Two things are treated as global, not just the one step whose glob happens
// to match. A root manifest/lockfile change is the first — a dep/lock bump
// can affect every leg. `.github/actions/**` is the second (ops-21, #2152):
// its composite setup action is `uses:`-ed with no `if:` in every
// verify.yml job that sets up Node, so a hard failure there already reddens
// everything regardless of routing — but a *soft* failure (setup succeeds,
// environment is wrong) needs every leg to be able to catch it, not just
// whichever one step's glob matched.
export function computeShared(diffFiles) {
  return diffFiles.some((f) => {
    const p = toPosix(f);
    return p === 'package.json' || p === 'package-lock.json' || p.startsWith('.github/actions/');
  });
}

// Does any staged diff file fall inside this step's declared scope? Reuses the
// step's own globs + extraFiles + server lockfile. Deliberately NOT
// selectStepFiles — that always injects extraFiles into its result, so it can
// never report "untouched". This needs a real membership predicate.
export function stepTouchedByDiff(step, diffFiles) {
  const regexes = (step.inputs.globs ?? []).map(globToRegex);
  for (const f of diffFiles) {
    if (regexes.some((re) => re.test(f))) return true;
  }
  const extras = new Set((step.inputs.extraFiles ?? []).map(toPosix));
  for (const f of diffFiles) {
    if (extras.has(f)) return true;
  }
  if (
    (step.inputs.includeLockfiles ?? []).includes('server') &&
    diffFiles.includes('server/package-lock.json')
  ) {
    return true;
  }
  return false;
}

// Files staged for commit. Returns POSIX paths, or null if git fails (→ caller
// disables the scope filter and runs everything; never skip on uncertainty).
// Exported (#2216) so its `GIT_INDEX_FILE` scrub can be unit-tested directly —
// see scripts/tests/verify-cache.test.mjs's "staged-set hazard" tests.
export function stagedDiffFiles(cwd) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}

// Files touched by every commit on the current branch since it diverged
// from local `main` — the right basis for a pre-push-time check, where
// "staged" is usually empty (commits already exist). Returns POSIX paths,
// or null if the underlying git commands fail (→ caller disables the scope
// filter and runs everything; never skip on uncertainty). Distinct from
// that failure case: a SUCCESSFUL merge-base+diff that finds no changed
// files (branch fully merged into main, running directly on main, or a
// commit-less branch) legitimately returns an empty array — the scope
// filter correctly skips every step for that, which is fine given
// verify.yml is now the required backstop. Exported so it can be unit-tested
// directly (as of #2216, stagedDiffFiles above is too, for the same reason).
//
// Strips the ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/
// GIT_COMMON_DIR repo-discovery vars (scrubGitEnv, scripts/git-env.mjs) plus
// GIT_PREFIX before spawning: every function in this file that calls git is
// invoked with an explicit `cwd` and must resolve git state strictly relative
// to it. Without stripping, a caller running inside an enclosing git process
// that already has these set (e.g. this very function running inside the
// pre-push hook it's part of) would have git resolve against the ENCLOSING
// process's repo instead of `cwd` — harmless when `cwd` happens to be that
// same repo (the real pre-push path), but wrong whenever `cwd` points
// elsewhere (exactly what this file's own unit tests do, and exactly the
// #2216 `GIT_INDEX_FILE` hazard: a relative index path set by an enclosing
// hook resolves against the CHILD's cwd, not the repo root, silently
// yielding an empty staged set). GIT_PREFIX is not one of scrubGitEnv's
// repo-discovery keys (it affects relative-path interpretation within an
// already-resolved repo, not which repo is resolved) but is stripped here
// too for the same cwd-pinning reason.
function gitEnv() {
  const { GIT_PREFIX: _GIT_PREFIX, ...cleanEnv } = scrubGitEnv();
  return cleanEnv;
}

export function branchDiffFiles(cwd) {
  const env = gitEnv();
  const base = spawnSync('git', ['merge-base', 'HEAD', 'main'], {
    cwd,
    encoding: 'utf8',
    env,
  });
  if (base.error || base.status !== 0) return null;
  const baseSha = base.stdout.trim();
  const r = spawnSync('git', ['diff', '--name-only', baseSha, 'HEAD'], {
    cwd,
    encoding: 'utf8',
    env,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}

// --- Contention guard ----------------------------------------------------
// A co-running GPU generation hammers CPU/disk and is the documented cause of
// "Worker exited unexpectedly" crashes and 250s+ environment-setup stalls in
// the test legs. When we detect a busy GPU we throttle test concurrency (soft —
// warn + dial down, never block).

// Utilisation-only, deliberately (#2164): VRAM occupancy does NOT count as
// contention. The failure this guard prevents is fs/tmpdir and CPU
// contention from *active* work (docs/features/archive/45-vitest-pool-tuning.md:
// tmpdir contention, AV/OneDrive interleaving, pool pressure) — a model
// parked in VRAM burns no CPU and touches no tmpdir. This box deliberately
// keeps models resident (PRELOAD_KOKORO, the button-loaded Qwen Base), so a
// residency trigger would pin LOW_CONCURRENCY=1 near-permanently while
// preventing no crash. The #2164 incident's busy card was at 91% util —
// squarely inside what max-across-GPUs already catches below. Host RAM
// pressure (that incident also had Ollama holding ~14GB of system RAM) is
// real contention neither utilisation nor VRAM occupancy measures — known
// out of scope, not implemented.
//
// Exported so run-golden-audio.mjs's own bless-time contention warning shares
// this exact value instead of redeclaring it (#2164 review finding 4) — two
// independent `= 40`s meant raising one could silently leave the other
// stale despite a comment claiming they mirror.
export const GPU_BUSY_THRESHOLD = 40; // % utilization

// Parse the first GPU's utilization (%) from nvidia-smi CSV output. Returns a
// number, or null if unparseable / no GPU line.
export function parseNvidiaSmiUtil(stdout) {
  if (!stdout) return null;
  const firstLine = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (!firstLine) return null;
  const n = Number.parseInt(firstLine.split(',')[0].trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// Max utilization (%) across EVERY GPU line in nvidia-smi CSV output — unlike
// parseNvidiaSmiUtil above, which deliberately stays a single-line parser: that
// is its documented contract (see its own doc comment; #2036 chose not to
// widen it), and this function composes over it rather than duplicating it —
// re-applying parseNvidiaSmiUtil one line at a time and taking the max. On a
// multi-GPU box the busy card is not always index 0 (#2164: this dev box is
// cuda:0 4070 8GB idle / cuda:1 5070 Ti 16GB busy) — a first-line-only read
// misses exactly the contention this guard exists to catch. Lives here (moved
// from a local copy in run-golden-audio.mjs, #2036) so both callers share one
// implementation; run-golden-audio.mjs now imports this rather than keeping
// its own. Returns the max over every parseable line, or null when none parse.
export function maxNvidiaSmiUtil(stdout) {
  if (!stdout) return null;
  const lines = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  let max = null;
  for (const line of lines) {
    const util = parseNvidiaSmiUtil(line);
    if (util !== null && (max === null || util > max)) max = util;
  }
  return max;
}

// Pure decision seam (#2164): given raw nvidia-smi stdout, decide contention.
// Split out from detectGpuContention so the decision is unit-testable without
// spawning a real nvidia-smi — mirrors how run-golden-audio.mjs already splits
// gpuBusyWarningFor out of warnIfGpuBusyForBless.
export function gpuContentionFor(stdout) {
  const util = maxNvidiaSmiUtil(stdout);
  return { busy: util !== null && util >= GPU_BUSY_THRESHOLD, util };
}

// Returns { busy, util }. nvidia-smi absent / errors → { busy:false, util:null }
// (e.g. CI ubuntu runners, non-NVIDIA boxes). Cheap (~100ms).
//
// The `--query-gpu=utilization.gpu` argument is load-bearing and must request
// ONLY that field: both parseNvidiaSmiUtil and maxNvidiaSmiUtil blindly read
// the FIRST CSV column of each line as the utilization percentage. Widening
// the query — e.g. to `index,utilization.gpu`, the richer shape #2164's own
// issue body pastes ("1, NVIDIA GeForce RTX 5070 Ti, 91 %, 15455 MiB") — would
// shift that first column to the GPU index (0/1, always under threshold) and
// silently reintroduce #2164's always-idle bug through the query string
// instead of the parser. Pinned by a source-regex test in
// scripts/tests/verify-cache.test.mjs.
function detectGpuContention() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (r.error || r.status !== 0) return { busy: false, util: null };
  return gpuContentionFor(r.stdout);
}

// Tool fingerprints — strings that change when the relevant tool's
// availability or version changes. Used to invalidate the cache when a user
// installs Pester or bootstraps the pytest venv after a previous skip.

function pesterFingerprint() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "$m = Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1; if ($m) { $m.Version.ToString() } else { 'unavailable' }",
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (r.error || r.status !== 0) return 'unavailable';
  return (r.stdout ?? '').trim() || 'unavailable';
}

// I2 (#2146 review): this used to hardcode the Windows venv layout
// (server/tts-sidecar/.venv/Scripts/python.exe), so on a POSIX box the
// fingerprint was the literal string 'unavailable' forever — bootstrapping
// the venv there never changed the fingerprint, so this step would report
// [cached] and never actually run post-bootstrap. Reuses
// run-sidecar-tests.mjs's own platform branch (resolveVenvPython) instead of
// duplicating the win32/posix ternary here. sidecarDir/platform are
// parameters (not read from process.cwd()/process.platform inline) purely so
// the test suite can pin the POSIX path without needing to run on POSIX.
export function sidecarFingerprint(
  sidecarDir = join(process.cwd(), 'server', 'tts-sidecar'),
  platform = process.platform,
) {
  const py = resolveVenvPython(sidecarDir, platform);
  if (!py) return 'unavailable';
  let mtime = '';
  try {
    mtime = String(statSync(py).mtimeMs);
  } catch {
    mtime = '0';
  }
  const r = spawnSync(py, ['-m', 'pytest', '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.error || r.status !== 0) return `present:${mtime}:no-pytest`;
  const ver = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split(/\r?\n/)[0];
  return `${mtime}:${ver}`;
}

function gitFileList(cwd) {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}

function pickLockHashes(absRoot, which) {
  const out = {};
  if (which.includes('root')) {
    out.root = hashFile(join(absRoot, 'package-lock.json'));
  }
  if (which.includes('server')) {
    out.server = hashFile(join(absRoot, 'server', 'package-lock.json'));
  }
  return out;
}

function formatSecs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Top-level orchestrator. Returns process exit code.
/* Vitest fork-pool steps that can suffer a transient WORKER crash (the process
   dies) under resource contention (busy GPU / a parallel session) — distinct
   from a red test. These warrant ONE automatic retry. See issue #848 +
   docs/features/archive/45-vitest-pool-tuning.md. */
const RETRIABLE_POOL_STEPS = new Set(['test:server', 'test:server-slow']);

/** True iff `stderr` carries a vitest fork-pool PROCESS crash signature (a worker
    died), as opposed to a normal test failure. A real test failure must NOT match
    — retrying that would mask a flaky test. */
export function isVitestPoolCrash(stderr) {
  return /Worker exited unexpectedly|Worker forks emitted error|\[vitest-pool\]/i.test(
    stderr || '',
  );
}

/** Run one pipeline step (`npm run <name>`) and return its exit code. Retriable
    pool steps stream stdout LIVE but CAPTURE stderr so a fork-pool crash can be
    detected and the step retried exactly once; every other step inherits both
    streams unchanged. */
function runStepProcess(stepName, { cwd, env }) {
  const runOnce = (capture) => {
    const r = spawnSync('npm', ['run', stepName], {
      cwd,
      shell: true,
      env,
      ...(capture
        ? { encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
        : { stdio: 'inherit' }),
    });
    const stderr = capture ? r.stderr || '' : '';
    if (stderr) process.stderr.write(stderr); // captured stderr isn't echoed live — surface it
    return { code: r.status ?? 1, stderr };
  };
  if (!RETRIABLE_POOL_STEPS.has(stepName)) return runOnce(false).code;
  let res = runOnce(true);
  if (res.code !== 0 && isVitestPoolCrash(res.stderr)) {
    console.log(
      `[retry] ${stepName} — vitest fork-pool crash ("Worker exited unexpectedly"), not a test failure; re-running once`,
    );
    res = runOnce(true);
  }
  return res.code;
}

export function runPipeline({ argv = [], cwd = process.cwd(), env = process.env } = {}) {
  const flags = parseFlags(argv);
  const validNames = STEPS.map((s) => s.name);
  let activeSteps = STEPS;
  if (flags.steps && flags.steps.length > 0) {
    const unknown = flags.steps.filter((n) => !validNames.includes(n));
    if (unknown.length > 0) {
      console.error(
        `[verify-cache] unknown step name(s): ${unknown.join(', ')}\n` +
          `[verify-cache] valid steps: ${validNames.join(', ')}`,
      );
      return 2;
    }
    const selected = new Set(flags.steps);
    activeSteps = STEPS.filter((s) => selected.has(s.name));
  }

  // Contention guard — if a generation run is hammering the GPU, throttle the
  // child test runs (soft: warn + dial down, never block). Skip the probe when
  // already throttled or explicitly disabled.
  if (!env.SKIP_CONTENTION_CHECK && !lowConcurrency(env)) {
    const { busy, util } = detectGpuContention();
    if (busy) {
      console.log(`[contention] GPU busy (~${util}% util) — a generation run may be active.`);
      console.log(
        '[contention] Throttling test concurrency (LOW_CONCURRENCY=1). Set SKIP_CONTENTION_CHECK=1 to disable.',
      );
      env.LOW_CONCURRENCY = '1';
    }
  }

  // Scope filter (pre-commit / pre-push) — compute the diff once; per-step
  // skip happens at the top of the loop below. --scope-staged (staged diff)
  // and --scope-branch (branch-vs-main diff) are mutually exclusive scope
  // bases feeding the SAME per-step filter.
  let scopeDiff = null;
  let scopeShared = false;
  if (flags.scopeStaged) {
    scopeDiff = stagedDiffFiles(cwd);
    if (scopeDiff === null) {
      console.log('[scope] git diff --cached failed; running all selected steps');
    } else if (computeShared(scopeDiff)) {
      scopeShared = true;
      console.log('[scope] shared-scope change detected — all selected steps in scope');
    }
  } else if (flags.scopeBranch) {
    scopeDiff = branchDiffFiles(cwd);
    if (scopeDiff === null) {
      console.log('[scope] git merge-base/diff against main failed; running all selected steps');
    } else if (scopeDiff.length === 0) {
      console.log('[scope] no diff vs main — nothing in scope, selected steps will skip');
    } else if (computeShared(scopeDiff)) {
      scopeShared = true;
      console.log('[scope] shared-scope change detected — all selected steps in scope');
    }
  }

  const cachePath = join(cwd, CACHE_FILENAME);
  const fileList = gitFileList(cwd);
  const nodeVer = process.version;
  const schemaVer = SCHEMA_VERSION;
  const lockHashesAll = {
    root: hashFile(join(cwd, 'package-lock.json')),
    server: hashFile(join(cwd, 'server', 'package-lock.json')),
  };
  let cache = loadCache(cachePath);
  if (cache.schemaVersion !== schemaVer) {
    cache = { schemaVersion: schemaVer, steps: {} };
  }
  const fileHashes = new Map(); // memoize across steps

  if (!fileList) {
    console.log('[verify-cache] git ls-files failed; running uncached');
  }

  for (const step of activeSteps) {
    if (scopeDiff !== null && !scopeShared && !stepTouchedByDiff(step, scopeDiff)) {
      console.log(`[skip] ${step.name} (out of scope)`);
      continue;
    }
    const files = fileList ? selectStepFiles({ fileList, step }) : [];
    const entries = files.map((rel) => {
      let h = fileHashes.get(rel);
      if (!h) {
        h = hashFile(join(cwd, rel));
        fileHashes.set(rel, h);
      }
      return [rel, h];
    });
    const lockHashes = pickLockHashes(cwd, step.inputs.includeLockfiles ?? []);
    // Always reuse the universal lockHashesAll-derived values to avoid
    // re-reading the same file twice; pickLockHashes already memoizes via
    // hashFile, but cache the call site cheaply too.
    if (lockHashes.root === undefined && (step.inputs.includeLockfiles ?? []).includes('root')) {
      lockHashes.root = lockHashesAll.root;
    }
    if (
      lockHashes.server === undefined &&
      (step.inputs.includeLockfiles ?? []).includes('server')
    ) {
      lockHashes.server = lockHashesAll.server;
    }
    const fp = step.toolFingerprint ? step.toolFingerprint() : null;
    const currentHash = composeInputHash({
      stepName: step.name,
      sortedFileEntries: entries,
      lockHashes,
      nodeVer,
      schemaVer,
      toolFingerprint: fp,
    });

    const action =
      fileList === null
        ? 'run'
        : decide({
            stepName: step.name,
            currentHash,
            cache,
            noCache: flags.noCache,
          });

    if (action === 'skip') {
      console.log(`[cached] ${step.name} (input hash unchanged)`);
      continue;
    }

    console.log(`[run] ${step.name}`);
    const t0 = Date.now();
    const code = runStepProcess(step.name, { cwd, env });
    const dt = Date.now() - t0;
    if (code === 0) {
      console.log(`[pass] ${step.name} (took ${formatSecs(dt)})`);
      if (fileList !== null) {
        cache.steps[step.name] = {
          inputHash: currentHash,
          lastGreenAt: new Date().toISOString(),
          durationMs: dt,
        };
        saveCache(cachePath, cache);
      }
    } else {
      console.log(`[fail] ${step.name} (exit ${code}, took ${formatSecs(dt)})`);
      return code;
    }
  }
  return 0;
}

const isDirectInvocation = (() => {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return import.meta.url === pathToFileURL(arg1).href;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const code = runPipeline({ argv: process.argv.slice(2), cwd: repoRoot, env: process.env });
  process.exit(code);
}

// For tests that want to know the schema version / cache filename without
// hardcoding string literals.
export const _internals = { SCHEMA_VERSION, CACHE_FILENAME, toPosix, globToRegex };
