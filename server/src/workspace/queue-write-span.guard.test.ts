/* #4034 -- the static guard that stops the queue-mutex invariant (#4029) rotting.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` and parses it (TypeScript AST). Each queue write
   -- `writeQueueFile(`, `writeJsonAtomic(queueJsonPath(...), ...)`, or an fs `writeFile`/`rm`/`rename`/... naming
   `queueJsonPath()`, bare or through a namespace (`qm.writeQueueFile`) -- must sit directly in the callback of a
   `serializeQueueMutation(...)` call (not in a nested function, not behind `void`, not a bare un-awaited statement),
   THAT callback must contain a `readQueueFile(` call, and a `writeQueueFile`/`writeJsonAtomic` write must be made from
   a value derived (by variable data-flow inside the callback) from such a read, so it is the span's own snapshot and not
   one hoisted above it. `serializeQueueMutation` must have exactly ONE declaration (`workspace/queue-mutex.ts`), and
   every caller must import it un-aliased from that module: a private chain of the same name is the #4029 defect class
   itself. Only `queue-boot.ts` is allowlisted: it runs once at boot, before any route can mutate the queue.

   A write must be awaited or returned (`await w(...)`, `return w(...)`, an arrow's concise body): a stored, chained,
   `&&`-ed or `Promise.all`-ed promise can outlive the span, so it is `unawaited-write`.

   NEVER NEST A SPAN. `serializeQueueMutation` inside a span waits on its own tail and wedges the chain for the whole
   process (pinned at runtime below). A helper whose write is flagged `no-span` must NOT be given its own span when a
   span calls it: keep the write in the caller's span and pass the snapshot in. `nested-span` flags a span call whose
   ancestors include a span callback, and ANY reference from inside a span to a same-file span helper -- a function
   (declaration, arrow, wrapped arrow, object-literal method) that (transitively) opens a span: a call, a callback
   (`ids.map(h)`) or a method call (`o.h()`, matched by method name alone). A helper that opens a span and is
   referenced from a span in ANOTHER file is not seen (no call graph).

   FALSE NEGATIVES (not caught): an aliased `writeQueueFile as w` (the alias call is invisible; an aliased
   `serializeQueueMutation` import IS flagged); a path held in a variable and passed to a bare `writeJsonAtomic`/fs call;
   an fs writer outside the set below; a data-flow that launders the snapshot through a property, a closure, a function
   parameter or a reassignment (the check follows `const`/`let` initialisers by name, not values), or a hoisted snapshot
   whose name is re-declared inside the span (the inner declaration shadows it); `open(queueJsonPath(), 'r')` is NOT a
   write, but `open` with any other mode is. A `serializeQueueMutation` bound by a parameter or destructuring counts as
   a second declaration, but a `serializeQueueMutation` reached through a property of another object is not seen. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, dirname, resolve } from 'node:path';
import * as ts from 'typescript';
import { collectSourceFiles, lineOf } from '../test-utils/guard-scan.js';

/** Relative (posix) path -> why the file may write the queue outside a span, and how many such writes. */
const ALLOWED: Record<string, { writes: number; reason: string }> = {
  'workspace/queue-boot.ts': {
    writes: 1,
    reason:
      'one-shot boot reset of in_progress entries; the sweep is awaited before the server listens (index.ts), so no route can mutate the queue until it has finished',
  },
};

const SPAN_FN = 'serializeQueueMutation';
const SPAN_MODULE = 'workspace/queue-mutex.ts';
/** fs verbs that mutate (write, remove, rename over) their path arguments. */
const FS_WRITERS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rm',
  'rmSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'truncate',
  'truncateSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'open',
  'openSync',
  'createWriteStream',
  'writeJsonAtomic',
  'writeJsonAtomicOrdered',
  'enqueuePathOp',
]);

/** `f(...)` -> `f`; `ns.f(...)` -> `f`. */
const calleeName = (n: ts.CallExpression): string | undefined =>
  ts.isIdentifier(n.expression)
    ? n.expression.text
    : ts.isPropertyAccessExpression(n.expression)
      ? n.expression.name.text
      : undefined;

const isFnLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

const isQueuePathCall = (a: ts.Node): boolean => ts.isCallExpression(a) && calleeName(a) === 'queueJsonPath';

