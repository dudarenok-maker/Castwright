/* #4034 -- the static guard that stops the queue-mutex invariant (#4029) rotting.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` and parses it (TypeScript AST). Each
   `writeQueueFile(` call -- and each `writeJsonAtomic(queueJsonPath(...), ...)`, the bypass that skips the wrapper --
   must sit inside the callback of a `serializeQueueMutation(...)` call, and THAT callback must also contain a
   `readQueueFile(` call, so the snapshot a write is made from is read inside the span. The old guard counted
   `writeQueueFile` against `serializeQueueMutation` per file, which a read hoisted above its span (or a write moved
   out of one while another span was added) satisfied. Only `queue-boot.ts` is allowlisted: it runs once at boot,
   before any route can mutate the queue.

   FALSE NEGATIVES (not caught): an aliased import (`writeQueueFile as w`); a write reached through a helper
   function called from a span (the helper's own call site is what is checked, so a helper that wraps a write needs
   its own span); a path held in a variable and passed to a bare `writeJsonAtomic`. Span IDENTITY is the module-level
   chain, so there is nothing to mismatch. The read is checked for PRESENCE in the same callback, not for being the
   one the write derives from. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, dirname } from 'node:path';
import * as ts from 'typescript';
import { collectSourceFiles } from '../test-utils/guard-scan.js';

/** Relative (posix) path -> why the file may write the queue outside a span, and how many such writes. */
const ALLOWED: Record<string, { writes: number; reason: string }> = {
  'workspace/queue-boot.ts': {
    writes: 1,
    reason: 'one-shot boot reset of in_progress entries, run before the routes mount and so before any other mutator',
  },
};

const calleeName = (n: ts.CallExpression): string | undefined =>
  ts.isIdentifier(n.expression) ? n.expression.text : undefined;

const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** A bare `writeJsonAtomic(queueJsonPath(...), ...)`. */
function isQueuePathWrite(n: ts.CallExpression): boolean {
  if (calleeName(n) !== 'writeJsonAtomic') return false;
  const first = n.arguments[0];
  return first !== undefined && ts.isCallExpression(first) && calleeName(first) === 'queueJsonPath';
}

function containsCall(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && calleeName(n) === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

interface Violation {
  file: string;
  line: number;
  why: 'no-span' | 'read-outside-span';
}

/** Every queue write under `root` that is not inside a span holding its own read; allowlisted files are exempt by count. */
function scan(root: string, allowed: typeof ALLOWED): { violations: Violation[]; writes: number; allowedSeen: Record<string, number> } {
  const violations: Violation[] = [];
  const allowedSeen: Record<string, number> = {};
  let writes = 0;
  for (const file of collectSourceFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    const sf = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && (calleeName(n) === 'writeQueueFile' || isQueuePathWrite(n))) {
        writes++;
        if (allowed[rel]) {
          allowedSeen[rel] = (allowedSeen[rel] ?? 0) + 1;
        } else {
          /* Nearest enclosing serializeQueueMutation whose callback contains this write. */
          let span: ts.Node | undefined;
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if (isFn(p) && p.parent && ts.isCallExpression(p.parent) && calleeName(p.parent) === 'serializeQueueMutation' && p.parent.arguments[0] === p) {
              span = p;
              break;
            }
          }
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          if (!span) violations.push({ file: rel, line, why: 'no-span' });
          else if (!containsCall(span, 'readQueueFile')) violations.push({ file: rel, line, why: 'read-outside-span' });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { violations, writes, allowedSeen };
}

describe('every .queue.json write sits in a serializeQueueMutation span that holds its read (#4034)', () => {
  it('the real server tree has no violation, and the allowlist matches exactly', () => {
    const serverSrc = join(__dirname, '..');
    const { violations, writes, allowedSeen } = scan(serverSrc, ALLOWED);
    expect(violations).toEqual([]);
    /* Control: the scan found the writers (a scan that matched nothing would pass vacuously). */
    expect(writes).toBeGreaterThanOrEqual(16);
    expect(Object.fromEntries(Object.entries(allowedSeen))).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, v.writes])),
    );
  });

  describe('negative controls: each failing shape is caught in a temp tree', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    function tree(files: Record<string, string>): string {
      const root = mkdtempSync(join(tmpdir(), 'queue-span-guard-'));
      dirs.push(root);
      for (const [name, src] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), src);
      }
      return root;
    }
    const run = (files: Record<string, string>) => scan(tree(files), ALLOWED);

    it('a correct span (read + write inside) passes', () => {
      const r = run({
        'ok.ts': `async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(r.violations).toEqual([]);
      expect(r.writes).toBe(1);
    });

    it('a write with no span at all', () => {
      const r = run({ 'bare.ts': `async function f() { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }` });
      expect(r.violations).toEqual([{ file: 'bare.ts', line: 1, why: 'no-span' }]);
    });

    it('a read hoisted above the span (the span holds only the write)', () => {
      const r = run({
        'hoisted.ts': `async function f() { const b = await readQueueFile(p()); await serializeQueueMutation(async () => { await writeQueueFile(p(), b); }); }`,
      });
      expect(r.violations).toEqual([{ file: 'hoisted.ts', line: 1, why: 'read-outside-span' }]);
    });

    it('a write in a nested span whose read is only in the outer span', () => {
      const r = run({
        'nested.ts': `async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await serializeQueueMutation(async () => { await writeQueueFile(p(), b); }); }); }`,
      });
      expect(r.violations.map((v) => v.why)).toEqual(['read-outside-span']);
    });

    it('a write in a span callback that is not the span (a sibling argument or a later callback)', () => {
      const r = run({
        'sibling.ts': `async function f() { await serializeQueueMutation(async () => { await readQueueFile(p()); }); const g = async () => { await writeQueueFile(p(), x); }; }`,
      });
      expect(r.violations.map((v) => v.why)).toEqual(['no-span']);
    });

    it('a bare writeJsonAtomic(queueJsonPath()) bypassing the wrapper, in and out of a span', () => {
      const r = run({
        'bypass.ts': `async function f() { await writeJsonAtomic(queueJsonPath(), {}); }`,
        'bypass2.ts': `async function f() { await serializeQueueMutation(async () => { await writeJsonAtomic(queueJsonPath(), {}); }); }`,
      });
      expect(r.violations.map((v) => `${v.file}:${v.why}`).sort()).toEqual(['bypass.ts:no-span', 'bypass2.ts:read-outside-span']);
    });

    it('text in a comment or string is not a write; a *.test.ts file is not scanned', () => {
      const r = run({
        'prose.ts': `// writeQueueFile(p, x)\nconst s = 'writeQueueFile(p, x)';`,
        'thing.test.ts': `writeQueueFile(p, x);`,
      });
      expect(r).toEqual({ violations: [], writes: 0, allowedSeen: {} });
    });

    it('an allowlisted file is exempt, but only for its recorded count', () => {
      const r = run({ 'workspace/queue-boot.ts': `await writeQueueFile(p, a); await writeQueueFile(p, b);` });
      expect(r.violations).toEqual([]);
      expect(r.allowedSeen).toEqual({ 'workspace/queue-boot.ts': 2 });
      expect(r.allowedSeen['workspace/queue-boot.ts']).not.toBe(ALLOWED['workspace/queue-boot.ts'].writes);
    });
  });
});
