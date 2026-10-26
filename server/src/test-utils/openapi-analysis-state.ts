/* #3787 — a `components.schemas` entry of openapi.yaml (`AnalysisState`, `ActiveAnalysisSummary`), read at RUNTIME as text (no module-graph
   edge; openapi.yaml is already a vitest forceRerunTrigger), so a route test can pin the real
   response of GET /api/books/{bookId}/analysis/state against it. Same string-match mechanism as
   routes/openapi-setup-parity.test.ts; tolerant of CRLF. Key names are checked here; the enums are
   pinned against the server unions by routes/openapi-analysis-state-parity.test.ts. */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

/** The `properties:` block of one schema: from the line after `properties:` up to the first
    non-blank line indented less than a property key (8 spaces), so a later 6-space sibling such
    as `example:` can never lend its 8-space children to the property list. */
function propertiesText(schemaName: string): { required: string[]; text: string } {
  const yaml = readFileSync(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
  const start = new RegExp(`\r?\n {4}${schemaName}:\r?\n`).exec(yaml);
  expect(start, `schema ${schemaName} not found in openapi.yaml`).not.toBeNull();
  const rest = yaml.slice(start!.index + start![0].length);
  const next = /\r?\n {4}[A-Za-z][A-Za-z0-9]*:\r?\n/.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;
  const req = /\r?\n {6}required: \[([^\]]*)\]/.exec(block);
  expect(req, `${schemaName} has no required: [...]`).not.toBeNull();
  const propsAt = /\r?\n {6}properties:\r?\n/.exec(block);
  expect(propsAt, `${schemaName} has no properties`).not.toBeNull();
  const after = block.slice(propsAt!.index + propsAt![0].length);
  const end = /\r?\n {0,7}\S/.exec(after);
  return {
    required: req![1].split(',').map((s) => s.trim()).filter(Boolean),
    text: end ? after.slice(0, end.index) : after,
  };
}

export function schemaKeys(schemaName: string): { required: string[]; properties: string[] } {
  const { required, text } = propertiesText(schemaName);
  const properties = [...text.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
  return { required, properties };
}

/** The sorted members of one property's `enum: [...]` (inline or on its own line). */
export function schemaPropertyEnum(schemaName: string, propertyName: string): string[] {
  const { text } = propertiesText(schemaName);
  const at = new RegExp(`^ {8}${propertyName}:`, 'm').exec(text);
  expect(at, `property ${propertyName} not found on schema ${schemaName}`).not.toBeNull();
  const tail = text.slice(at!.index + at![0].length);
  const nextProp = /\r?\n {8}[A-Za-z]/.exec(tail);
  const m = /enum:\s*\[([^\]]*)\]/.exec(nextProp ? tail.slice(0, nextProp.index) : tail);
  expect(m, `${schemaName}.${propertyName} has no enum: [...]`).not.toBeNull();
  return m![1].split(',').map((s) => s.trim()).filter(Boolean).sort();
}

/** Assert a response body honours the named schema: every required key present, no key outside it. */
export function expectMatchesSchema(schemaName: string, body: Record<string, unknown>): void {
  const { required, properties } = schemaKeys(schemaName);
  const keys = Object.keys(body);
  expect(keys.filter((k) => !properties.includes(k)), 'keys the schema does not declare').toEqual([]);
  expect(required.filter((k) => !keys.includes(k)), 'required schema keys missing').toEqual([]);
}

export function expectMatchesAnalysisStateSchema(body: Record<string, unknown>): void {
  expectMatchesSchema('AnalysisState', body);
}