/** A queue write: `writeQueueFile(...)`, or an fs verb with `queueJsonPath()` among its arguments. */
function isQueueWrite(n: ts.CallExpression): boolean {
  const name = calleeName(n);
  if (name === 'writeQueueFile') return true;
  if (name === undefined || !FS_WRITERS.has(name) || !n.arguments.some(isQueuePathCall)) return false;
  /* `open(queueJsonPath(), 'r')` only reads. */
  const mode = n.arguments[1];
  return !((name === 'open' || name === 'openSync') && mode && ts.isStringLiteral(mode) && mode.text === 'r');
}

/** Writes that carry a snapshot (so the data-flow check applies); `rm`/`rename` carry none. */
const carriesSnapshot = (n: ts.CallExpression): boolean =>
  ['writeQueueFile', 'writeJsonAtomic', 'writeJsonAtomicOrdered'].includes(calleeName(n) ?? '');

/** The write's promise is awaited or returned, so it settles inside the span. */
function isAwaitedOrReturned(n: ts.CallExpression): boolean {
  let c: ts.Node = n;
  while (ts.isParenthesizedExpression(c.parent)) c = c.parent;
  const p = c.parent;
  return ts.isAwaitExpression(p) || ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === c);
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

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, out);
}

/** Does `root` reference (as an identifier, not as a property name) one of `names`? */
function mentions(root: ts.Node, names: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      const propertyName =
        (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
      if (!propertyName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/** Identifiers declared under `root` (skipping the subtree `skip`) bound from a `readQueueFile` result, directly or through another such binding (to a fixpoint). */
function snapshotNames(root: ts.Node, skip?: ts.Node): Set<string> {
  const decls: ts.VariableDeclaration[] = [];
  const collect = (n: ts.Node): void => {
    if (n === skip) return;
    if (ts.isVariableDeclaration(n) && n.initializer) decls.push(n);
    ts.forEachChild(n, collect);
  };
  collect(root);
  const tainted = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of decls) {
      const init = d.initializer as ts.Expression;
      if (!(containsCall(init, 'readQueueFile') || mentions(init, tainted))) continue;
      const names: string[] = [];
      bindingNames(d.name, names);
      for (const nm of names) {
        if (!tainted.has(nm)) {
          tainted.add(nm);
          grew = true;
        }
      }
    }
  }
  return tainted;
}

type Why =
  | 'no-span'
  | 'read-outside-span'
  | 'stale-snapshot'
  | 'deferred-write'
  | 'unawaited-write'
  | 'nested-span'
  | 'bad-span-import';

/** Every name declared (variable or parameter) anywhere under `root`. */
function declaredNames(root: ts.Node): Set<string> {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && n.name) bindingNames(n.name, out);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return new Set(out);
}

interface Violation {
  file: string;
  line: number;
  why: Why;
}

/** `serializeQueueMutation` bindings in one file: is the bare name a valid (un-aliased, from queue-mutex) import, and which namespaces are. */
function spanBindings(
  sf: ts.SourceFile,
  file: string,
  root: string,
  onBad: (n: ts.Node) => void,
): { bare: boolean; ns: Set<string> } {
  const out = { bare: false, ns: new Set<string>() };
  const mutexJs = resolve(root, SPAN_MODULE.replace(/\.ts$/, '.js'));
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const fromMutex = spec.startsWith('.') && resolve(dirname(file), spec) === mutexJs;
    const nb = st.importClause?.namedBindings;
    if (!nb) continue;
    if (ts.isNamespaceImport(nb)) {
      if (fromMutex) out.ns.add(nb.name.text);
      continue;
    }
    for (const el of nb.elements) {
      if ((el.propertyName ?? el.name).text !== SPAN_FN) continue;
      if (fromMutex && !el.propertyName) out.bare = true;
      else onBad(el);
    }
  }
  return out;
}

