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

const SERVER_ROOT = resolve(__dirname, '..');

type MainConfigModule = {
  default: { test?: { exclude?: string[] } };
  SLOW_FILES_TO_EXCLUDE: string[];
};
type SlowConfigModule = { SLOW_FILES: string[] };

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

const { default: mainConfigDefault, SLOW_FILES_TO_EXCLUDE } = await loadMainConfig();
const { SLOW_FILES } = await loadSlowConfig();

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
});
