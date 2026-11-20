/* #1393 / plan 293 §5.0 — guard G2: a deliberately SYNTACTIC guard on literal
   `/qwen/design-voice` and `/qwen/mint-variant` sidecar requests.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` and parses
   it with the TypeScript parser. Comments are not AST nodes, so a path named
   only in a comment never counts. Every string / template literal whose text
   contains either path is a "design-path literal", and three rules apply:

     1. A design-path literal may appear, as code, only in the allowlisted files
        `tts/design-voice-core.ts` and `routes/qwen-voice.ts`.
     2. In `routes/qwen-voice.ts` each such literal must be an argument of a
        `postDesignAndCache(` call, and that wrapper's body must call
        `postDesignAndCacheAudition`. In `tts/design-voice-core.ts` it must be an
        argument (or sit inside the object argument) of a
        `postDesignAndCacheAudition(` call.
     3. In the allowlisted files `postDesignAndCacheAudition` is the only function
        whose body issues a `fetch` / `undiciFetch`: no such call in either file
        takes a design-path literal as its URL, and in `design-voice-core.ts`
        every `fetch` / `undiciFetch` call sits inside
        `postDesignAndCacheAudition`'s body.

   BLIND SPOTS (verbatim from plan §5.0 — this guard CANNOT see these):
     - a computed path (`${sidecarUrl}/${slot}/mint-variant`, as
       `derive-engine-artifact.ts` builds its own);
     - a shared path constant imported from elsewhere;
     - a new direct `undiciFetch` inside an allowlisted file that takes its URL
       from a variable;
     - anything call-graph-shaped (a new caller of an uncounted helper adds no
       literal).
   G1 (#4553, #4554) is the BEHAVIOURAL check; G2 only stops the cheapest
   regression: a new literal request added outside the counted path.

   Mutation-proof: `scanDesignTransport` is a pure function over
   `{ file, content }`, and the tests below feed it synthetic sources for each
   rule, so the guard is shown able to fail (and to stay green on comments). */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  collectSourceFiles,
  parseGuardSource,
  resolvedCallName,
} from '../test-utils/guard-scan.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORE_FILE = 'tts/design-voice-core.ts';
const ROUTE_FILE = 'routes/qwen-voice.ts';
const ALLOWLIST = new Set([CORE_FILE, ROUTE_FILE]);

const DESIGN_PATHS = ['/qwen/design-voice', '/qwen/mint-variant'];
const SINK = 'postDesignAndCacheAudition';
const WRAPPER = 'postDesignAndCache';
const FETCH_NAMES = new Set(['fetch', 'undiciFetch']);

export interface SourceFile {
  /** Path relative to `server/src`, forward slashes. */
  file: string;
  content: string;
}

function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    return n.head.text + n.templateSpans.map((s) => s.literal.text).join('');
  }
  return null;
}

function hasDesignPath(text: string): boolean {
  return DESIGN_PATHS.some((p) => text.includes(p));
}

/** Every outermost design-path literal under `root` (template spans included). */
function designLiterals(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    const t = literalText(n);
    if (t !== null && hasDesignPath(t)) {
      out.push(n);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function containsDesignLiteral(n: ts.Node): boolean {
  return designLiterals(n).length > 0;
}

/** True when `node` lies inside an argument of a call named `callee`. */
function insideCallTo(node: ts.Node, callee: string): ts.CallExpression | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && resolvedCallName(p) === callee) {
      if (p.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)) return p;
    }
  }
  return null;
}

