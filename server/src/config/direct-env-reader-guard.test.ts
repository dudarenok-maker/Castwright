/* #2179 — the direct-`process.env` reader audit, as a guard test.

   Commenting out the generated `.env.example` block (renderManagedBlock,
   `env-example.ts`) makes `process.env.<VAR>` undefined for all 110
   registered env-backed knobs on a fresh install. Anything resolving
   through `configValue()`/`resolveKnob()` (`config/resolver.ts`) is
   unaffected — it falls through cleanly to the same registry default the
   `.env.example` line used to state. A site that instead reads
   `process.env.<VAR>` DIRECTLY, with its own hardcoded fallback, does NOT
   get that safety net: if its fallback ever differs from the knob's
   registry default, the fix silently changes that site's behaviour on
   every fresh install. `GEMINI_MODEL` was exactly this shape (five call
   sites, `?? 'gemma-4-31b-it'` vs. registry default
   `'gemini-3.5-flash-lite'`) — found by the initial manual audit and fixed
   by converting all five to `configValue('analyzer.gemini.model')`.

   WHAT THIS CHECKS (PR #2210 review hardening — see below for what changed
   from the #2179 original):

   1. WALK. Every non-test source file across five roots, not just
      `.ts` files under `server/src` (the original #2179 scope): `.ts`
      under `server/src`, `.ts` under `server/scripts`, `.mjs`/`.mts`/
      `.cjs`/`.js`/`.ts` under `scripts`, `.js` under `pinokio-scripts`,
      and `.mjs` under `server/tts-sidecar/scripts` (the sidecar's JS/TS-
      side installer helpers — the sidecar's own Python `main.py` is a
      SEPARATE audit, not this scan; see #2179's PR body). All keys below
      are REPO-ROOT-relative (`server/src/...`, `scripts/...`, etc.), not
      `server/src`-relative as the original #2179 version had them.

   2. OCCURRENCE SHAPES. Three ways a registered knob's env var can be read
      directly, all counted together per (file, name):
        - dot notation: `process.env.NAME`
        - bracket access with a STATIC string-literal key:
          `process.env['NAME']` / `process.env["NAME"]` / `` process.env[`NAME`] ``
        - object destructuring: `const { NAME } = process.env;` (including
          a renamed binding, `const { NAME: alias } = process.env;`)
      Comments and string/template-literal CONTENTS are stripped first (so
      a docblock that merely quotes `process.env.OLLAMA_URL` as prose
      doesn't inflate the count) — EXCEPT that a string/template literal
      immediately inside `process.env[...]` is deliberately NOT blanked,
      because that literal IS the thing shape 2 above needs to read.

   3. VALUE DRIFT. For a hand-picked subset of allowlisted sites
      (`EXPECTED_FALLBACKS` below) — the ones with a simple, textually
      pinnable fallback — the RAW source (not the comment/string-stripped
      copy) is checked for the expected fallback text within a window after
      the read. This is what actually catches the `GEMINI_MODEL`-shaped
      defect: occurrence-counting alone cannot, because changing a
      fallback's VALUE (`?? 500` → `?? 999`) doesn't change how many times
      `process.env.NAME` appears. This is a coarse, textual pin — not a
      data-flow proof — see BLIND SPOTS.

   Every allowlisted site was individually audited (see the comment beside
   each) and its fallback confirmed to agree with — or be behaviourally
   equivalent to — its knob's registry default.

   BLIND SPOTS (documented, not silently accepted):
     - Computed/interpolated keys (`process.env[someVariable]`,
       `` process.env[`GEMINI_RPM_${slug}`] ``) are still invisible by
       construction — there's no static literal name to match. Real sites
       of this shape: `select-analyzer.ts`'s `process.env[phaseEnvKey]`
       (harmless — a truthy check gating a fall-through to the next
       priority tier, not a fallback-VALUE substitution) and
       `rate-limit.ts`'s `` process.env[`GEMINI_RPM_${slug}`] `` (audited by
       hand: for the two registered slugs, `gemma-4-31b-it` and
       `gemma-4-26b-a4b-it`, the `BUILTIN_LIMITS` fallback table's
       rpm/tpm/rpd values are identical to the matching
       `GEMINI_{RPM,TPM,RPD}_GEMMA_*` registry defaults).
     - A fallback embedded in a helper this scan can't see through (e.g. a
       function that takes the raw env string as a parameter from
       elsewhere) reads as "no occurrence" here. This is a floor, not a
       full data-flow proof.
     - `EXPECTED_FALLBACKS` covers only the sites where the fallback is a
       short, textually-pinnable literal or identifier reachable within a
       bounded window of the read. It is NOT auto-derived from
       `ALLOWLISTED_SITES` — an allowlisted site with no `EXPECTED_FALLBACKS`
       entry (e.g. `ANALYZER_PHASE0_MODEL`/`ANALYZER_PHASE1_MODEL` in
       `select-analyzer.ts`, which only participate in a truthiness check
       with no substituted value at all) is still protected by the
       occurrence-count check, just not by a value pin.
     - The regex-literal fix below is a heuristic (division-vs-regex is
       genuinely ambiguous without a real parser), not a proof. It reduces
       the risk, it does not eliminate it: a regex literal in a position
       this scan misjudges as "not a regex" would still corrupt the scan
       the old way.

   MUTATION-PROOFS for each hardened shape (each was run against a scratch
   file under `server/src/config/`, confirmed RED, then removed — see the
   #2210 PR description / agent report for the transcript of each run):
     - Bracket-literal: `process.env['GPU_RESERVE_MB'] ?? 999` in a new,
       unlisted scratch file → red (new unaudited occurrence).
     - Destructuring: `const { ASR_DEVICE } = process.env;` in a new,
       unlisted scratch file → red.
     - Regex-literal defeating `stripOpaque`: a scratch file containing
       `export const RE = /[a-z']/g;` immediately followed by
       `process.env.ASR_DEVICE;` — BEFORE the regex-literal fix this made
       the guard blind to the trailing `process.env.ASR_DEVICE` read
       (green when it should have been red); AFTER the fix it is red
       (new unaudited occurrence), same as any other new site.
     - Value drift (the `EXPECTED_FALLBACKS` check): editing
       `server/src/gpu/gpu-load.ts`'s `: 500` fallback to `: 999` in place
       → red, with no change to any occurrence count. Reverted after
       confirming.
     - Original #2179 mutation, still valid: `process.env.GPU_RESERVE_MB ??
       999` (dot notation) added to a scratch file under
       `server/src/config/` → red (count went from 1 to 2 in an
       already-allowlisted file). */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allKnobs } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/config -> server/src -> server -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Every root this guard walks, with the extensions it treats as source
    there. `server/src` stays TS-only (its existing scope); the widened
    roots each get only the extension(s) actually used there. */
