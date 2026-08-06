/* #2051 — `src/lib/api.ts`'s `readCastDesignStream` hand-mirrors the SSE
   event-type contract two generated schemas describe (`CastDesignEvent` /
   `SingleDesignEvent` in `src/lib/api-types.ts`, generated from
   `openapi.yaml` by `npm run openapi:types`) into one `handle()` switch
   feeding narrow per-event callbacks. `server/src/routes/
   openapi-design-parity.test.ts` already guards the OTHER edge — route
   source → openapi.yaml — so a ninth/tenth event type reaching
   `cast-design.ts`/`single-design.ts` without a matching openapi.yaml entry
   already fails a test today. What nothing checked before this file: once a
   new event type IS in openapi.yaml (and api-types.ts has been regenerated
   from it), does `api.ts`'s switch actually handle it? This is that guard.

   Scope, per the #2051 comment that narrowed it: NOT a refactor to derive
   the parser from the generated union (see the comment above
   `readCastDesignStream` in api.ts for why that's real design work a
   smaller guard already makes unnecessary) — just a cross-check that the
   switch's `case` labels cover `CastDesignEvent['type'] |
   SingleDesignEvent['type']`.

   **What this guard does NOT catch** (inherited from
   openapi-design-parity.test.ts's own documented blind spot, PR #2048
   finding F6): both extraction functions below are literal-string regexes
   over source text, not a type-level check. A `case` label built from a
   named constant, a template literal, or a variable is invisible to
   `extractHandledCaseTypes` and silently passes as "not handled" is never
   asked; equally, this guard can only ever be as complete as api-types.ts's
   enum IS — if api-types.ts goes stale relative to openapi.yaml (not
   regenerated after an openapi.yaml edit), this test keeps passing against
   the STALE union while the real wire contract has already drifted. Neither
   gap is closed here; say so rather than let the guard read as stronger
   than it is. */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The text of one `components["schemas"]` entry in api-types.ts: from its
    own 8-space-indented anchor up to (but not including) the next sibling
    property at the same indent. Mirrors openapi-design-parity.test.ts's
    `schemaBlock` helper, adapted to api-types.ts's generated TS syntax
    rather than openapi.yaml's. */
function schemaBlock(src: string, schemaName: string): string {
  const anchor = new RegExp(`\\r?\\n {8}${schemaName}: \\{\\r?\\n`);
  const match = anchor.exec(src);
  expect(match, `schema ${schemaName} not found in api-types.ts`).not.toBeNull();
  const bodyStart = match!.index + match![0].length;
  const rest = src.slice(bodyStart);
  const next = /\r?\n {8}[A-Za-z_$][A-Za-z0-9_$]*\??: /.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

/** The members of a schema's discriminant `type: "a" | "b" | ...;` union —
    the first `type:` property in the block, matching
    openapi-design-parity.test.ts's assumption that `type` is always the
    first documented property on these schemas. */
function typeUnionMembers(src: string, schemaName: string): string[] {
  const block = schemaBlock(src, schemaName);
  const m = /\btype:\s*((?:"[a-z0-9_-]+"\s*\|\s*)*"[a-z0-9_-]+")/i.exec(block);
  expect(m, `no discriminant "type" union found on ${schemaName}`).not.toBeNull();
  return [...m![1].matchAll(/"([a-z0-9_-]+)"/g)].map((mm) => mm[1]);
}

/** The text of `readCastDesignStream` in api.ts: from its own export anchor
    up to the next top-level export (`realStartCastDesign`), the same
    "anchor to next sibling" technique as `schemaBlock` above. Scoping to
    just this function (rather than the whole ~6000-line file) keeps the
    `case '...':` extraction below from picking up an unrelated switch
    statement elsewhere in api.ts. */
function readCastDesignStreamSource(apiSrc: string): string {
  const anchor = /\r?\nexport async function readCastDesignStream\(/;
  const m = anchor.exec(apiSrc);
  expect(m, 'readCastDesignStream not found in api.ts').not.toBeNull();
  const bodyStart = m!.index + m![0].length;
  const rest = apiSrc.slice(bodyStart);
  const next = /\r?\nexport async function realStartCastDesign\(/.exec(rest);
  expect(next, 'realStartCastDesign not found after readCastDesignStream in api.ts').not.toBeNull();
  return rest.slice(0, next!.index);
}

/** Every `case '<literal>':` inside `readCastDesignStream`'s `handle()`
    switch — same `[a-z0-9_-]` literal class openapi-design-parity.test.ts
    uses for the identical server-side extraction (hyphenated-lowercase is
    the established style on this surface; see that file's
    `extractEventTypes` for the full rationale). `default:` never matches
    this pattern, so it's correctly excluded. */
function extractHandledCaseTypes(fnSrc: string): string[] {
  return [...new Set([...fnSrc.matchAll(/case '([a-z0-9_-]+)':/g)].map((m) => m[1]))].sort();
}

describe('readCastDesignStream covers every generated design-SSE event type (#2051)', () => {
  it("the handle() switch's case labels equal CastDesignEvent['type'] | SingleDesignEvent['type']", async () => {
    /* Not `new URL(..., import.meta.url)`: Vite rewrites import.meta.url to
       a non-file scheme under jsdom (same reasoning as
       api.clone-voice.test.ts's openapi.yaml pin). Vitest runs with cwd at
       the config root, which is the repo root. */
    const apiSrc = await readFile(resolve(process.cwd(), 'src/lib/api.ts'), 'utf8');
    const apiTypesSrc = await readFile(resolve(process.cwd(), 'src/lib/api-types.ts'), 'utf8');

    const generated = [
      ...new Set([
        ...typeUnionMembers(apiTypesSrc, 'CastDesignEvent'),
        ...typeUnionMembers(apiTypesSrc, 'SingleDesignEvent'),
      ]),
    ].sort();
    const handled = extractHandledCaseTypes(readCastDesignStreamSource(apiSrc));

    expect(handled).toEqual(generated);
  });
});
