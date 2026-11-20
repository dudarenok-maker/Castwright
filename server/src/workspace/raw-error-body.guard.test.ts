/* #3702 — the static guard that stops a raw caught-error message leaking back
   into a client-facing HTTP 5xx body. Sibling of `state-json-lock.guard.test.ts`
   and `cast-lock.guard.test.ts` (same file shape, same shared scanner).

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` and, for
   each `<x>.status(<arg>).json(<body>)` / `.send(<body>)` call chain whose
   `<arg>` is a numeric literal 500-599 (or is NOT a literal at all — a variable
   status can be 5xx, which is what catches `backup.ts`-style sites), flags any
   of these inside `<body>`:
     - a `.message` property access,
     - `String(<identifier>)` (casts / non-null / parens peeled),
     - a template literal interpolating either (reached by the same walk).
   An occurrence is exempt when it sits inside the argument list of a seam call
   (`requestFailureMessage(`, `requestFailureMessageFs(`, `itemFailureReason(`,
   `workspace/file-lock.ts`) or of `scrubPaths(` (`tts/ffmpeg-failure.ts`, the
   child-process-output curation below). 4xx literals are never checked.

   METHOD: a TypeScript-AST walk (`parseGuardSource` / `resolvedCallName` from
   `server/src/test-utils/guard-scan.ts`). Comments and string literals are not
   AST expressions, so `.message` inside them is never seen. The existing
   `server/**` forceRerunTriggers entry re-runs every guard on any server change.

   FALSE NEGATIVES (raw bodies this does NOT catch):
     - A message hoisted into a local before the response
       (`const msg = e.message; res.status(500).json({ error: msg })`).
     - A shared response helper taking `(res, status, message)`.
     - Child-process OUTPUT in a body: `.stderr` / `.stdout` (execFile's error,
       `spawnSync`'s result, git's or the LAN-cert script's stderr) is raw text with
       absolute paths that no `.message` scan sees, and an `execFile` rejection has a
       numeric `code` and no `syscall`, so the fs seam never curates it either. Owner
       decision on #3702 (2026-11-21): such text is path-scrubbed with `scrubPaths`
       (`tts/ffmpeg-failure.ts`) before it reaches a body -- `routes/lan-cert.ts` and
       `routes/worktrees.ts` do; their tests drive a REAL failing child. A new route
       that forwards child output must do the same; this guard cannot tell it did.
     - SSE frames and job-poll bodies — out of scope by the #3702 decision.
     - An aliased import of the seam passes (the callee NAME is matched).
     - `.status(5xx)` split from `.json(` by another chained call
       (`.status(500).type(...).json(...)`), and `e['message']` element access.
   FALSE POSITIVES: a 5xx body whose `.message` is not a caught error, or a
   variable status that is in fact 4xx.

   Allowlist is keyed on FILE AND COUNT, both directions, like the sibling
   guards. It holds only reviewed false positives (see ALLOWED). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
  collectSourceFiles,
  parseGuardSource,
  resolvedCallName,
  unwrapExpression,
} from '../test-utils/guard-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

const SEAM_CALLS = new Set([
  'requestFailureMessage',
  'requestFailureMessageFs',
  'itemFailureReason',
  'scrubPaths', // the #3702 (2026-11-21) curation for child-process output
]);

/** Is the `.status(<arg>)` argument one that can be a 5xx? */
function statusCanBe5xx(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  const e = unwrapExpression(arg);
  if (ts.isNumericLiteral(e)) {
    const n = Number(e.text);
    return n >= 500 && n <= 599;
  }
  return true; // variable / computed status: assume it may be 5xx
}

/** Raw-message occurrences in `node`, not descending into seam-call arguments. */
function findRaw(node: ts.Node, out: ts.Node[]): void {
  if (ts.isCallExpression(node)) {
    const name = resolvedCallName(node);
    if (name && SEAM_CALLS.has(name)) return; // wrapped: exempt
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      node.arguments.length === 1 &&
      ts.isIdentifier(unwrapExpression(node.arguments[0]))
    ) {
      out.push(node);
      return;
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
    out.push(node);
    return;
  }
  ts.forEachChild(node, (c) => findRaw(c, out));
}

