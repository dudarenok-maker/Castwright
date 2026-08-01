/* #1934 — openapi.yaml is this repo's declared source of truth for API
   shapes, but the six SSE endpoints in `cast-design.ts` + `single-design.ts`
   (the "Design full cast" bulk job + the single-character design job) were
   entirely undescribed there, so `src/lib/api.ts`'s hand-mirrored types for
   this surface had no mechanical guard against drift. This test is that
   guard, in the shape of `openapi-setup-parity.test.ts` (#1883): it reads
   every file involved at RUNTIME (openapi.yaml, the two route files, and the
   internal loopback relay that also broadcasts onto the single-design SSE)
   and cross-checks the SSE `type` values + the mounted paths against what
   openapi.yaml actually describes — a THIRD hardcoded literal on either side
   would defeat the point, so both sides are derived from the real source,
   not copied by hand.

   Unlike openapi-setup-parity.test.ts, there is no exported TypeScript union
   of "every event type this route emits" to import type-only and pin via
   `satisfies` — the events here are untyped inline object literals at each
   `broadcast`/`send`/`endJob` call site, and adding one just for this test
   would be a production-code change wider than "describe the existing
   contract" (this issue's actual scope). So the "server truth" side is a
   direct regex extraction of `type: '<literal>'` from the route sources
   themselves — verified (see below) to have zero false positives in either
   file, i.e. every such literal really is an SSE event `type`.

   **Line-ending agnostic**, same reasoning as openapi-setup-parity.test.ts:
   openapi.yaml is LF-pinned via .gitattributes but an existing Windows
   checkout can still carry CRLF (core.autocrlf never rewrites an unchanged
   blob), so every regex anchor tolerates `\r?\n`. */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

let yaml: string;
let castDesignSrc: string;
let singleDesignSrc: string;
let designProgressRelaySrc: string;

