import { describe, it, expect } from 'vitest';
import { ollamaFormatField } from './ollama-transport.js';
import { geminiStructuredConfig } from './gemini-transport.js';

const schema = { type: 'object', properties: { a: { type: 'string' } } };

describe('structured-output wire mapping (#3084 spec §2 table)', () => {
  it('Ollama: schema → format <schema>, json → format "json", off → no format', () => {
    expect(ollamaFormatField({ mode: 'schema', name: 'n', schema })).toBe(schema);
    expect(ollamaFormatField({ mode: 'json' })).toBe('json');
    expect(ollamaFormatField({ mode: 'off' })).toBeUndefined();
  });
  it('Gemini: schema → mime + responseJsonSchema, json → mime only, off → neither', () => {
    expect(geminiStructuredConfig({ mode: 'schema', name: 'n', schema })).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    });
    expect(geminiStructuredConfig({ mode: 'json' })).toEqual({ responseMimeType: 'application/json' });
    expect(geminiStructuredConfig({ mode: 'off' })).toEqual({});
  });
});
