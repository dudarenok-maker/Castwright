/* Guard for #3721: no server `console.<method>(...)` call may carry a printf
   placeholder (`%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O`, `%c`, `%%`) in the
   static text of its FIRST argument.

   Why: logger.ts's installTimestamps() always passes the timestamp as Node's
   format argument, so the caller's own first argument is never a format string.
   A `%s` there prints literally in production (the values land at the end of
   the line). CodeQL's `js/tainted-format-string` remediation is `%s`
   placeholders, so the obvious response to that alert reintroduces the bug with
   a green suite — this scan fails it instead. It checks the property (static
   text of the first argument: string literal, template head/middle/tail, any
   string operand of a `+` chain), not a list of call shapes, so it also covers
   sites added later. Test files and test-utils are out of scope. */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname);
const PLACEHOLDER = /%[sdifjoOc%]/;

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test-utils') continue;
      listSources(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Static text pieces of an expression used as a console first argument. */
function staticText(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
  }
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...staticText(node.left), ...staticText(node.right)];
  }
  return [];
}

function findOffenders(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'console' &&
      node.arguments.length > 0 &&
      staticText(node.arguments[0]).some((t) => PLACEHOLDER.test(t))
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${relative(SRC_ROOT, file).replace(/\\/g, '/')}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('console format placeholders (#3721)', () => {
  it('no server console call has a printf placeholder in its first argument', () => {
    const files = listSources(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap(findOffenders);
    expect(
      offenders,
      'installTimestamps() makes the timestamp Node\'s format argument, so a %s in a console first argument prints literally. Use a template literal.',
    ).toEqual([]);
  });
});
