/* #3525 review (contract drift) — pins openapi.yaml's analyzer-endpoint
   surface to what the routes actually do. Reads openapi.yaml at runtime. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- js-yaml ships no types and this repo carries no @types/js-yaml
import yaml from 'js-yaml';

type Node = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const spec = yaml.load(readFileSync(join(here, '../../../openapi.yaml'), 'utf8')) as Node;
const paths = spec.paths as Node;
const schemas = spec.components.schemas as Node;

describe('openapi.yaml analyzer-endpoint contract', () => {
  it('the DELETE description names only the references the server checks (A5 removed the phase-model fields)', () => {
    const description: string = paths['/api/analyzer/endpoints/{endpointId}'].delete.description;
    expect(description).toContain('defaultAnalysisModel');
    expect(description).toContain('analyzer.phase0.model');
    expect(description).not.toMatch(/\(defaultAnalysisModel, analyzerPhase0Model/);
  });

  it('UserSettingsPatch marks analyzerEndpoints readOnly: PUT /api/user/settings strips it', () => {
    expect(schemas.UserSettingsPatch.properties.analyzerEndpoints.readOnly).toBe(true);
    expect(schemas.UserSettingsPatch.properties.analyzerEndpointKeyStatus.readOnly).toBe(true);
  });

  it('the /key route documents its 400 body as the {error, code, issues} refusal', () => {
    const r400 = paths['/api/analyzer/endpoints/{endpointId}/key'].put.responses['400'];
    expect(r400.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/AnalyzerEndpointRefusal' });
  });

  it('the Detect 400 documents its `details` array of strings', () => {
    const detect = paths['/api/analyzer/endpoints/detect-context'].post.responses['400'];
    expect(detect.content['application/json'].schema.properties.details).toMatchObject({ type: 'array', items: { type: 'string' } });
  });
});
