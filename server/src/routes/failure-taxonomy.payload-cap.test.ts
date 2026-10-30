import { describe, it, expect, beforeEach } from 'vitest';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { FAILURE_REMEDIATIONS } from './failure-remediations.js';
import { AnalyzerReasoningOverflowError } from '../analyzer/errors.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());
const STATIC = FAILURE_REMEDIATIONS['analyzer-reasoning-overflow'].remediation;

describe('analyzer-reasoning-overflow names the payload key that set the output cap (#3084 wave 5b, N13, 5b-D1/D2/D3)', () => {
  it('Ollama: the key from the error, in the Ollama custom parameters; the static steps still follow; the headline is unchanged', () => {
    const err = new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', 400, { payloadCapKey: 'options.num_predict', payloadCapRemoved: false });
    const f = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-reasoning-overflow');
    expect(f.remediation).toContain(
      'Raise the custom parameter "options.num_predict" in the Ollama custom parameters (Advanced settings → Analyzer request controls)',
    );
    expect(f.remediation).toContain("so the 'Ollama num_predict' setting has no effect");
    expect(f.remediation.endsWith(STATIC)).toBe(true);
    expect(f.userMessage).not.toContain('custom parameter');
  });
  it("an endpoint: the key in that endpoint's custom parameters, named through the leaf gate by err.endpointId", () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768 })],
    });
    const err = new AnalyzerReasoningOverflowError('openai', 'qwen3-30b', undefined, { endpointId: 'lab', payloadCapKey: 'max_completion_tokens', payloadCapRemoved: false });
    const remediation = classifyAnalysisFailure(err, 'Lab box · qwen3-30b').remediation;
    expect(remediation).toContain('Raise the custom parameter "max_completion_tokens" in the "Lab box" endpoint\'s custom parameters');
    expect(remediation).toContain("so this endpoint's Max output tokens field has no effect");
  });
  it('a payload that removes the cap says "Set a value for" (5b-D3)', () => {
    const err = new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8192, { payloadCapKey: 'config.maxOutputTokens', payloadCapRemoved: true });
    const f = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(f.remediation).toContain('Set a value for the custom parameter "config.maxOutputTokens" in the Gemini custom parameters');
    expect(f.remediation).not.toContain('Raise the custom parameter');
    expect(f.remediation).toContain("so the 'Gemini max output tokens' setting has no effect");
  });
  it("no payload key: the remediation is 5a's (a reasoning lead, then the static steps)", () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8192), 'Gemini 3.6 Flash');
    expect(f.remediation).not.toContain('custom parameter');
    expect(f.remediation.startsWith('Lower reasoning in') || f.remediation.startsWith('Reasoning:')).toBe(true);
    expect(f.remediation.endsWith(STATIC)).toBe(true);
  });
  it('the key is read from the error, never from live settings: a saved cap the request did not carry names nothing', () => {
    _setUserSettingsCacheForTest({ analyzerExtraParamsByEngine: { ollama: { options: { num_predict: 512 } } } });
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', 400), 'Ollama (qwen3.5:4b)');
    expect(f.remediation).not.toContain('custom parameter');
  });
});
