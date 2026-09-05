/* Regression coverage for the mirror invariant between server/vitest.config.ts's
   SLOW_FILES_TO_EXCLUDE and server/vitest.config.slow.ts's SLOW_FILES.

   Both configs state this invariant only in prose:
     - vitest.config.ts: "each entry here MUST also appear in
       vitest.config.slow.ts's SLOW_FILES array."
     - vitest.config.slow.ts: "each entry in SLOW_FILES below MUST also
       appear in server/vitest.config.ts's `test.exclude` array. Add a file
       in one place and the main run picks it up too (double-runs). Add in
       the other only and the file is not exercised."

   Nothing enforced it before this test (found while fixing #2947, which
   added an 11th entry). Two drift directions, both asserted here:
     1. A file in SLOW_FILES but not excluded by the main config → it
        double-runs (present in both the parallel AND serial lanes).
     2. A file excluded as a slow file but absent from SLOW_FILES → it is
        exercised nowhere.

   A third check goes beyond comparing the two constants: it dynamically
   imports vitest.config.ts's resolved default export and confirms every
   SLOW_FILES entry actually appears in the *effective* `test.exclude` array.
   The two constants can agree with each other while the spread that wires
   SLOW_FILES_TO_EXCLUDE into `exclude` is broken or removed — that failure
   mode is invisible to the set-equality check alone. */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const SERVER_ROOT = resolve(__dirname, '..');

type MainConfigModule = {
  default: { test?: { exclude?: string[] } };
  SLOW_FILES_TO_EXCLUDE: string[];
};
type SlowConfigModule = {
  default: { test?: { include?: string[] } };
  SLOW_FILES: string[];
};

/* server/vitest.config.ts and vitest.config.slow.ts live OUTSIDE server's
   rootDir (server/src), so `tsc -p .` (server typecheck) rejects a STATIC
   import of either ("File is not under rootDir"). A dynamic import with a
   runtime-computed specifier isn't statically resolved by TS, so it can't
   pull either file into the rootDir-checked program — same approach
   force-rerun-triggers.test.ts already uses for the same reason. */
async function loadMainConfig(): Promise<MainConfigModule> {
  const configAbsPath = resolve(SERVER_ROOT, 'vitest.config.ts');
  return (await import(pathToFileURL(configAbsPath).href)) as MainConfigModule;
}

async function loadSlowConfig(): Promise<SlowConfigModule> {
  const configAbsPath = resolve(SERVER_ROOT, 'vitest.config.slow.ts');
  return (await import(pathToFileURL(configAbsPath).href)) as SlowConfigModule;
}

/* scripts/flake-repro.mjs holds a THIRD copy of the slow-file list, now as
   the exact same relative paths as SLOW_FILES (not substrings). The earlier
   substring form over-matched unrelated files — e.g. 'generation' also
   matched generation-error.test.ts — and routed them to the slow config,
   which doesn't declare them, crashing the tool. That was found and fixed in
   PR #2998 review pass 2; this list must now be an EXACT set match against
   SLOW_FILES in both directions, not merely "every SLOW_FILES entry is
   covered by something". A dynamic import of that module is NOT used here:
   it reads `process.argv` at module-eval time and calls `process.exit(2)`
   when `--file` is absent, which would kill this test process rather than
   throw catchably. Reading the source and parsing out the `SLOW` array
   literal is the honest way to reach it without triggering that exit. */
function loadFlakeReproSlowList(): string[] {
  const srcPath = resolve(SERVER_ROOT, '..', 'scripts', 'flake-repro.mjs');
  const src = readFileSync(srcPath, 'utf8');
  // Anchored to start-of-line (with /m) so a block comment quoting an old
  // version of the list, or a commented-out prior declaration sitting above
  // the live one, can't win the unanchored first-match race that `.match`
  // without `/g` runs — both are realistic drift shapes while editing this
  // list, and both used to make this function return the WRONG array with
  // no error at all (PR #2998 review pass 2). If the live `const SLOW`
  // itself is ever indented, this now throws instead of silently reading
  // whatever a comment happens to quote — a loud failure here is the
  // correct outcome for a guard, unlike a silent wrong answer.
  const match = src.match(/^const SLOW = (\[[\s\S]*?\]);/m);
  if (!match) throw new Error('could not find the SLOW array literal in scripts/flake-repro.mjs');
  return new Function(`return ${match[1]}`)() as string[];
}

