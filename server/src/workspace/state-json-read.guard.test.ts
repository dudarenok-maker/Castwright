/* #3625 pass 6 (🟠1) - the static guard that keeps every state.json READ on
   the recovering path. Sibling of `state-json-lock.guard.test.ts` (which
   checks the writes): same syntactic approach, same tokenizer (the shared
   `server/src/test-utils/guard-scan.ts`, #3685).

   WHY: a rotating write (`writeJsonAtomic` with `{ rotate }`, which every
   `writeStateJsonAtomic` is) renames main to `.bak.1` BEFORE it renames the new
   file in - the order #3625 chose because #3706's copy-then-replace failed with
   EPERM on Windows. For that window `.audiobook/state.json` is absent. A plain
   read there (`readJson` -> null, `existsSync` -> false, a raw `readFile` ->
   ENOENT) sees "no book": a series walk skips it, the library-voice DELETE
   misses its "in use" 409. `readStateJsonWithRecovery` (state-migrate.ts)
   serves `.bak.1` in that window instead, and still answers `null` for a
   genuinely absent book.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` except
   `workspace/state-io.ts` (the primitives) and `workspace/state-migrate.ts`
   (the recovering read itself), and fails on any of these outside a comment or
   string:
     - `readJson(stateJsonPath(` / `readJson<...>(stateJsonPath(`;
     - `readJson<BookStateJson>(` with any argument;
     - `readJsonWithRecovery(stateJsonPath(` (the bare primitive: without
       `recoverMissing` it reads the window as absent);
     - `existsSync` / `statSync` / `stat` / `access` / `readFile` /
       `readFileSync` / `copyFile` / `createReadStream` called on
       `stateJsonPath(`.

   FALSE NEGATIVES (plain reads this does NOT catch):
     - An extracted variable: `const sp = stateJsonPath(d); readFile(sp)` -
       exactly the shape `auto-backup.ts` had before this guard. Only a
       `stateJsonPath(` written inside the reader's own parens is seen.
     - A hand-built path: `join(dir, '.audiobook', 'state.json')` (the file
       name is a string literal, which the tokenizer skips). Today that is
       `routes/samples.ts`, which reads the COMMITTED sample bundles under
       `samples/` (nothing writes them at runtime, so they have no window), and
       `scan.ts`'s own recovering reads.
     - A path list: `workspace/upgrade-coordinator.ts` copies `state.json` by
       name out of `PER_BOOK_BACKUP_FILES` for its pre-migration snapshot.
     - An aliased import (`import { readJson as r }`), or a reader reached
       through a helper this scan cannot follow.
     - `scripts/*.mjs` and anything outside `server/src`.
     - A presence check that is correct on purpose reads the same as a plain
       one; such a site would go on the allowlist with its reason.

   FALSE POSITIVES: none known. Prose and strings quoting a pattern are
   skipped by the tokenizer (tested below).

   Keyed on FILE AND COUNT, both directions, like the write guard. The
   allowlist is empty today. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSourceFiles, computeAstOpaqueRanges, isOpaque, lineOf } from '../test-utils/guard-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/** The files that own the primitives and the recovering read itself. */
const EXEMPT = new Set(['workspace/state-io.ts', 'workspace/state-migrate.ts']);

/* Whitespace-tolerant between the parens so a Prettier-wrapped call is seen. */
const READ_RE = new RegExp(
  [
    String.raw`\breadJson\s*(?:<[^()]*?>)?\s*\(\s*stateJsonPath\(`,
    String.raw`\breadJson\s*<\s*BookStateJson\b`,
    String.raw`\breadJsonWithRecovery\s*(?:<[^()]*?>)?\s*\(\s*stateJsonPath\(`,
    String.raw`\b(?:existsSync|statSync|stat|access|readFile|readFileSync|copyFile|createReadStream)\s*\(\s*stateJsonPath\(`,
  ].join('|'),
  'g',
);

interface ScanResult {
  reads: number;
  details: string[];
}

function scanFile(content: string): ScanResult | null {
  if (!content.includes('stateJsonPath') && !content.includes('BookStateJson')) return null;
  const opaque = computeAstOpaqueRanges(content);
  const details: string[] = [];
  READ_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = READ_RE.exec(content))) {
    if (isOpaque(opaque, m.index)) continue; // prose/string quoting the pattern
    details.push(`plain state.json read @ line ${lineOf(content, m.index)}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  if (details.length === 0) return null;
  return { reads: details.length, details };
}

/* Empty by design: every state.json reader in server/src recovers. A file that
   scans clean must not be listed (the unmatched-key check below fails). */
const ALLOWED_PLAIN = new Map<string, { reads: number; why: string }>([]);

describe('state.json reads go through the recovering read — static guard (#3625 pass 6)', () => {
  it('no plain read of state.json outside state-io.ts / state-migrate.ts, except the pinned allowlist', () => {
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (EXEMPT.has(rel)) continue;
      const result = scanFile(readFileSync(file, 'utf8'));
      if (!result) continue;
      const allowed = ALLOWED_PLAIN.get(rel);
      if (allowed) {
        matchedAllowlistKeys.add(rel);
        if (result.reads !== allowed.reads) {
          problems.push(
            `${rel}: allowlisted for exactly ${allowed.reads} plain read(s) (${allowed.why}), ` +
              `but the scan found ${result.reads}:\n  ` +
              result.details.join('\n  '),
          );
        }
      } else {
        problems.push(
          `${rel}: ${result.reads} plain state.json read(s) — use readStateJsonWithRecovery:\n  ` +
            result.details.join('\n  '),
        );
      }
    }
    for (const [rel, allowed] of ALLOWED_PLAIN) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.reads} plain read(s), but the scan now finds ZERO — ` +
            'update or remove this allowlist entry.',
        );
      }
    }
    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('the scan is real: it reports the plain read the pre-fix voices.ts held (a scan that sees nothing proves nothing)', () => {
    const content = readFileSync(join(SRC_ROOT, 'routes/voices.ts'), 'utf8');
    const reverted = content.replace(/readStateJsonWithRecovery\(/g, 'readJson<BookStateJson>(');
    expect(reverted).not.toBe(content);
    expect(scanFile(reverted)?.reads ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('each plain-read shape is reported', () => {
    const src = [
      'const a = await readJson<BookStateJson>(stateJsonPath(dir));',
      'const b = await readJson(\n  stateJsonPath(dir),\n);',
      'const c = await readJson<BookStateJson>(somePath);',
      'if (!existsSync(stateJsonPath(dir))) return;',
      "const d = await readFile(stateJsonPath(dir), 'utf8');",
      'const e = await readJsonWithRecovery(stateJsonPath(dir), { keep: 3 });',
      'const f = await readJson<{ bookId?: string }>(stateJsonPath(dir));',
    ].join('\n');
    expect(scanFile(src)?.reads, JSON.stringify(scanFile(src))).toBe(7);
  });

  it('the recovering read, the writes, prose and strings are not plain reads', () => {
    const src = [
      'const s = await readStateJsonWithRecovery(stateJsonPath(dir));',
      'await writeStateJsonAtomic(stateJsonPath(dir), s);',
      'await withStateJsonLock(stateJsonPath(dir), async () => {});',
      '// never readJson<BookStateJson>(stateJsonPath(dir)) here',
      "const msg = 'existsSync(stateJsonPath(dir))';",
    ].join('\n');
    expect(scanFile(src)).toBeNull();
  });

});