/** `file:line: <body text>` for every raw 5xx body in `content`. */
function scanSource(content: string, fileName = 'x.ts'): string[] {
  const sf = parseGuardSource(content, fileName);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'json' || node.expression.name.text === 'send')
    ) {
      const recv = unwrapExpression(node.expression.expression);
      if (
        ts.isCallExpression(recv) &&
        ts.isPropertyAccessExpression(recv.expression) &&
        recv.expression.name.text === 'status' &&
        statusCanBe5xx(recv.arguments[0])
      ) {
        const hits: ts.Node[] = [];
        for (const a of node.arguments) findRaw(a, hits);
        for (const h of hits) {
          const line = sf.getLineAndCharacterOfPosition(h.getStart(sf)).line + 1;
          const body = node.arguments.map((a) => a.getText(sf)).join(', ');
          found.push(`${fileName}:${line}: ${body.replace(/\s+/g, ' ')}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/* Key = file relative to server/src; value = exact violation count + reason.
   A file that scans clean must not be listed. Every entry below is a FALSE
   POSITIVE of the variable-status / `.message` rule, not a missed inventory row:
   the message is a fixed, path-free sentence, never a caught fs/lock error. */
const ALLOWED = new Map<string, { count: number; why: string }>([
  ['error-handler.ts', { count: 1, why: 'body-parser client error (4xx status variable); fixed library sentence' }],
  ['routes/analyzer-endpoints.ts', { count: 1, why: 'AnalyzerEndpointRefusal.status is a 4xx; message is a decided path-free refusal sentence' }],
  ['routes/backup.ts', { count: 1, why: 'status variable is 404/409/400 only; BackupRestoreError messages are fixed sentences' }],
  ['routes/cast-link-prior.ts', { count: 1, why: '.message of a freshly built RetryableForkError carrying a literal sentence, not a caught error' }],
  ['routes/cover.ts', { count: 1, why: 'UploadError status variable is 413/415/400 only; message is a fixed validation sentence' }],
  ['routes/exports-portable.ts', { count: 1, why: 'BookStateUnreadableError.message is deliberately path-free (#3714 review pass 4); else fixed sentence' }],
]);

describe('raw caught-error message in a 5xx body — static guard (#3702)', () => {
  describe('detector self-tests (a guard that cannot fail is worthless)', () => {
    it('flags a raw (e as Error).message in a 500 body', () => {
      expect(scanSource('res.status(500).json({ error: (e as Error).message });')).toHaveLength(1);
    });
    it('flags the same call split over three lines', () => {
      const src = 'res\n  .status(500)\n  .json({\n error: err.message,\n })';
      const r = scanSource(src);
      expect(r).toHaveLength(1);
      expect(r[0]).toContain(':4:');
    });
    it('flags a template literal interpolating the message', () => {
      expect(
        scanSource('res.status(502).json({ error: `failed: ${(e as Error).message}` });'),
      ).toHaveLength(1);
    });
    it('does not flag a message wrapped in the seam', () => {
      expect(
        scanSource('res.status(500).json({ error: requestFailureMessageFs(e, (e as Error).message) });'),
      ).toEqual([]);
    });
    it('does not flag a child-output message wrapped in the path scrubber (#3702 decision)', () => {
      expect(
        scanSource('res.status(500).json({ error: scrubPaths(`failed: ${r.error?.message}`) });'),
      ).toEqual([]);
    });
    it('does not flag a 4xx body', () => {
      expect(scanSource('res.status(400).json({ error: e.message });')).toEqual([]);
    });
    it('flags a non-literal status', () => {
      expect(scanSource('res.status(status).json({ error: err.message });')).toHaveLength(1);
    });
    it('does not flag a fixed user-facing sentence', () => {
      expect(scanSource("res.status(500).json({ error: 'Could not start the export.' });")).toEqual([]);
    });
    it('does not flag .message inside a comment or a string literal in the body', () => {
      const src = [
        'res.status(500).json({',
        "  error: 'see err.message in the log', // e.message is logged, not sent",
        '});',
      ].join('\n');
      expect(scanSource(src)).toEqual([]);
    });
    it('flags String(err) and .send( bodies too', () => {
      expect(scanSource('res.status(503).send(String(err));')).toHaveLength(1);
    });
  });

  it('no non-test file under server/src returns a raw error message in a 5xx body, except the pinned allowlist', () => {
    const problems: string[] = [];
    const matched = new Set<string>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      if (!content.includes('.status(')) continue;
      const hits = scanSource(content, rel);
      const allowed = ALLOWED.get(rel);
      if (allowed) {
        matched.add(rel);
        if (hits.length !== allowed.count) {
          problems.push(
            `${rel}: allowlisted for exactly ${allowed.count} (${allowed.why}), found ${hits.length}:\n  ${hits.join('\n  ')}`,
          );
        }
      } else if (hits.length > 0) {
        problems.push(`${rel}: raw error message in 5xx body — wrap in requestFailureMessageFs:\n  ${hits.join('\n  ')}`);
      }
    }
    for (const [rel, a] of ALLOWED) {
      if (!matched.has(rel)) problems.push(`${rel}: allowlisted for ${a.count} but the scan now finds ZERO — remove the entry.`);
    }
    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});
