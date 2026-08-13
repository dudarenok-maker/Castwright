/* Guard 6 (#2128, round-1 review I1) — the full-render `castHistorySeq` stamp
   source-traces to the SAME `castIdHistory` binding the render actually
   resolved its cast against, never a fresh re-read at the finalize call site.

   Every other untested scenario in this branch degrades TOWARD 'unknown' on
   a regression, which lists — noisy but safe. This one does not: `seq`
   climbs monotonically, so a re-read (`castHistorySeq: (await
   loadCastIdHistory(bookDir)).seq ?? 0` at the `finalizeChapterAudioWrite`
   call, instead of reading the `castIdHistory` const loaded once at the top
   of the handler) would read as MORE current, not less. If a retirement
   lands mid-render, the re-read stamps the render at the retirement's OWN
   `seq`, which is also exactly what `recordedAtSeq` stamps the retired key
   at — `stamp >= highest` then reads `true` and the row clears on stale
   bytes. That is #2107 verbatim, and nothing else in this branch would
   redden: `cast-history-threading.guard.test.ts` (guard 3) only catches a
   hand-built object literal passed to `buildCastResolver`/`isAudioCurrent`;
   it says nothing about where `generation.ts` SOURCES the `seq` it stamps.

   Text-scans `generation.ts` rather than importing it — importing the real
   route module drags in the whole generation dependency graph (GPU-backed
   TTS, sidecar clients, SSE broadcast plumbing) for a check that only needs
   the source text, mirroring guard 3 / guard 5's own choice.

   BLIND SPOTS, stated rather than implied:
   - Single-file, single-route. Only the `/:bookId/generation` full-render
     handler is scanned. `chapter-qa-repair.ts` and `chapter-splice.ts`'s
     CARRY-FORWARD shape (`castHistorySeq: segFile.castHistorySeq`) is a
     different hazard with different tests — the router-integration
     `#2128 castHistorySeq carry-forward` suites in those two files' own
     `.test.ts` — not this guard's job.
   - Literal-identifier check, not alias-aware. `propertyValueText` asserts
     the stamped expression's text STARTS WITH the exact identifier
     `castIdHistory`. A deliberate, correct rename — `const history = await
     loadCastIdHistory(bookDir); … castHistorySeq: history.seq ?? 0` — would
     still be safe (same object, still read once) but would FALSE-POSITIVE
     here. That is the safe direction for a guard to be wrong in: a rename
     needs this guard's `castHistorySeq:` check literal updated by hand
     alongside it, never silently.
   - Comment/string text is stripped before matching (`blankOutOpaque`,
     copied from `cast-history-threading.guard.test.ts` rather than
     imported — see that file's `collectTsFiles` doc comment for why guard
     files copy small helpers instead of coupling to each other), so a call
     quoted inside a doc comment neither fires nor masks a real one.
   - FAIL-OPEN GUARD: `extractRouteHandlerBody` THROWS (never returns an
     empty/null slice) when the route registration string isn't found — a
     renamed route or moved file must redden this suite, not pass on zero
     evidence. The same shape as guard 3's `collectTsFiles` throwing on a
     missing directory. Proven by pointing the extractor at a route literal
     that doesn't exist. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GENERATION_TS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'generation.ts');
const SRC = readFileSync(GENERATION_TS_PATH, 'utf8');
const ROUTE = '/:bookId/generation';

/** Copied from `cast-history-threading.guard.test.ts`'s `blankOutOpaque`
 *  (guard files deliberately copy small helpers rather than import each
 *  other's — see that file's `collectTsFiles` doc comment). Replaces every
 *  line comment, block comment and string literal with spaces of the same
 *  length, so indices stay stable and quoted/commented code never matches. */
export function blankOutOpaque(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < src.length && src[k] !== c) {
        if (src[k] === '\\') k += 1;
        k += 1;
      }
      blank(i, Math.min(k + 1, src.length));
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** The full-render POST handler's source, from its
 *  `generationRouter.post('<routeLiteral>',` registration up to (but not
 *  including) the NEXT top-level `generationRouter.` registration — or the
 *  end of the file if there is none. Throws, rather than returning an
 *  empty/null slice, when `routeLiteral` isn't found: the fail-open hazard
 *  every guard in this lane closes the same way (see file header). */
export function extractRouteHandlerBody(src: string, routeLiteral: string): string {
  const marker = `generationRouter.post('${routeLiteral}',`;
  const start = src.indexOf(marker);
  if (start < 0) {
    throw new Error(
      `generation.ts: route registration ${JSON.stringify(marker)} not found — the scan would see nothing.`,
    );
  }
  const rest = src.slice(start + marker.length);
  const next = /\r?\ngenerationRouter\./.exec(rest);
  const end = next ? start + marker.length + next.index : src.length;
  return src.slice(start, end);
}

/** The text strictly between a call's outer parens (`callName(...)`),
 *  depth-aware over `()[]{}` so a nested call/object/array can't fool it.
 *  Mirrors `cast-history-threading.guard.test.ts`'s `historyArgIsLiteral`
 *  depth walk. Returns `null` if `callName(` isn't found at all. */