beforeAll(async () => {
  yaml = await readFile(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
  castDesignSrc = await readFile(new URL('./cast-design.ts', import.meta.url), 'utf8');
  singleDesignSrc = await readFile(new URL('./single-design.ts', import.meta.url), 'utf8');
  designProgressRelaySrc = await readFile(new URL('./design-progress-relay.ts', import.meta.url), 'utf8');
});

/** The text of one `components.schemas` entry: from its own anchor up to (but
    not including) the next sibling schema at the same 4-space indent. Mirrors
    openapi-setup-parity.test.ts's identical helper. */
function schemaBlock(src: string, schemaName: string): string {
  const anchor = new RegExp(`\\r?\\n {4}${schemaName}:\\r?\\n`);
  const match = anchor.exec(src);
  expect(match, `schema ${schemaName} not found in openapi.yaml`).not.toBeNull();
  const bodyStart = match!.index + match![0].length;
  const rest = src.slice(bodyStart);
  const next = /\r?\n {4}[A-Za-z][A-Za-z0-9]*:\r?\n/.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

/** The sorted members of the `type` property's `enum: [...]` on a schema
    block (its FIRST enum — every schema this test reads has `type` as its
    first documented property). */
function typeEnum(src: string, schemaName: string): string[] {
  const block = schemaBlock(src, schemaName);
  const m = /enum:\s*\[([\s\S]*?)\]/.exec(block);
  expect(m, `no enum: [...] found on ${schemaName}.type`).not.toBeNull();
  return m![1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/** Every `type: '<literal>'` occurring anywhere in a route source file —
    verified (by inspection, see file header) to match ONLY genuine SSE event
    payloads in cast-design.ts / single-design.ts / design-progress-relay.ts,
    never an unrelated `type` property. */
function extractEventTypes(src: string): string[] {
  return [...new Set([...src.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

/** Every `<router>.(get|post)('<path>', ...)` registration in a route source
    — tolerates the method name and the path string landing on different
    lines (single-design.ts wraps its longest route). Converts Express's
    `:param` segments to OpenAPI's `{param}` and prefixes with the app.ts
    mount point (`/api/books` for both routers here). */
function mountedPaths(src: string, routerName: string): string[] {
  const re = new RegExp(`${routerName}\\.(get|post)\\(\\s*['"]([^'"]+)['"]`, 'g');
  return [...src.matchAll(re)]
    .map((m) => `/api/books${m[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`)
    .sort();
}

/** Every `/api/books/{bookId}/cast/design...` or `.../design-voice/...`
    path key under `paths:` (2-space indent) — the same regex-over-text
    technique `describedSetupPaths` uses in openapi-setup-parity.test.ts,
    scoped to this surface instead of `/api/setup/*`. */
function describedDesignPaths(src: string): string[] {
  return [...src.matchAll(/^ {2}(\/api\/books\/\{bookId\}\/cast\/(?:design|\{characterId\}\/design-voice)\S*):$/gm)].map(
    (m) => m[1],
  );
}

describe('openapi.yaml describes the cast/single design SSE surface accurately (#1934)', () => {
  it('every route cast-design.ts + single-design.ts mounts is described in openapi.yaml', () => {
    const fromSource = [
      ...mountedPaths(castDesignSrc, 'castDesignRouter'),
      ...mountedPaths(singleDesignSrc, 'singleDesignRouter'),
    ].sort();
    expect(fromSource).toEqual([
      '/api/books/{bookId}/cast/design',
      '/api/books/{bookId}/cast/design-single/status',
      '/api/books/{bookId}/cast/design-single/subscribe',
      '/api/books/{bookId}/cast/design/pause',
      '/api/books/{bookId}/cast/design/status',
      '/api/books/{bookId}/cast/{characterId}/design-voice/stream',
    ]);
    expect(describedDesignPaths(yaml).sort()).toEqual(fromSource);
  });

  it("CastDesignEvent.type covers every event type cast-design.ts actually emits", () => {
    expect(typeEnum(yaml, 'CastDesignEvent')).toEqual(extractEventTypes(castDesignSrc));
  });

  it("SingleDesignEvent.type covers every event type single-design.ts + the design-progress loopback relay actually emit", () => {
    /* 'phase' events are broadcast from design-progress-relay.ts, not
       single-design.ts itself (the sidecar POSTs phase progress to that
       internal loopback route, which relays it onto the SAME SingleJob
       subscriber set) — see that file's header. Both sources feed the one
       wire contract this test pins. */
    const fromSource = [
      ...new Set([...extractEventTypes(singleDesignSrc), ...extractEventTypes(designProgressRelaySrc)]),
    ].sort();
    expect(typeEnum(yaml, 'SingleDesignEvent')).toEqual(fromSource);
  });

  it('CastDesignEvent.reason (clone-protection) matches the literal the route emits', () => {
    expect(schemaBlock(yaml, 'CastDesignEvent')).toMatch(/reason:\s*\r?\n\s*type: string\r?\n\s*enum: \[already_cloned\]/);
    expect(castDesignSrc).toContain("reason: 'already_cloned'");
  });

  it('SingleDesignEvent error codes (not_found, design_failed, unsupported_language) match the route', () => {
    /* Scoped to `type: 'error', code: '...'` pairs on the SAME literal — NOT
       every `code: '...'` in the file, which also matches the unrelated
       plain-JSON 409 `{ error, code: 'clone_protected' }` response (asserted
       separately below). */
    const codes = [
      ...new Set([...singleDesignSrc.matchAll(/type:\s*'error',\s*code:\s*'([a-z_]+)'/g)].map((m) => m[1])),
    ].sort();
    expect(codes).toEqual(['design_failed', 'not_found', 'unsupported_language']);
    const block = schemaBlock(yaml, 'SingleDesignEvent');
    const codeEnumMatch = /code:\r?\n\s*type: string\r?\n\s*enum: \[([^\]]+)\]/.exec(block);
    expect(codeEnumMatch, 'SingleDesignEvent.code enum not found').not.toBeNull();
    expect(codeEnumMatch![1].split(',').map((s) => s.trim()).sort()).toEqual(codes);
  });

  it('the single-design route documents the 409 clone_protected refusal', () => {
    expect(singleDesignSrc).toContain("code: 'clone_protected'");
    expect(yaml).toContain('clone_protected');
  });

  it('reads a CRLF checkout identically (Windows core.autocrlf=true, mirrors #1952)', () => {
    const lf = yaml.replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(typeEnum(crlf, 'CastDesignEvent')).toEqual(typeEnum(lf, 'CastDesignEvent'));
    expect(typeEnum(crlf, 'SingleDesignEvent')).toEqual(typeEnum(lf, 'SingleDesignEvent'));
    expect(describedDesignPaths(crlf).sort()).toEqual(describedDesignPaths(lf).sort());
  });
});