const { default: mainConfigDefault, SLOW_FILES_TO_EXCLUDE } = await loadMainConfig();
const { default: slowConfigDefault, SLOW_FILES } = await loadSlowConfig();

describe('slow-lane mirror invariant (SLOW_FILES <-> SLOW_FILES_TO_EXCLUDE)', () => {
  it('has no entry in SLOW_FILES that is missing from SLOW_FILES_TO_EXCLUDE (would run nowhere)', () => {
    const missing = SLOW_FILES.filter((f) => !SLOW_FILES_TO_EXCLUDE.includes(f));
    expect(missing).toEqual([]);
  });

  it('has no entry in SLOW_FILES_TO_EXCLUDE that is missing from SLOW_FILES (would double-run)', () => {
    const missing = SLOW_FILES_TO_EXCLUDE.filter((f) => !SLOW_FILES.includes(f));
    expect(missing).toEqual([]);
  });

  it('the two lists are exactly the same set', () => {
    expect(new Set(SLOW_FILES_TO_EXCLUDE)).toEqual(new Set(SLOW_FILES));
  });

  it("every SLOW_FILES entry actually appears in the main config's effective test.exclude", () => {
    const effectiveExclude = mainConfigDefault.test?.exclude ?? [];
    for (const file of SLOW_FILES) {
      expect(effectiveExclude).toContain(file);
    }
  });

  /* Mirrors the check above, on the other side of the mirror. SLOW_FILES and
     the slow config's `include` can agree as constants (they're the same
     binding — `include: SLOW_FILES` — so they're trivially equal by
     reference) while the *wiring* between them is broken: swap that line for
     a literal glob and SLOW_FILES still lists the 11 hot files, but nothing
     in this suite would notice the slow config no longer runs them. That's
     the same failure shape the main-config check exists for, just unguarded
     on this side until now (PR #2998 review pass 2) — a hot file dropped
     from the slow config's effective `include` this way isn't double-run,
     it's exercised NOWHERE, because the main config's `exclude` still lists
     it under SLOW_FILES_TO_EXCLUDE. */
  it("every SLOW_FILES entry actually appears in the slow config's effective test.include", () => {
    const effectiveInclude = slowConfigDefault.test?.include ?? [];
    for (const file of SLOW_FILES) {
      expect(effectiveInclude).toContain(file);
    }
  });

  it("flake-repro.mjs's SLOW list is exactly the same set as SLOW_FILES (both directions)", () => {
    const flakeReproSlow = loadFlakeReproSlowList();
    const missingFromFlakeRepro = SLOW_FILES.filter((f) => !flakeReproSlow.includes(f));
    const extraInFlakeRepro = flakeReproSlow.filter((f) => !SLOW_FILES.includes(f));
    expect(missingFromFlakeRepro).toEqual([]);
    expect(extraInFlakeRepro).toEqual([]);
  });

  /* All five checks above compare string arrays to each other (or, for the
     effective-exclude check, to a config object) — nothing touches disk. A
     SLOW_FILES entry that no longer names a real file (renamed or deleted
     without updating this list) leaves every one of those checks green
     while the slow lane silently runs 10 of 11 (vitest's `include` doesn't
     error on a glob matching nothing) AND the main config's literal-path
     `exclude` stops matching, so the file rejoins the parallel pool — the
     exact double-run this guard exists to prevent. */
  it('every SLOW_FILES entry resolves to a file that exists on disk', () => {
    const missingFromDisk = SLOW_FILES.filter((file) => !existsSync(resolve(SERVER_ROOT, file)));
    expect(missingFromDisk).toEqual([]);
  });

  /* If SLOW_FILES and SLOW_FILES_TO_EXCLUDE were ever emptied together, every
     check above passes vacuously: the filter/for-loop bodies never run and
     the set-equality holds trivially between two empty sets. A floor -
     rather than an exact count - is deliberate: hardcoding the current
     count (11) would fail on every legitimate future addition, which would
     make this a worse guard than none (it would train people to bump a
     magic number instead of reading why it exists). A small floor is enough
     to catch the vacuous-empty case this check exists for. */
  it('SLOW_FILES is actually populated (guards against the whole invariant going vacuous)', () => {
    expect(SLOW_FILES.length).toBeGreaterThanOrEqual(5);
  });
});
