/* #3139/#3146 — the registry-knob-read audit, as a guard test.

   WHAT THIS CHECKS. #3139 found a registry knob (`rate.*.gemma[26]`) that
   Advanced Settings lets a user override, but that no server code actually
   read through the config resolver — the saved override was silently
   ignored, because `resolveLimits` in `analyzer/rate-limit.ts` computed its
   own env-only lookup instead of going through `resolveKnob`/`configValue`.
   That was one instance of a whole CLASS of defect: nothing stopped a new
   registry knob from shipping with no resolver-backed read site at all. This
   guard scans every non-test server source file for resolver-backed reads
   (`configValue('<key>')`/`configValue<T>('<key>')`, `getKnob('<key>')`) and
   fails when an in-scope knob's key never appears as one, UNLESS the knob is
   read through a recognised dynamic-key pattern (`DECLARED_DYNAMIC_READERS`)
   or is a currently-known gap (`KNOWN_UNREAD`, tracked by #3141).

   SCOPE. `allKnobs()` filtered to `!isPrompt && apply !== 'restart-sidecar'`.
   Prompt knobs have no env/resolver read path at all (value is a `.md` fork
   pointer). `restart-sidecar` knobs are legitimately never read by name on
   the Node side — they're forwarded generically by iterating `allKnobs()` in
   `tts/spawn-sidecar.ts`'s `buildSidecarEnv`, so per-key literal reads would
   be redundant, not missing.

   WALK. Every non-test `.ts` file under `server/src` and `server/scripts`,
   excluding `server/src/config/registry.ts` itself (the knob table — it
   defines keys, it doesn't read them).

   DYNAMIC READERS. Two knob families are read through a COMPUTED key, not a
   string literal, so the occurrence scan below is structurally blind to
   them:
     - `qa.asr.maxWer.<lang>` — `tts/segment-asr-qa.ts` builds
       `` `qa.asr.maxWer.${lang}` `` and looks it up via
       `allKnobs().find(...)` + `resolveKnob(...)`.
     - `rate.{rpm,tpm,rpd}.<slug>` — `analyzer/rate-limit.ts`'s
       `overrideValue` looks up the knob by matching `k.env` against a
       computed env-var name, then resolves it — the fix this guard exists
       to protect. Each `DECLARED_DYNAMIC_READERS` entry is verified against
       the ACTUAL file content below (not just trusted), so a declaration
       that stops matching reality fails the same as a missing read.

   A THIRD RECOGNISED SHAPE: `readConfigOverrides()['<key>']` (bracket-
   literal), used by `workspace/user-settings.ts`'s `getResolvedGenerationWorkers`
   for `tts.gen.workers`. That function deliberately reads the SAME override
   store `config/resolver.ts` reads (`readConfigOverrides`, imported FROM
   `user-settings.ts` by `resolver.ts` itself) rather than going through
   `configValue`/`resolveKnob`, specifically to avoid a circular import
   between the two modules (see that function's own comment) — a real,
   override-honouring read site in a different shape, not a gap.

   Unread knobs are tracked: all registered knobs are either read by some live
   code path (via `configValue()`/`getKnob()`/`readConfigOverrides()` with a
   literal key), or tracked in `KNOWN_UNREAD` when they have no read path yet
   (temporarily, pending implementation of the reader — see #3141). `KNOWN_UNREAD`
   is exact-set-equality asserted, so a stale entry signals a rebase/merge defect
   (the knob was deleted or a reader was wired but the list was not updated),
   and a missing entry signals a knob left unread by mistake (new code added to
   the registry before readers are wired). See `KNOWN_UNREAD` below.

   BLIND SPOTS (documented, not silently accepted):
     - Textual, not data-flow: a resolver-backed helper reached through a
       re-exported alias, or called with the key built one hop away from the
       call site (`const k = 'foo'; configValue(k)`), reads as "no
       occurrence" here — same limitation `direct-env-reader-guard.test.ts`
       documents for its own literal-argument scan.
     - Only `configValue`/`getKnob`/`readConfigOverrides()[...]` are
       recognised as resolver/override-backed reads with a literal-key
       argument. `allKnobs().find((k) => k.key === '<literal>')` is a fourth
       shape actually used in `tts/spawn-sidecar.ts` (`sidecar.vramFreeFloorMb`,
       `sidecar.restartMb`, `sidecar.vramRestartMb`) but every knob read that
       way today is `apply: 'restart-sidecar'` and therefore already out of
       scope; if an in-scope knob ever adopts that shape as its ONLY read
       site, this guard needs a new recogniser, not a new allowlist entry.
     - `DECLARED_DYNAMIC_READERS` patterns are hand-authored per knob family.
       A new dynamically-keyed family needs its own entry; until then it
       fails here exactly like a knob with no read site at all — which is
       the safe direction to fail in. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allKnobs } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/config -> server/src -> server -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..');

const REGISTRY_FILE = join(REPO_ROOT, 'server', 'src', 'config', 'registry.ts');

const WALK_TARGETS: Array<{ dir: string; exts: string[] }> = [
  { dir: join(REPO_ROOT, 'server', 'src'), exts: ['.ts'] },
  { dir: join(REPO_ROOT, 'server', 'scripts'), exts: ['.ts'] },
];

function isTestFile(name: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(name);
}

/** Every non-test source file under `dir` matching one of `exts`,
    recursively, excluding `REGISTRY_FILE`. Missing directories are silently
    skipped (non-fatal, mirroring direct-env-reader-guard.test.ts). */