const WALK_TARGETS: Array<{ dir: string; exts: string[] }> = [
  { dir: join(REPO_ROOT, 'server', 'src'), exts: ['.ts'] },
  { dir: join(REPO_ROOT, 'server', 'scripts'), exts: ['.ts'] },
  { dir: join(REPO_ROOT, 'scripts'), exts: ['.mjs', '.mts', '.cjs', '.js', '.ts'] },
  { dir: join(REPO_ROOT, 'pinokio-scripts'), exts: ['.js'] },
  { dir: join(REPO_ROOT, 'server', 'tts-sidecar', 'scripts'), exts: ['.mjs'] },
];

function isTestFile(name: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(name);
}

/** Every non-test source file under `dir` matching one of `exts`,
    recursively. Missing directories (none of the walked roots are
    optional in this repo, but this keeps the scan non-fatal if one ever
    is) are silently skipped. */
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
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e)) && !isTestFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** src[start] is an opening quote character (`'`, `"`, or `` ` ``). Returns
    the index just past the matching UNESCAPED closing quote, or the string
    length if unterminated (runs to EOF) — same "never claim a false end"
    behaviour the original opaque-stripping loop used. */
function findStringEnd(src: string, start: number): number {
  const quote = src[start];
  const n = src.length;
  let j = start + 1;
  while (j < n) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    j += 1;
  }
  return n;
}

/** Looks backward over the ALREADY-PROCESSED prefix of `out` (real code
    chars; comments/strings already blanked to spaces/newlines) to decide
    whether the `/` at `out[i]` starts a regex literal rather than a
    division operator. A `/` preceded by an identifier, number, `)`, `]` or
    `}` is division (`a / b`, `fn() / 2`, `arr[0] / 2`) UNLESS that
    identifier is a keyword that can only precede an expression (`return`,
    `typeof`, `case`, …) — anything else (start of file, or preceded by
    punctuation like `(`, `,`, `=`, `&&`) is a regex-literal position. This
    is the same division-vs-regex heuristic every JS-aware textual scanner
    without a real parser has to make; it is not a proof. */
function isRegexContext(out: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (out[j] === ' ' || out[j] === '\n')) j -= 1;
  if (j < 0) return true;
  const c = out[j];
  if (!/[A-Za-z0-9_$)\]}]/.test(c)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k -= 1;
  const word = out.slice(k + 1, j + 1).join('');
  const EXPRESSION_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'instanceof', 'yield', 'do', 'else',
  ]);
  return EXPRESSION_KEYWORDS.has(word);
}

/** Dry-run lookahead: does `src` starting at the `/` at index `i` parse as
    a regex literal (respecting a `[...]` character class, where an
    unescaped `/` does NOT close the regex, and backslash escapes)? Returns
    the index just past the literal (including any trailing flag letters),
    or null if it hits a newline first (a real regex literal cannot contain
    one — this is the same "not actually a regex" signal an unterminated
    string gets from the surrounding syntax, just checked before committing
    any mutation, so a misjudged `isRegexContext` never corrupts real code:
    on a null return the caller falls through to the default single-char
    copy, i.e. ordinary division). */
function scanPotentialRegex(src: string, i: number): number | null {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === '\n') return null;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') {
      inClass = true;
      j += 1;
      continue;
    }
    if (c === ']') {
      inClass = false;
      j += 1;
      continue;
    }
    if (c === '/' && !inClass) {
      j += 1;
      while (j < n && /[A-Za-z]/.test(src[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return null;
}

/** Blank out every comment and string/template-literal body, preserving
    line structure (each blanked char becomes a space, newlines kept) so a
    docblock that quotes `process.env.NAME` as prose — or a string literal
    that happens to contain the same text — can never be mistaken for a
    real read site. A raw character scan, not a parser; handles backslash
    escapes inside quotes and runs to EOF on an unterminated comment.

    Two shapes are deliberately preserved RAW rather than blanked:
      - `process.env[<quoted-literal>]` — the quoted key IS the read site
        (shape 2 in the header comment); blanking it would make bracket-
        literal reads permanently invisible to the occurrence scan.
      - a `/regex-literal/` — via `isRegexContext`/`scanPotentialRegex`
        above, so an apostrophe or quote INSIDE the character class (e.g.
        `/[a-z']/g`) is correctly recognised as regex content rather than
        as a string open that (with no real closing quote before EOF) used
        to swallow every real `process.env.NAME` occurrence after it in
        the file. */
function stripOpaque(src: string): string {
  const n = src.length;
  const out: string[] = new Array(n);
  let i = 0;
  while (i < n) {
    const ch = src[i];

    if (ch === 'p' && src.startsWith('process.env[', i)) {
      const label = 'process.env[';
      for (let k = 0; k < label.length; k += 1) out[i + k] = src[i + k];
      let j = i + label.length;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) {
        out[j] = src[j];
        j += 1;
      }
      if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '`')) {
        const end = findStringEnd(src, j);
        for (let k = j; k < end; k += 1) out[k] = src[k];
        j = end;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) {
          out[j] = src[j];
          j += 1;
        }
        if (j < n && src[j] === ']') {
          out[j] = src[j];
          j += 1;
        }
      }
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out[i] = ' ';
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          out[j] = ' ';
          out[j + 1] = src[j + 1] === '\n' ? '\n' : ' ';
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          out[j] = ' ';
          j += 1;
          break;
        }
        out[j] = src[j] === '\n' ? '\n' : ' ';
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
    if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && isRegexContext(out, i)) {
      const end = scanPotentialRegex(src, i);
      if (end !== null) {
        for (let k = i; k < end; k += 1) out[k] = src[k] === '\n' ? '\n' : ' ';
        i = end;
        continue;
      }
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

/** file (repo-root-relative, forward slashes) -> number of registered-knob
    `process.env` occurrences (dot, bracket-literal, or destructuring —
    see the header comment) already audited (#2179, hardened #2210) and
    confirmed to agree with (or be provably equivalent to) their knob's
    registry default. */
const ALLOWLISTED_SITES: Record<string, number> = {
  // OLLAMA_URL ?? 'http://localhost:11434' — matches the registry default.
  'server/src/analyzer/attribution-eval/run-eval-cli.ts': 1,
  // Line 1: `ANALYZER_PHASE0_MODEL || ANALYZER_PHASE1_MODEL` truthiness
  // check only (registry default '' for both — '' and undefined are both
  // falsy, so no substituted value ever differs). Line 2:
  // ANALYZER_PHASE1_MIN_LAG_CHAPTERS, invalid/absent falls through to
  // DEFAULT_PHASE1_MIN_LAG_CHAPTERS (10), which matches the registry default.
  'server/src/analyzer/select-analyzer.ts': 3,
  // GPU_RESERVE_MB: non-finite/absent falls back to 500, the registry default.
  'server/src/gpu/gpu-load.ts': 1,
  // SEG_QA_MAX_RERECORDS: non-finite/absent falls back to 2, the registry default.
  'server/src/routes/chapter-qa-repair.ts': 1,
  // ACCELERATOR ?? null. 'auto' (the registry default) is not in the
  // sidecar's PROFILES list (tts-sidecar/scripts/accelerator-profile.mjs),
  // so an active 'auto' and an absent env fall through to the same
  // wizard/detected branch — behaviourally identical.
  'server/src/tts/spawn-sidecar.ts': 1,
  // ACCELERATOR ?? null — same reasoning as spawn-sidecar.ts above.
  'server/src/upgrade/apply.ts': 1,
  // OLLAMA_URL falls through to DEFAULT_USER_SETTINGS.ollamaUrl
  // ('http://localhost:11434'); GEN_WORKERS falls through (via override,
  // cached settings) to DEFAULT_USER_SETTINGS.generationWorkers (1);
  // OLLAMA_MODEL falls through to DEFAULT_OLLAMA_MODEL ('qwen3.5:4b'). All
  // three match their registry defaults.
  'server/src/workspace/user-settings.ts': 3,
  // ACCELERATOR ?? null — same reasoning as spawn-sidecar.ts above. Widened
  // into scope by #2210 (the walk used to stop at server/src).
  'server/tts-sidecar/scripts/bootstrap-venv.mjs': 1,
  // `flag('--model') || process.env.ASR_MODEL || 'base'` — matches the
  // registry default. Widened into scope by #2210.
  'server/tts-sidecar/scripts/install-whisper.mjs': 1,
  // CASTWRIGHT_GPU_SPLIT_PROBE === '0' — no fallback operator, just a
  // truthiness check; absent/unset is equivalent to truthy (probe on).
  'server/src/gpu/ollama-gpu-split.ts': 1,
};

/** (file, name) -> a short, literal-or-identifier snippet that must still
    appear in the RAW source within `FALLBACK_WINDOW` characters after a
    `process.env.NAME` read, i.e. a value pin on top of the occurrence-count
    check above. This is what actually catches a `GEMINI_MODEL`-shaped
    defect — a fallback's VALUE silently changing (`?? 500` -> `?? 999`)
    without adding or removing any occurrence. Deliberately checked against
    the RAW file, not the comment/string-stripped copy: several of these
    expected values (e.g. `'cpu'`) are themselves string literals, which
    `stripOpaque` blanks by design.

    Not every `ALLOWLISTED_SITES` entry has a matching row here — a site
    with no substituted fallback value at all (the two `select-analyzer.ts`
    truthiness-only reads) has nothing to pin; see BLIND SPOTS above. */
const FALLBACK_WINDOW = 900;
const EXPECTED_FALLBACKS: Array<{ file: string; name: string; fallback: string }> = [
  {
    file: 'server/src/analyzer/attribution-eval/run-eval-cli.ts',
    name: 'OLLAMA_URL',
    fallback: "'http://localhost:11434'",
  },
  {
    file: 'server/src/analyzer/select-analyzer.ts',
    name: 'ANALYZER_PHASE1_MIN_LAG_CHAPTERS',
    fallback: 'DEFAULT_PHASE1_MIN_LAG_CHAPTERS',
  },
  { file: 'server/src/gpu/gpu-load.ts', name: 'GPU_RESERVE_MB', fallback: '500' },
  { file: 'server/src/routes/chapter-qa-repair.ts', name: 'SEG_QA_MAX_RERECORDS', fallback: ': 2;' },
  { file: 'server/src/tts/spawn-sidecar.ts', name: 'ACCELERATOR', fallback: 'null' },
  { file: 'server/src/upgrade/apply.ts', name: 'ACCELERATOR', fallback: 'null' },
  {
    file: 'server/src/workspace/user-settings.ts',
    name: 'OLLAMA_URL',
    fallback: 'DEFAULT_USER_SETTINGS.ollamaUrl',
  },
  {
    file: 'server/src/workspace/user-settings.ts',
    name: 'GEN_WORKERS',
    fallback: 'DEFAULT_USER_SETTINGS.generationWorkers',
  },
  {
    file: 'server/src/workspace/user-settings.ts',
    name: 'OLLAMA_MODEL',
    fallback: 'DEFAULT_OLLAMA_MODEL',
  },
  { file: 'server/tts-sidecar/scripts/bootstrap-venv.mjs', name: 'ACCELERATOR', fallback: 'null' },
  { file: 'server/tts-sidecar/scripts/install-whisper.mjs', name: 'ASR_MODEL', fallback: "'base'" },
];

/** True when at least one raw `process.env.NAME` occurrence in `rawSrc` is
    followed, within `FALLBACK_WINDOW` characters, by `fallback` verbatim.
    Checks every occurrence (not just the first) so a stray mention in a
    comment earlier in the file can't produce a false failure. */
function fallbackStillPresent(rawSrc: string, name: string, fallback: string): boolean {
  const re = new RegExp(`process\\.env\\.${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawSrc))) {
    const window = rawSrc.slice(m.index, m.index + FALLBACK_WINDOW);
    if (window.includes(fallback)) return true;
  }
  return false;
}

describe('direct process.env readers of a registered knob (#2179 audit guard)', () => {
  it('every process.env.<registered-var> occurrence (dot, bracket-literal, or destructured) is on the audited allowlist, at the audited count', () => {
    const registeredNames = allKnobs()
      .filter((k) => !k.isPrompt && k.env)
      .map((k) => k.env!);

    const files = WALK_TARGETS.flatMap((t) => collectFiles(t.dir, t.exts));
    const foundCounts: Record<string, number> = {};

    for (const file of files) {
      const rel = file.slice(REPO_ROOT.length + 1).split('\\').join('/');
      const stripped = stripOpaque(readFileSync(file, 'utf8'));
      let total = 0;
      for (const name of registeredNames) {
        const dot = new RegExp(`process\\.env\\.${name}\\b`, 'g');
        const dotMatches = stripped.match(dot);
        if (dotMatches) total += dotMatches.length;

        const bracket = new RegExp(`process\\.env\\[\\s*(['"\`])${name}\\1\\s*\\]`, 'g');
        const bracketMatches = stripped.match(bracket);
        if (bracketMatches) total += bracketMatches.length;

        const destructure = new RegExp(
          `\\{[^{};]{0,200}\\b${name}\\b[^{};]{0,200}\\}\\s*=\\s*process\\.env\\b`,
          'g',
        );
        const destructureMatches = stripped.match(destructure);
        if (destructureMatches) total += destructureMatches.length;
      }
      if (total > 0) foundCounts[rel] = total;
    }

    // Every allowlisted file must still show EXACTLY its audited count —
    // more means a new, unaudited occurrence was added; fewer means the
    // allowlist is stale (the site moved or was converted) and should be
    // trimmed so it can't mask a future re-introduction landing back at
    // the old, now-unverified count.
    for (const [file, expectedCount] of Object.entries(ALLOWLISTED_SITES)) {
      expect(foundCounts[file], `${file}: expected ${expectedCount} audited occurrence(s)`).toBe(
        expectedCount,
      );
    }

    // No file outside the allowlist may contain ANY occurrence — a brand
    // new direct reader of a registered knob, anywhere in the walked
    // roots, fails here.
    const unexpected = Object.keys(foundCounts).filter((f) => !(f in ALLOWLISTED_SITES));
    expect(
      unexpected,
      unexpected
        .map((f) => `${f}: ${foundCounts[f]} unaudited process.env.<registered-var> occurrence(s)`)
        .join('\n'),
    ).toEqual([]);
  });

  it("every EXPECTED_FALLBACKS entry's fallback value is still present at its read site (value-drift guard)", () => {
    for (const { file, name, fallback } of EXPECTED_FALLBACKS) {
      const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(
        fallbackStillPresent(raw, name, fallback),
        `${file}: process.env.${name}'s fallback should still contain ${JSON.stringify(fallback)} within ${FALLBACK_WINDOW} chars of the read — if this fallback was deliberately changed, confirm it still agrees with the registry default for '${name}' before updating this entry`,
      ).toBe(true);
    }
  });
});
