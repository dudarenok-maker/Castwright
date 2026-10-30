import { describe, it, expect } from 'vitest';
import cases from '../../server/src/analyzer/__fixtures__/extra-params-cases.json';
import { parseExtraParamsText, payloadSetsOutputCap, requestControlsLabelParts, type PayloadKind } from './extra-params';

describe('frontend payload helpers match the server case table', () => {
  it.each(cases as Array<{ kind: PayloadKind; params: Record<string, unknown>; controlsOutputCap: boolean; labelParts: string[] }>)(
    '$kind $params',
    ({ kind, params, controlsOutputCap, labelParts }) => {
      expect(payloadSetsOutputCap(kind, params)).toBe(controlsOutputCap);
      expect(requestControlsLabelParts(kind, params)).toEqual(labelParts);
    },
  );
});

describe('parseExtraParamsText', () => {
  it('blank means no payload', () => expect(parseExtraParamsText('  ')).toEqual({ ok: true, value: undefined }));
  it('parses a JSON object', () => expect(parseExtraParamsText('{"top_k": 40}')).toEqual({ ok: true, value: { top_k: 40 } }));
  it('refuses invalid JSON and non-objects with a message', () => {
    expect(parseExtraParamsText('{top_k: 40}')).toEqual({ ok: false, error: 'Not valid JSON.' });
    expect(parseExtraParamsText('[1]')).toEqual({ ok: false, error: 'Must be a JSON object, for example {"top_k": 40}.' });
  });
});
