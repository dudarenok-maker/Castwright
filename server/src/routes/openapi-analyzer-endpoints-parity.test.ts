/* #3525 review (contract drift) — pins openapi.yaml's analyzer-endpoint
   surface to what the routes actually do. Reads openapi.yaml as TEXT at
   runtime with a small hand-rolled extraction (no YAML parser, no new
   dependency) — the same mechanism as openapi-setup-parity.test.ts, whose
   header covers why openapi.yaml is in forceRerunTriggers and why the read
   is LF-normalised (CRLF worktrees, #1952). */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

let yaml: string;

beforeAll(async () => {
  const raw = await readFile(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
  yaml = raw.replace(/\r\n/g, '\n');
});

/** Text from the first match of `start` (searched in `src`) up to the first
    match of `end` after it, or to the end of `src` when `end` never matches. */
function slice(src: string, start: RegExp, end: RegExp): string {
  const m = start.exec(src);
  expect(m, `${start} not found in openapi.yaml`).not.toBeNull();
  /* The start pattern consumes its trailing newline; give the end scan (and the
     next slice's start scan) that line break back. */
  const rest = '\n' + src.slice(m!.index + m![0].length);
  const e = end.exec(rest);
  return rest.slice(0, e ? e.index : undefined);
}

/** One `paths:` entry — from its 2-space key to the next 2-space path or `components:`. */
function pathBlock(p: string): string {
  return slice(yaml, new RegExp(`\\n {2}${p.replace(/[{}/]/g, '\\$&')}:\\n`), /\n {2}\/|\ncomponents:/);
}

/** One response (`'400':`, …) of an operation block — up to the next 8-space status key. */
function response(opBlock: string, status: string): string {
  return slice(opBlock, new RegExp(`\\n {8}'${status}':\\n`), /\n {8}'\d{3}':\n|\n {4}[a-z]+:\n|$/);
}

/** One property of `UserSettingsPatch` — up to the next 8-space sibling key. */
function patchProperty(name: string): string {
  const schema = slice(yaml, /\n {4}UserSettingsPatch:\n/, /\n {4}[A-Za-z][A-Za-z0-9]*:\n/);
  return slice(schema, new RegExp(`\\n {8}${name}:\\n`), /\n {8}[A-Za-z][A-Za-z0-9]*:\n|$/);
}

describe('openapi.yaml analyzer-endpoint contract', () => {
  it('the DELETE description names only the references the server checks (A5 removed the phase-model fields)', () => {
    const description = slice(
      pathBlock('/api/analyzer/endpoints/{endpointId}'),
      /\n {4}delete:\n/,
      /\n {6}responses:\n/,
    );
    expect(description).toContain('defaultAnalysisModel');
    expect(description).toContain('analyzer.phase0.model');
    expect(description).not.toMatch(/\(defaultAnalysisModel, analyzerPhase0Model/);
  });

  it('UserSettingsPatch marks analyzerEndpoints readOnly: PUT /api/user/settings strips it', () => {
    expect(patchProperty('analyzerEndpoints')).toMatch(/\n {10}readOnly: true\n/);
    expect(patchProperty('analyzerEndpointKeyStatus')).toMatch(/\n {10}readOnly: true\n/);
  });

  it('every endpoint URL field carries the case-insensitive http(s) pattern the server accepts (#3525 review pass 2)', () => {
    /* httpUrlSchema tests the scheme case-insensitively (HTTP://LAB/v1 is stored as typed), and JSON
       Schema patterns have no flags, so the contract spells the case-folding out. */
    const urlLines = yaml.split('\n').filter((l) => /^\s+(?:baseUrl|unloadUrl): \{ type: string, format: uri/.test(l));
    expect(urlLines).toHaveLength(6);
    for (const line of urlLines) expect(line).toContain("pattern: '^[Hh][Tt][Tt][Pp][Ss]?://'");
    expect(yaml).not.toContain("pattern: '^https?://'");
  });

  it('the /key route documents its 400 body as the {error, code, issues} refusal', () => {
    const put = slice(pathBlock('/api/analyzer/endpoints/{endpointId}/key'), /\n {4}put:\n/, /$/);
    expect(response(put, '400')).toContain("$ref: '#/components/schemas/AnalyzerEndpointRefusal'");
  });

  it('the Detect 400 documents its `details` array of strings', () => {
    const detect = slice(pathBlock('/api/analyzer/endpoints/detect-context'), /\n {4}post:\n/, /$/);
    const details = slice(response(detect, '400'), /\n {18}details:\n/, /\n {18}[A-Za-z]+:|$/);
    expect(details).toContain('type: array');
    expect(details).toContain('items: { type: string }');
  });
});