/** Every queue write under `root` that is not inside a span holding its own read; allowlisted files are exempt by count. */
function scan(
  root: string,
  allowed: typeof ALLOWED,
): { violations: Violation[]; writes: number; allowedSeen: Record<string, number>; declarations: string[] } {
  const violations: Violation[] = [];
  const allowedSeen: Record<string, number> = {};
  const declarations: string[] = [];
  let writes = 0;
  for (const file of collectSourceFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    const text = ts.sys.readFile(file) ?? '';
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineAt = (n: ts.Node): number => lineOf(text, n.getStart(sf));
    const bindings = spanBindings(sf, file, root, (n) =>
      violations.push({ file: rel, line: lineAt(n), why: 'bad-span-import' }),
    );
    const isSpanCall = (c: ts.CallExpression): boolean =>
      calleeName(c) === SPAN_FN &&
      (ts.isIdentifier(c.expression)
        ? bindings.bare
        : ts.isPropertyAccessExpression(c.expression) &&
          ts.isIdentifier(c.expression.expression) &&
          bindings.ns.has(c.expression.expression.text));
    /** `p` is the callback (first argument) of a valid span call. */
    const isSpanCallback = (p: ts.Node): boolean =>
      isFn(p) && ts.isCallExpression(p.parent) && isSpanCall(p.parent) && p.parent.arguments[0] === p;
    const insideSpan = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (isSpanCallback(p)) return true;
      return false;
    };
    /* Same-file functions that open a span, directly or through another such function (to a fixpoint). Any REFERENCE to
       one from inside a span nests a span: a call, a callback (`ids.map(h)`), a method call (`o.h()`, matched by name).
       A helper is a function declaration, a variable whose initializer holds a function that opens a span (an arrow, or
       a wrapper such as `logged(async () => ...)`), or an object-literal method/property of that shape. */
    const declName = (f: ts.Node): string | undefined =>
      (ts.isFunctionDeclaration(f) ||
        ts.isVariableDeclaration(f) ||
        ts.isPropertyAssignment(f) ||
        ts.isMethodDeclaration(f)) &&
      f.name &&
      ts.isIdentifier(f.name)
        ? f.name.text
        : undefined;
    const spanHelpers = new Set<string>();
    /** `id` names a span helper and is a use of it, not the declaration of it. */
    const isHelperRef = (id: ts.Node): boolean => {
      if (!ts.isIdentifier(id) || !spanHelpers.has(id.text)) return false;
      const p = id.parent;
      return !(
        (ts.isFunctionDeclaration(p) ||
          ts.isVariableDeclaration(p) ||
          ts.isPropertyAssignment(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p)) &&
        p.name === id
      );
    };
    const hasSpan = (root: ts.Node): boolean => {
      let found = false;
      const walk = (n: ts.Node): void => {
        if (found) return;
        if ((ts.isCallExpression(n) && isSpanCall(n)) || isHelperRef(n)) {
          found = true;
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(root);
      return found;
    };
    /** A FUNCTION under `root` (or `root` itself) opens a span: a span evaluated at declaration time is a result, not a helper. */
    const opensSpan = (root: ts.Node): boolean => {
      let found = false;
      const walk = (n: ts.Node): void => {
        if (found) return;
        if (isFnLike(n) && hasSpan(n)) {
          found = true;
          return;
        }
        ts.forEachChild(n, walk);
      };
      walk(root);
      return found;
    };
    for (let grew = true; grew; ) {
      grew = false;
      const find = (n: ts.Node): void => {
        const nm = declName(n);
        if (nm && !spanHelpers.has(nm) && opensSpan(n)) {
          spanHelpers.add(nm);
          grew = true;
        }
        ts.forEachChild(n, find);
      };
      find(sf);
    }
    const visit = (n: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(n) && n.name?.text === SPAN_FN) ||
        (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === SPAN_FN) ||
        ((ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.name.text === SPAN_FN)
      ) {
        declarations.push(rel);
      }
      if (((ts.isCallExpression(n) && isSpanCall(n)) || isHelperRef(n)) && insideSpan(n)) {
        violations.push({ file: rel, line: lineAt(n), why: 'nested-span' });
      }
      if (ts.isCallExpression(n) && isQueueWrite(n)) {
        writes++;
        if (allowed[rel]) {
          allowedSeen[rel] = (allowedSeen[rel] ?? 0) + 1;
        } else {
          /* The nearest enclosing function must itself be a span callback; a write in a deeper function inside a
             span is deferred (it can run after the span settles), and one in no span at all is unspanned. */
          let span: ts.Node | undefined;
          let nested = false;
          for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
            if (!isFnLike(p)) continue;
            if (isSpanCallback(p)) span = p;
            else nested = true;
            break;
          }
          if (nested) {
            for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
              if (isSpanCallback(p)) {
                span = p;
                break;
              }
            }
          }
          const line = lineAt(n);
          if (!span) violations.push({ file: rel, line, why: 'no-span' });
          else if (nested) violations.push({ file: rel, line, why: 'deferred-write' });
          else if (!isAwaitedOrReturned(n)) {
            violations.push({ file: rel, line, why: 'unawaited-write' });
          } else if (!containsCall(span, 'readQueueFile')) {
            violations.push({ file: rel, line, why: 'read-outside-span' });
          } else if (carriesSnapshot(n)) {
            const names = snapshotNames(span);
            /* A snapshot hoisted above the span: bound from a read in the enclosing function, and not re-declared in the span. */
            let scope: ts.Node = sf;
            for (let p: ts.Node | undefined = span.parent; p; p = p.parent) {
              if (isFnLike(p)) {
                scope = p;
                break;
              }
            }
            const inner = declaredNames(span);
            const stale = new Set([...snapshotNames(scope, span)].filter((s) => !inner.has(s)));
            const args = n.arguments.filter((a) => !isQueuePathCall(a));
            const carried = args.some((a) => containsCall(a, 'readQueueFile') || mentions(a, names));
            if (!carried || args.some((a) => mentions(a, stale))) {
              violations.push({ file: rel, line, why: 'stale-snapshot' });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { violations, writes, allowedSeen, declarations };
}

describe('every .queue.json write sits in a serializeQueueMutation span that holds its read (#4034)', () => {
  it('the real server tree has no violation, and the allowlist matches exactly', () => {
    const serverSrc = join(__dirname, '..');
    const { violations, writes, allowedSeen, declarations } = scan(serverSrc, ALLOWED);
    expect(violations).toEqual([]);
    /* Control: the scan found the writers (a scan that matched nothing would pass vacuously). */
    expect(writes).toBeGreaterThanOrEqual(16);
    expect(Object.fromEntries(Object.entries(allowedSeen))).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, v.writes])),
    );
    /* One chain, one declaration: a second `serializeQueueMutation` is a second, private chain. */
    expect(declarations).toEqual([SPAN_MODULE]);
  });

  it('why `nested-span` exists: a span awaited inside a span waits on its own tail and wedges the chain', async () => {
    vi.resetModules();
    const m = await import('./queue-mutex.js');
    const settled = (p: Promise<unknown>) =>
      Promise.race([p.then(() => 'settled'), new Promise<string>((r) => setTimeout(() => r('timeout'), 150))]);
    expect(await settled(m.serializeQueueMutation(async () => 'flat'))).toBe('settled');
    expect(await settled(m.serializeQueueMutation(async () => m.serializeQueueMutation(async () => 'inner')))).toBe(
      'timeout',
    );
    /* Wedged for good: an unrelated later span never runs either. */
    expect(await settled(m.serializeQueueMutation(async () => 'later'))).toBe('timeout');
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
    const IMPORT = `import { serializeQueueMutation } from '../workspace/queue-mutex.js';\n`;
    const whys = (r: ReturnType<typeof scan>) => r.violations.map((v) => v.why);

    it('a correct span (read + write inside) passes', () => {
      const r = run({
        'routes/ok.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); const a = mutate(b); await writeQueueFile(p(), a); }); }`,
      });
      expect(r.violations).toEqual([]);
      expect(r.writes).toBe(1);
    });

    it('a write with no span at all', () => {
      const r = run({
        'bare.ts': `async function f() { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }`,
      });
      expect(r.violations).toEqual([{ file: 'bare.ts', line: 1, why: 'no-span' }]);
    });

    it('a read hoisted above the span (the span holds only the write)', () => {
      const r = run({
        'routes/hoisted.ts':
          IMPORT +
          `async function f() { const b = await readQueueFile(p()); await serializeQueueMutation(async () => { await writeQueueFile(p(), b); }); }`,
      });
      expect(r.violations).toEqual([{ file: 'routes/hoisted.ts', line: 2, why: 'read-outside-span' }]);
    });

    it('a write made from an outer snapshot while an unrelated read sits in the span (the data-flow check)', () => {
      const r = run({
        'routes/stale.ts':
          IMPORT +
          `async function f(id: string) { const before = await readQueueFile(p());
            await serializeQueueMutation(async () => { const fresh = await readQueueFile(p()); if (!fresh.entries.some((e) => e.id === id)) return;
              await writeQueueFile(p(), completeEntry(before, id, 'done')); }); }`,
      });
      expect(whys(r)).toEqual(['stale-snapshot']);
    });

    it('a write derived from the in-span read, through a derived binding, passes', () => {
      const r = run({
        'routes/derived.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(async () => { const { entries } = await readQueueFile(p()); const a = { entries }; await writeQueueFile(p(), a); }); }`,
      });
      expect(r.violations).toEqual([]);
    });

    it('a write in a nested span whose read is only in the outer span', () => {
      const r = run({
        'routes/nested.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await serializeQueueMutation(async () => { await writeQueueFile(p(), b); }); }); }`,
      });
      expect(whys(r).sort()).toEqual(['nested-span', 'read-outside-span']);
    });

    it('a span nested lexically in a span is nested-span, even with its own read', () => {
      const r = run({
        'routes/nested-lexical.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); if (b.paused) return; await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), c); }); }); }`,
      });
      expect(whys(r)).toEqual(['nested-span']);
    });

    it('a same-file helper that opens its own span, called from a span, is nested-span (directly and through another helper)', () => {
      const r = run({
        'routes/nested-helper.ts':
          IMPORT +
          `async function markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); }
          const viaArrow = async (id: string) => { await markDone(id); };
          export async function f(id: string) { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); if (b.paused) return; await viaArrow(id); }); }`,
      });
      expect(whys(r)).toEqual(['nested-span']);
      /* The same helper called outside any span is fine. */
      const ok = run({
        'routes/helper-ok.ts':
          IMPORT +
          `async function markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); }
          export async function f(id: string) { await markDone(id); }`,
      });
      expect(ok.violations).toEqual([]);
    });

    it('a span helper REFERENCED inside a span is nested-span: passed by reference, as a method, wrapped, or declared after its caller', () => {
      const helperBody = `async (id: string) => { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); }`;
      const caller = (call: string) =>
        `export async function f(ids: string[], id: string) { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); if (b.paused) return; ${call} }); }`;
      const r = run({
        'routes/by-ref.ts': IMPORT + `async function markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); }\n` + caller('await Promise.all(ids.map(markDone));'),
        'routes/method.ts': IMPORT + `const h = { async markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); } };\n` + caller('await h.markDone(id);'),
        /* A class is not itself a helper, so only the METHOD's name can catch this one. */
        'routes/class-method.ts': IMPORT + `class H { async markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); } }
` + caller('await new H().markDone(id);'),
        'routes/prop-fn.ts': IMPORT + `const h = { markDone: ${helperBody} };\n` + caller('await h.markDone(id);'),
        'routes/wrapped.ts': IMPORT + `const markDone = logged(${helperBody});\n` + caller('await markDone(id);'),
        /* The caller is declared BEFORE the chain markDone <- viaArrow, so a single pass would miss it. */
        'routes/reversed.ts':
          IMPORT +
          `const viaArrow = async (id: string) => { await markDone(id); };\nasync function markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); }\n` +
          caller('await viaArrow(id);'),
        'routes/after-caller.ts':
          IMPORT + caller('await markDone(id);') + `\nasync function markDone(id: string) { await serializeQueueMutation(async () => { const c = await readQueueFile(p()); await writeQueueFile(p(), done(c, id)); }); }\n`,
      });
      /* (`h.markDone(id)` reports both `h` and `markDone`, hence the Set.) */
      expect([...new Set(r.violations.map((v) => `${v.file}:${v.why}`))].sort()).toEqual([
        'routes/after-caller.ts:nested-span',
        'routes/by-ref.ts:nested-span',
        'routes/class-method.ts:nested-span',
        'routes/method.ts:nested-span',
        'routes/prop-fn.ts:nested-span',
        'routes/reversed.ts:nested-span',
        'routes/wrapped.ts:nested-span',
      ]);
      /* A variable merely HOLDING a span's result is not a helper. */
      const ok = run({
        'routes/result.ts':
          IMPORT +
          `export async function f() { const res = await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); return 1; });
          await serializeQueueMutation(async () => { const b = await readQueueFile(p()); use(res); await writeQueueFile(p(), b); }); }`,
      });
      expect(ok.violations).toEqual([]);
    });

    it('a write in a function that is not the span callback (a later callback)', () => {
      const r = run({
        'routes/later.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(async () => { await readQueueFile(p()); }); const g = async () => { await writeQueueFile(p(), x); }; }`,
      });
      expect(whys(r)).toEqual(['no-span']);
    });

    it('the span callback must be the FIRST argument of the span call (a sibling argument is not the span)', () => {
      const r = run({
        'routes/sibling-arg.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(noop, async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(whys(r)).toEqual(['no-span']);
    });

    it('a callback wrapped in another call is not the span callback (the span argument must itself be the function)', () => {
      const r = run({
        'routes/wrapped.ts':
          IMPORT +
          `async function f() { await serializeQueueMutation(wrap(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); })); }`,
      });
      expect(whys(r)).toEqual(['no-span']);
    });

    it('a callback of a different call is not a span (only serializeQueueMutation callbacks count)', () => {
      const r = run({
        'routes/other-call.ts':
          IMPORT + `async function f() { await somethingElse(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(whys(r)).toEqual(['no-span']);
    });

    it('a function-declaration span argument is not a span callback (only an arrow / function expression)', () => {
      const r = run({
        'routes/decl-arg.ts':
          IMPORT +
          `async function f() { async function cb() { const b = await readQueueFile(p()); await writeQueueFile(p(), b); } await serializeQueueMutation(cb); }`,
      });
      expect(whys(r)).toEqual(['no-span']);
    });

    it('a bare writeJsonAtomic(queueJsonPath()) bypassing the wrapper, in and out of a span', () => {
      const r = run({
        'bypass.ts': `async function f() { await writeJsonAtomic(queueJsonPath(), {}); }`,
        'routes/bypass2.ts': IMPORT + `async function f() { await serializeQueueMutation(async () => { await writeJsonAtomic(queueJsonPath(), {}); }); }`,
      });
      expect(r.violations.map((v) => `${v.file}:${v.why}`).sort()).toEqual([
        'bypass.ts:no-span',
        'routes/bypass2.ts:read-outside-span',
      ]);
    });

    it('a local private chain with the same name is not the span (and is a second declaration)', () => {
      const r = run({
        'routes/private-chain.ts': `let chain: Promise<unknown> = Promise.resolve();
          function serializeQueueMutation<T>(m: () => Promise<T>): Promise<T> { const n = chain.then(m, m); chain = n.catch(() => undefined); return n; }
          export async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(whys(r)).toEqual(['no-span']);
      expect(r.declarations).toEqual(['routes/private-chain.ts']);
    });

    it('serializeQueueMutation imported from another module, or aliased, is not the span', () => {
      const r = run({
        'routes/other-module.ts': `import { serializeQueueMutation } from './my-own-chain.js';
          export async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
        'routes/aliased.ts': `import { serializeQueueMutation as s } from '../workspace/queue-mutex.js';
          export async function f() { await s(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(r.violations.map((v) => `${v.file}:${v.why}`).sort()).toEqual([
        'routes/aliased.ts:bad-span-import',
        'routes/aliased.ts:no-span',
        'routes/other-module.ts:bad-span-import',
        'routes/other-module.ts:no-span',
      ]);
    });

    it('a namespace import of ANOTHER module is not the span, even though the call name matches', () => {
      const r = run({
        'routes/ns-other.ts': `import * as c from './my-chain.js';
          export async function f() { await c.serializeQueueMutation(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(whys(r)).toEqual(['no-span']);
    });

    it('a const serializeQueueMutation in a file that also imports the real one is a second declaration', () => {
      const r = run({
        'routes/shadow.ts':
          IMPORT +
          `export async function f() { const serializeQueueMutation = (m: () => Promise<unknown>) => m(); await serializeQueueMutation(async () => { const b = await readQueueFile(p()); await writeQueueFile(p(), b); }); }`,
      });
      expect(r.declarations).toEqual(['routes/shadow.ts']);
    });

    it('a parameter or destructured binding named serializeQueueMutation is a declaration too', () => {
      const r = run({
        'routes/param.ts': IMPORT + `export function g(serializeQueueMutation: unknown) { return serializeQueueMutation; }`,
        'routes/destructured.ts': IMPORT + `export const { serializeQueueMutation: _x, serializeQueueMutation } = makeChain();`,
      });
      expect(r.declarations.sort()).toEqual(['routes/destructured.ts', 'routes/param.ts']);
    });

    it('a write whose promise is stored, short-circuited, collected or chained is unawaited; a returned one is fine', () => {
      const body = (w: string) =>
        IMPORT +
        `export async function f(c: boolean) { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); ${w} }); }`;
      const r = run({
        'routes/stored.ts': body(`const w = writeQueueFile(p(), b);`),
        'routes/and.ts': body(`c && writeQueueFile(p(), b);`),
        'routes/all.ts': body(`Promise.all([writeQueueFile(p(), b)]);`),
        'routes/then.ts': body(`await writeQueueFile(p(), b).then(noop);`),
        'routes/returned.ts': body(`return writeQueueFile(p(), b);`),
      });
      expect(r.violations.map((v) => `${v.file}:${v.why}`).sort()).toEqual([
        'routes/all.ts:unawaited-write',
        'routes/and.ts:unawaited-write',
        'routes/stored.ts:unawaited-write',
        'routes/then.ts:unawaited-write',
      ]);
    });

    it('writeJsonAtomicOrdered, cp, open, createWriteStream and enqueuePathOp on queueJsonPath() are writes; a read-mode open is not', () => {
      const r = run({
        'routes/writers.ts': `export async function f() {
          await writeJsonAtomicOrdered(queueJsonPath(), b); await cp(x, queueJsonPath()); await open(queueJsonPath(), 'w');
          createWriteStream(queueJsonPath()); await enqueuePathOp(queueJsonPath(), fn); await open(queueJsonPath(), 'r'); }`,
      });
      expect(r.writes).toBe(5);
      expect(whys(r)).toEqual(['no-span', 'no-span', 'no-span', 'no-span', 'no-span']);
    });

    it('a property NAME that matches a hoisted snapshot is not a reference to it', () => {
      const r = run({
        'routes/propname.ts':
          IMPORT +
          `export async function f() { const before = await readQueueFile(p());
            await serializeQueueMutation(async () => { const { paused } = await readQueueFile(p()); if (paused) return;
              await writeQueueFile(p(), { ...other, before: paused }); }); }`,
      });
      expect(r.violations).toEqual([]);
      const stale = run({
        'routes/propname-stale.ts':
          IMPORT +
          `export async function f() { await serializeQueueMutation(async () => { const { paused } = await readQueueFile(p()); if (paused) return;
              await writeQueueFile(p(), { ...other, paused: true }); }); }`,
      });
      expect(whys(stale)).toEqual(['stale-snapshot']);
      /* ...nor is a property ACCESS of an unrelated object that happens to share the name (`o.paused`). */
      const access = run({
        'routes/propaccess.ts':
          IMPORT +
          `export async function f(o: { paused: boolean }) { await serializeQueueMutation(async () => { const { paused } = await readQueueFile(p()); if (paused) return;
              await writeQueueFile(p(), setPaused(o.paused)); }); }`,
      });
      expect(whys(access)).toEqual(['stale-snapshot']);
    });

    it('writeJsonAtomicOrdered carries a snapshot too: one made from a hoisted read is stale', () => {
      const r = run({
        'routes/ordered-stale.ts':
          IMPORT +
          `export async function f(id: string) { const before = await readQueueFile(queueJsonPath());
            await serializeQueueMutation(async () => { const fresh = await readQueueFile(queueJsonPath()); if (!fresh.entries.length) return;
              await writeJsonAtomicOrdered(queueJsonPath(), completeEntry(before, id, 'done')); }); }`,
      });
      expect(whys(r)).toEqual(['stale-snapshot']);
    });

    it('a name re-declared from a fresh read inside the span shadows the hoisted one (documented limit)', () => {
      const r = run({
        'routes/shadowed.ts':
          IMPORT +
          `export async function f() { const before = await readQueueFile(p());
            await serializeQueueMutation(async () => { const before = await readQueueFile(p()); await writeQueueFile(p(), before); }); }`,
      });
      expect(r.violations).toEqual([]);
    });

    it('a write argument mixing the fresh read with a hoisted snapshot is stale', () => {
      const r = run({
        'routes/mixed.ts':
          IMPORT +
          `export async function f(idx: number) { const before = await readQueueFile(p());
            await serializeQueueMutation(async () => { const fresh = await readQueueFile(p()); const i = fresh.entries.length;
              await writeQueueFile(p(), removeAt(before, i)); }); }`,
      });
      expect(whys(r)).toEqual(['stale-snapshot']);
    });

    it('a namespace import of queue-mutex is a span; a namespace write is still a write', () => {
      const r = run({
        'routes/ns-ok.ts': `import * as qm from '../workspace/queue-mutex.js'; import * as qs from '../workspace/queue-migrate.js';
          export async function f() { await qm.serializeQueueMutation(async () => { const b = await qs.readQueueFile(p()); await qs.writeQueueFile(p(), b); }); }`,
        'routes/ns-bare.ts': `import * as qs from '../workspace/queue-migrate.js';
          export async function f() { const b = await qs.readQueueFile(p()); await qs.writeQueueFile(p(), b); }`,
      });
      expect(r.writes).toBe(2);
      expect(r.violations.map((v) => `${v.file}:${v.why}`)).toEqual(['routes/ns-bare.ts:no-span']);
    });

    it('a void-ed or bare un-awaited write inside the span (the span settles before the write lands)', () => {
      const r = run({
        'routes/void.ts':
          IMPORT +
          `export async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); void writeQueueFile(p(), b); }); }`,
        'routes/floating.ts':
          IMPORT +
          `export async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); writeQueueFile(p(), b); }); }`,
      });
      expect(r.violations.map((v) => `${v.file}:${v.why}`).sort()).toEqual([
        'routes/floating.ts:unawaited-write',
        'routes/void.ts:unawaited-write',
      ]);
    });

    it('a write deferred by a nested function inside the span (setTimeout)', () => {
      const r = run({
        'routes/timer.ts':
          IMPORT +
          `export async function f() { await serializeQueueMutation(async () => { const b = await readQueueFile(p()); setTimeout(() => { void writeQueueFile(p(), b); }, 5); }); }`,
      });
      expect(whys(r)).toEqual(['deferred-write']);
    });

    it('an fs writeFile / rm / rename on queueJsonPath() is a write too', () => {
      const r = run({
        'routes/fs.ts': `import { writeFile, rm } from 'node:fs/promises'; import * as fsp from 'node:fs/promises';
          export async function f() { await writeFile(queueJsonPath(), '{}'); await rm(queueJsonPath(), { force: true }); await fsp.rename('x.tmp', queueJsonPath()); }`,
      });
      expect(r.writes).toBe(3);
      expect(whys(r)).toEqual(['no-span', 'no-span', 'no-span']);
    });

    it('text in a comment or string is not a write; a *.test.ts file is not scanned', () => {
      const r = run({
        'prose.ts': `// writeQueueFile(p, x)\nconst s = 'writeQueueFile(p, x)';`,
        'thing.test.ts': `writeQueueFile(p, x);`,
      });
      expect(r).toEqual({ violations: [], writes: 0, allowedSeen: {}, declarations: [] });
    });

    it('an allowlisted file is exempt, but only for its recorded count', () => {
      const r = run({ 'workspace/queue-boot.ts': `await writeQueueFile(p, a); await writeQueueFile(p, b);` });
      expect(r.violations).toEqual([]);
      expect(r.allowedSeen).toEqual({ 'workspace/queue-boot.ts': 2 });
      expect(r.allowedSeen['workspace/queue-boot.ts']).not.toBe(ALLOWED['workspace/queue-boot.ts'].writes);
    });
  });
});
