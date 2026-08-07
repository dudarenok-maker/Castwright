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

   WHAT THIS CHECKS: walks every `.ts` file under `server/src` (recursively,
   excluding `*.test.ts`), strips comments and string/template-literal
   CONTENTS (so a docblock that merely quotes `process.env.OLLAMA_URL` as
   prose — e.g. `workspace/user-settings.ts`'s precedence-chain comments —
   doesn't inflate the count), and counts every remaining
   `process.env.<NAME>` occurrence for each of the 110 registered env
   names. The count per file is checked against `ALLOWLISTED_SITES` below,
   keyed on file AND count — same shape as the cast-lock guard
   (`workspace/cast-lock.guard.test.ts`), so a NEW occurrence in an
   ALREADY-listed file still fails, not just a new file. Every allowlisted
   site was individually audited (see the comment beside each) and its
   fallback confirmed to agree with — or be behaviourally equivalent to —
   its knob's registry default.

   BLIND SPOTS (same "call-graph-blind by design" caveat as the cast-lock
   guard — documented, not silently accepted):
     - Bracket/computed-key reads (`process.env[someVariable]`,
       `` process.env[`GEMINI_RPM_${slug}`] ``) are invisible to this dot-
       notation scan by construction — there's no literal name to match. Two
       real sites are this shape: `select-analyzer.ts`'s
       `process.env[phaseEnvKey]` (harmless — it's used as a truthy check
       gating a fall-through to the next priority tier, not as a
       fallback-VALUE substitution) and `rate-limit.ts`'s
       `` process.env[`GEMINI_RPM_${slug}`] `` (audited by hand: for the two
       registered slugs, `gemma-4-31b-it` and `gemma-4-26b-a4b-it`, the
       `BUILTIN_LIMITS` fallback table's rpm/tpm/rpd values are identical to
       the matching `GEMINI_{RPM,TPM,RPD}_GEMMA_*` registry defaults).
     - A fallback embedded in a helper this scan can't see through (e.g. a
       function that takes the raw env string as a parameter from elsewhere)
       would read as "no occurrence" here. None of the current 13 dot-
       notation sites are that shape, but a future one could be — this scan
       is a floor, not a full data-flow proof.

   MUTATION-PROOF: this guard was run with a synthetic divergent reader
   (`process.env.GPU_RESERVE_MB ?? 999` — note dropped, count went from 1 to
   2 in an already-allowlisted file) added to a scratch file under
   `server/src/config/`, confirmed red, then removed — see the #2179 PR
   description / agent report for the transcript. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allKnobs } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/** Every non-test `.ts` file under `server/src`, recursively. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Blank out every comment and string/template-literal body, preserving
    line structure (each blanked char becomes a space, newlines kept) so a
    docblock that quotes `process.env.NAME` as prose — or a string literal
    that happens to contain the same text — can never be mistaken for a
    real read site. A raw character scan, not a parser; handles backslash
    escapes inside quotes and runs to EOF on an unterminated comment. */
function stripOpaque(src: string): string {
  const n = src.length;
  const out: string[] = new Array(n);
  let i = 0;
  while (i < n) {
    const ch = src[i];
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
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

/** file (relative to server/src, forward slashes) -> number of
    `process.env.<registered-var>` occurrences already audited (#2179) and
    confirmed to agree with (or be provably equivalent to) their knob's
    registry default. */
const ALLOWLISTED_SITES: Record<string, number> = {
  // OLLAMA_URL ?? 'http://localhost:11434' — matches the registry default.
  'analyzer/attribution-eval/run-eval-cli.ts': 1,
  // Line 1: `ANALYZER_PHASE0_MODEL || ANALYZER_PHASE1_MODEL` truthiness
  // check only (registry default '' for both — '' and undefined are both
  // falsy, so no substituted value ever differs). Line 2:
  // ANALYZER_PHASE1_MIN_LAG_CHAPTERS, invalid/absent falls through to
  // DEFAULT_PHASE1_MIN_LAG_CHAPTERS (10), which matches the registry default.
  'analyzer/select-analyzer.ts': 3,
  // GPU_RESERVE_MB: non-finite/absent falls back to 500, the registry default.
  'gpu/gpu-load.ts': 1,
  // SEG_QA_MAX_RERECORDS: non-finite/absent falls back to 2, the registry default.
  'routes/chapter-qa-repair.ts': 1,
  // SPK_DEVICE ?? 'cpu' — matches the registry default.
  'tts/embed-client.ts': 1,
  // ACCELERATOR ?? null. 'auto' (the registry default) is not in the
  // sidecar's PROFILES list (tts-sidecar/scripts/accelerator-profile.mjs),
  // so an active 'auto' and an absent env fall through to the same
  // wizard/detected branch — behaviourally identical.
  'tts/spawn-sidecar.ts': 1,
  // ASR_DEVICE ?? 'cpu' — matches the registry default. (Being touched
  // separately under #2178 — audited as-is on this branch.)
  'tts/transcribe-client.ts': 1,
  // ACCELERATOR ?? null — same reasoning as spawn-sidecar.ts above.
  'upgrade/apply.ts': 1,
  // OLLAMA_URL falls through to DEFAULT_USER_SETTINGS.ollamaUrl
  // ('http://localhost:11434'); GEN_WORKERS falls through (via override,
  // cached settings) to DEFAULT_USER_SETTINGS.generationWorkers (1);
  // OLLAMA_MODEL falls through to DEFAULT_OLLAMA_MODEL ('qwen3.5:4b'). All
  // three match their registry defaults.
  'workspace/user-settings.ts': 3,
};

describe('direct process.env readers of a registered knob (#2179 audit guard)', () => {
  it('every process.env.<registered-var> occurrence is on the audited allowlist, at the audited count', () => {
    const registeredNames = allKnobs()
      .filter((k) => !k.isPrompt && k.env)
      .map((k) => k.env!);

    const files = collectSourceFiles(SRC_ROOT);
    const foundCounts: Record<string, number> = {};

    for (const file of files) {
      const rel = file.slice(SRC_ROOT.length + 1).split('\\').join('/');
      const stripped = stripOpaque(readFileSync(file, 'utf8'));
      let total = 0;
      for (const name of registeredNames) {
        const re = new RegExp(`process\\.env\\.${name}\\b`, 'g');
        const matches = stripped.match(re);
        if (matches) total += matches.length;
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
    // new direct reader of a registered knob, anywhere, fails here.
    const unexpected = Object.keys(foundCounts).filter((f) => !(f in ALLOWLISTED_SITES));
    expect(
      unexpected,
      unexpected
        .map((f) => `${f}: ${foundCounts[f]} unaudited process.env.<registered-var> occurrence(s)`)
        .join('\n'),
    ).toEqual([]);
  });
});