export function callArgsText(src: string, callName: string): string | null {
  const at = src.indexOf(`${callName}(`);
  if (at < 0) return null;
  let i = at + callName.length + 1;
  let depth = 1;
  const start = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i);
}

/** The raw expression text bound to `key:` inside an object-literal argument
 *  (as returned by `callArgsText`) — from just after the colon up to the
 *  next TOP-LEVEL comma (the property separator) or the object's own
 *  closing brace. Depth-aware for the same reason as `callArgsText`.
 *  Returns `null` if `key` isn't found. */
export function propertyValueText(objText: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*:`).exec(objText);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  const start = i;
  for (; i < objText.length; i += 1) {
    const c = objText[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // the object literal's own closing brace
      depth -= 1;
    } else if (c === ',' && depth === 0) break;
  }
  return objText.slice(start, i).trim();
}

describe('guard 6 — the full-render castHistorySeq stamp reads the loaded history, never a re-read (#2128)', () => {
  const renderBody = blankOutOpaque(extractRouteHandlerBody(SRC, ROUTE));

  it('found the route handler at all — an unmatched route must not pass green', () => {
    expect(() => extractRouteHandlerBody(SRC, '/:bookId/generation/does-not-exist')).toThrow();
    // The real slice is a whole route handler (~80k chars today), not an
    // accidental near-empty match — a floor well under that, so a genuine
    // trim/refactor of the handler doesn't make this brittle.
    expect(renderBody.length).toBeGreaterThan(5000);
  });

  it('calls loadCastIdHistory exactly once in the render body', () => {
    expect(renderBody.match(/loadCastIdHistory\(/g)?.length ?? 0).toBe(1);
  });

  it('stamps castHistorySeq from the castIdHistory binding, not a fresh read', () => {
    const args = callArgsText(renderBody, 'finalizeChapterAudioWrite');
    expect(args, 'finalizeChapterAudioWrite call not found in the render body').not.toBeNull();
    const value = propertyValueText(args!, 'castHistorySeq');
    expect(value, 'castHistorySeq property not found on the finalizeChapterAudioWrite call').not.toBeNull();
    expect(value!.startsWith('castIdHistory')).toBe(true);
    expect(value).not.toMatch(/loadCastIdHistory/);
  });

  /* Neutralisation proof — without this, a detector that matched nothing (a
     typo'd key name, a broken depth walk, a `castHistorySeq` regex that
     never fires) would pass the two tests above green forever while
     defending nothing. Round-1 review I1's exact regression shape. */
  it('actually detects the re-read regression', () => {
    const violating = `
      generationRouter.post('/:bookId/generation', async (req, res) => {
        const castIdHistory = await loadCastIdHistory(bookDir);
        const { audioQa } = await finalizeChapterAudioWrite({
          bookId,
          castHistorySeq: (await loadCastIdHistory(bookDir)).seq ?? 0,
        });
      });
    `;
    const body = blankOutOpaque(extractRouteHandlerBody(violating, ROUTE));

    // Axis 1: the re-read is a SECOND loadCastIdHistory( call.
    expect(body.match(/loadCastIdHistory\(/g)?.length ?? 0).not.toBe(1);

    // Axis 2: the stamped expression no longer starts with the bare binding.
    const args = callArgsText(body, 'finalizeChapterAudioWrite')!;
    const value = propertyValueText(args, 'castHistorySeq')!;
    expect(value.startsWith('castIdHistory')).toBe(false);
  });

  it('does not fire on the correct shape', () => {
    const clean = `
      generationRouter.post('/:bookId/generation', async (req, res) => {
        const castIdHistory = await loadCastIdHistory(bookDir);
        const { audioQa } = await finalizeChapterAudioWrite({
          bookId,
          castHistorySeq: castIdHistory.seq ?? 0,
        });
      });
    `;
    const body = blankOutOpaque(extractRouteHandlerBody(clean, ROUTE));
    expect(body.match(/loadCastIdHistory\(/g)?.length ?? 0).toBe(1);
    const args = callArgsText(body, 'finalizeChapterAudioWrite')!;
    const value = propertyValueText(args, 'castHistorySeq')!;
    expect(value.startsWith('castIdHistory')).toBe(true);
  });

  it('ignores a call quoted in a comment or a string', () => {
    const commented = `
      generationRouter.post('/:bookId/generation', async (req, res) => {
        // const x = await loadCastIdHistory(bookDir);
        const castIdHistory = await loadCastIdHistory(bookDir);
        const s = "loadCastIdHistory(bookDir)";
        const { audioQa } = await finalizeChapterAudioWrite({
          castHistorySeq: castIdHistory.seq ?? 0,
        });
      });
    `;
    const body = blankOutOpaque(extractRouteHandlerBody(commented, ROUTE));
    expect(body.match(/loadCastIdHistory\(/g)?.length ?? 0).toBe(1);
  });
});