function collectFiles(dir: string, exts: string[], out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, exts, out);
    } else if (
      entry.isFile() &&
      exts.some((e) => entry.name.endsWith(e)) &&
      !isTestFile(entry.name) &&
      full !== REGISTRY_FILE
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Blank out `//` and `/* *\/` comments only — string/template-literal
    CONTENTS are deliberately left intact, because the knob key this guard
    looks for IS a string/template-literal argument. That means a plain
    string literal that merely CONTAINS text shaped like a real read call —
    e.g. a help string mentioning `configValue('zzz.instring')` — passes
    through unchanged and reads as a real occurrence; that accepted false
    positive is narrower than direct-env-reader-guard's stripOpaque (no
    regex-literal handling needed — nothing here scans for a bare `/`). */
function stripComments(src: string): string {
  const n = src.length;
  const out: string[] = new Array(n);
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out[i] = ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          out[j] = src[j];
          out[j + 1] = src[j + 1];
          j += 2;
          continue;
        }
        out[j] = src[j];
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') {
        out[j] = ' ';
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) {
        out[j] = src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      if (j < n) {
        out[j] = ' ';
        out[j + 1] = ' ';
        j += 2;
      }
      i = j;
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

/** Matches `configValue('key')`, `configValue<T>('key')`, and
    `getKnob('key')` — the resolver-backed helpers that take a knob's KEY as
    a string-literal first argument. Group 2 is the key text. */
const READ_HELPER_RE = /\b(?:configValue(?:<[^>()]*>)?|getKnob)\(\s*(['"`])((?:(?!\1).)*)\1/g;

/** Matches `readConfigOverrides()['key']` — the override-store bracket-
    literal shape `getResolvedGenerationWorkers` uses for `tts.gen.workers`
    (see header comment). Group 2 is the key text. */
const OVERRIDE_BRACKET_RE = /\breadConfigOverrides\(\)\[\s*(['"`])((?:(?!\1).)*)\1\s*\]/g;

/** knob key pattern -> (file, substring) that must be present VERBATIM in
    the file's raw source for the declaration to be trusted. Checked against
    reality below, not merely asserted — see the header comment. */
const DECLARED_DYNAMIC_READERS: Array<{ pattern: RegExp; file: string; contains: string }> = [
  {
    pattern: /^qa\.asr\.maxWer\.[a-z]+$/,
    file: 'server/src/tts/segment-asr-qa.ts',
    contains: 'allKnobs().find((k) => k.key === `qa.asr.maxWer.${lang}`)',
  },
  {
    pattern: /^rate\.(rpm|tpm|rpd)\.[a-zA-Z0-9]+$/,
    file: 'server/src/analyzer/rate-limit.ts',
    contains: 'allKnobs().find((k) => k.env === envName)',
  },
];

/** Knobs with no resolver-backed read site today, each tracked by #3141 —
    NOT fixed here (that issue is a separate, scoped effort). Listed exactly
    so this guard can assert the failing set is precisely this set: a new
    unread knob (not on this list) fails, and a listed key that becomes read
    also fails, so the list can't go stale in either direction. */
const KNOWN_UNREAD = new Set<string>([]);

function collectReadKeys(files: string[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    for (const re of [READ_HELPER_RE, OVERRIDE_BRACKET_RE]) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(stripped))) {
        keys.add(m[2]);
      }
    }
  }
  return keys;
}

describe('registry knobs the server never reads (#3139/#3146 guard)', () => {
  it('every in-scope knob is read via a literal resolver call, a verified dynamic reader, or is a declared #3141 gap', () => {
    const files = WALK_TARGETS.flatMap((t) => collectFiles(t.dir, t.exts));
    const readKeys = collectReadKeys(files);

    const scoped = allKnobs().filter((k) => !k.isPrompt && k.apply !== 'restart-sidecar');

    const unread: string[] = [];
    for (const knob of scoped) {
      if (readKeys.has(knob.key)) continue;

      const dynamic = DECLARED_DYNAMIC_READERS.find((d) => d.pattern.test(knob.key));
      if (dynamic) {
        const stripped = stripComments(readFileSync(join(REPO_ROOT, dynamic.file), 'utf8'));
        if (stripped.includes(dynamic.contains)) continue;
        // The declared dynamic reader no longer matches reality — treat the
        // knob as unread rather than silently trusting a stale declaration.
        unread.push(knob.key);
        continue;
      }

      unread.push(knob.key);
    }

    // Exact set equality, checked in both directions: a knob missing from
    // KNOWN_UNREAD that is actually unread is a newly-introduced instance of
    // the #3139 class; a knob listed in KNOWN_UNREAD that IS read means the
    // list has gone stale and must be trimmed so it can't mask a future
    // regression landing back at the same key.
    expect(new Set(unread), 'unread knobs found by the scan').toEqual(KNOWN_UNREAD);
  });
});
