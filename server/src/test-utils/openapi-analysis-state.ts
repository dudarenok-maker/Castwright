/* #3787 — a `components.schemas` entry of openapi.yaml (`AnalysisState`, `ActiveAnalysisSummary`), read at RUNTIME as text (no module-graph
   edge; openapi.yaml is already a vitest forceRerunTrigger), so a route test can pin the real
   response of GET /api/books/{bookId}/analysis/state against it. Same string-match mechanism as
   routes/openapi-setup-parity.test.ts; tolerant of CRLF. */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

export function schemaKeys(schemaName: string): { required: string[]; properties: string[] } {
  const yaml = readFileSync(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
  const start = new RegExp(`\\r?\\n {4}${schemaName}:\\r?\\n`).exec(yaml);
  expect(start, `schema ${schemaName} not found in openapi.yaml`).not.toBeNull();
  const rest = yaml.slice(start!.index + start![0].length);
  const next = /\r?\n {4}[A-Za-z][A-Za-z0-9]*:\r?\n/.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;
  const req = /\r?\n {6}required: \[([^\]]*)\]/.exec(block);
  expect(req, `${schemaName} has no required: [...]`).not.toBeNull();
  const propsAt = /\r?\n {6}properties:\r?\n/.exec(block);
  expect(propsAt, `${schemaName} has no properties`).not.toBeNull();
  const propsText = block.slice(propsAt!.index + propsAt![0].length);
  const properties = [...propsText.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
  return { required: req![1].split(',').map((s) => s.trim()).filter(Boolean), properties };
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