function callsNamed(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && resolvedCallName(n) === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/** The body of `const postDesignAndCache = (...) => ...` (or a function decl). */
function wrapperBodies(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === WRAPPER &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      out.push(n.initializer.body);
    } else if (ts.isFunctionDeclaration(n) && n.name?.text === WRAPPER && n.body) {
      out.push(n.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function insideSinkBody(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name?.text === SINK) return true;
  }
  return false;
}

export function scanDesignTransport(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { file, content } of files) {
    const sf = parseGuardSource(content, file);
    const where = (n: ts.Node): string =>
      `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const literals = designLiterals(sf);

    // Rule 1 — allowlisted files only.
    if (!ALLOWLIST.has(file)) {
      for (const l of literals) {
        violations.push(`rule 1: design/mint path literal outside the allowlist at ${where(l)}`);
      }
      continue;
    }

    // Rule 2 — every literal feeds the counted path.
    if (file === ROUTE_FILE) {
      const bodies = wrapperBodies(sf);
      const wrapperOk = bodies.length > 0 && bodies.every((b) => callsNamed(b, SINK));
      for (const l of literals) {
        if (!insideCallTo(l, WRAPPER)) {
          violations.push(`rule 2: literal not an argument of ${WRAPPER}( at ${where(l)}`);
        } else if (!wrapperOk) {
          violations.push(`rule 2: ${WRAPPER} body does not call ${SINK} (literal at ${where(l)})`);
        }
      }
    } else {
      for (const l of literals) {
        if (!insideCallTo(l, SINK)) {
          violations.push(`rule 2: literal not inside a ${SINK}( call at ${where(l)}`);
        }
      }
    }

    // Rule 3 — only the sink issues the request.
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const name = resolvedCallName(n);
        if (name && FETCH_NAMES.has(name)) {
          const first = n.arguments[0];
          if (first && containsDesignLiteral(first)) {
            violations.push(`rule 3: ${name}( takes a design/mint path literal at ${where(n)}`);
          }
          if (file === CORE_FILE && !insideSinkBody(n)) {
            violations.push(`rule 3: ${name}( outside ${SINK} body at ${where(n)}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return violations;
}

function loadTree(): SourceFile[] {
  return collectSourceFiles(SRC_ROOT).map((abs) => ({
    file: relative(SRC_ROOT, abs).split('\\').join('/'),
    content: readFileSync(abs, 'utf8'),
  }));
}

describe('G2 — syntactic guard on literal design / mint sidecar requests (#1393)', () => {
  it('the real tree has no design/mint request outside the counted path', () => {
    expect(scanDesignTransport(loadTree())).toEqual([]);
  });

  it('finds the known literals (the scan is not vacuous)', () => {
    const tree = loadTree();
    const count = (f: string): number =>
      designLiterals(parseGuardSource(tree.find((t) => t.file === f)!.content, f)).length;
    expect(count(CORE_FILE)).toBe(1);
    expect(count(ROUTE_FILE)).toBe(3);
  });

  describe('able to fail', () => {
    const wrapper = `const postDesignAndCache = (t: string) => postDesignAndCacheAudition({ target: t });`;

    it('rule 1: a literal in a non-allowlisted file is red', () => {
      const v = scanDesignTransport([
        { file: 'routes/__g2-scratch.ts', content: 'fetch(`${base}/qwen/mint-variant`);' },
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatch(/^rule 1:/);
    });

    it('rule 2/3: a direct undiciFetch in qwen-voice.ts is red', () => {
      const v = scanDesignTransport([
        {
          file: ROUTE_FILE,
          content: `${wrapper}\nundiciFetch(\`\${sidecarUrl}/qwen/mint-variant\`, {});`,
        },
      ]);
      expect(v.some((m) => m.startsWith('rule 2:'))).toBe(true);
      expect(v.some((m) => m.startsWith('rule 3:'))).toBe(true);
    });

    it('rule 2: a wrapper that no longer calls the sink is red', () => {
      const v = scanDesignTransport([
        {
          file: ROUTE_FILE,
          content: `const postDesignAndCache = (t: string) => other(t);\npostDesignAndCache(\`\${u}/qwen/design-voice\`);`,
        },
      ]);
      expect(v.some((m) => m.startsWith('rule 2:'))).toBe(true);
    });

    it('rule 3: a fetch outside the sink body in design-voice-core.ts is red', () => {
      const v = scanDesignTransport([
        { file: CORE_FILE, content: 'async function other() { await undiciFetch(url, {}); }' },
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatch(/^rule 3:/);
    });

    it('a wrapper call plus a sink-body fetch is green', () => {
      expect(
        scanDesignTransport([
          {
            file: ROUTE_FILE,
            content: `${wrapper}\npostDesignAndCache(\`\${u}/qwen/design-voice\`);`,
          },
          {
            file: CORE_FILE,
            content: `export async function ${SINK}(p) { await undiciFetch(p.target, {}); }\nasync function run() { await ${SINK}({ target: \`\${u}/qwen/design-voice\` }); }`,
          },
        ]),
      ).toEqual([]);
    });

    it('comments naming the paths stay green (stripped)', () => {
      expect(
        scanDesignTransport([
          {
            file: 'analyzer/other.ts',
            content: '/* POST /qwen/design-voice */\n// and /qwen/mint-variant\nexport const x = 1;',
          },
        ]),
      ).toEqual([]);
    });
  });
});
