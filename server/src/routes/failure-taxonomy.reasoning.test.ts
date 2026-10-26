import { describe, it, expect, beforeEach } from 'vitest';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { AnalyzerCapabilityRejectedError, AnalyzerReasoningOverflowError, AnalyzerReasoningUnavailableError } from '../analyzer/errors.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

beforeEach(() => _resetUserSettingsCache());

describe('analyzer-reasoning-overflow names the reasoning control', () => {
  it('Ollama → the Ollama reasoning setting sent as think', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', 812), 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-reasoning-overflow');
    expect(f.userMessage).not.toContain('Lower reasoning');
    expect(f.remediation).toContain('Lower reasoning in the Ollama reasoning setting');
    expect(f.remediation).toContain('the Ollama reasoning setting (Advanced settings → Analyzer request controls; sent as "think")');
  });
  it('Gemma 4 → thinkingLevel, off sends MINIMAL', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemma-4-31b-it', 8192), 'Gemma 4');
    expect(f.remediation).toContain('sent as thinkingLevel — "off" sends MINIMAL');
  });
  it('Gemini 2.5 Flash → has no row (F2), reads the same as an unknown id', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-2.5-flash', 8192), 'Gemini 2.5 Flash');
    expect(f.remediation).toContain("this model's reasoning cannot be controlled from Castwright yet");
    expect(f.remediation).not.toContain('Lower reasoning in');
    expect(f.remediation).toContain('Reasoning: the Gemini reasoning setting for gemini-2.5-flash');
  });
  it('Gemini 3.6 Flash → thinkingLevel, cannot turn thinking off', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8192), 'Gemini 3.6 Flash');
    expect(f.remediation).toContain('sent as thinkingLevel — this model cannot turn thinking off, the lowest level is minimal');
  });
  it('an endpoint id resolves the endpoint name and its control style', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'any', contextTokens: 32768, reasoningStyle: 'enable_thinking', reasoning: 'on' })],
    });
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('openai', 'qwen3-30b', undefined, { endpointId: 'lab' }), 'Lab box · qwen3-30b');
    expect(f.remediation).toContain('the "Lab box" endpoint\'s Reasoning setting (sent as chat_template_kwargs.enable_thinking)');
  });
  it('a bare endpoint model falls back to generic endpoint wording', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('openai', 'qwen3-30b', undefined), 'qwen3-30b');
    expect(f.remediation).toContain("this endpoint's Reasoning setting");
  });
});

describe('a pre-run refusal names the reasoning setting', () => {
  it('maps to analyzer-request-rejected and names the level and Test date', () => {
    const f = classifyAnalysisFailure(new AnalyzerCapabilityRejectedError('qwen3.5:4b', 'reasoning', 'on', '2026-09-11T10:00:00.000Z'), 'Ollama (qwen3.5:4b)');
    expect(f.code).toBe('analyzer-request-rejected');
    expect(f.userMessage).toMatch(/reasoning/i);
    expect(f.userMessage).toContain('reasoning=on');
    expect(f.userMessage).toContain('2026-09-11');
  });
  it('a reasoning refusal remediation names the reasoning setting (REQUEST_SHAPING_SETTINGS)', () => {
    const f = classifyAnalysisFailure(new AnalyzerCapabilityRejectedError('qwen3.5:4b', 'reasoning', 'on', '2026-09-11T10:00:00.000Z'), 'Ollama (qwen3.5:4b)');
    expect(f.remediation).toContain('the Ollama reasoning setting (Advanced settings → Analyzer request controls)');
  });
});

describe('a level that reached a call mid-run is coded too (N10)', () => {
  it('names the setting and says the run stopped, not that it never started', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningUnavailableError('q:4b', 'xhigh', 'local', 'mid-run'), 'Ollama (q:4b)');
    expect(f.code).toBe('analyzer-request-rejected');
    expect(f.userMessage).toContain('stopped');
    expect(f.userMessage).not.toContain('was not started');
    expect(f.userMessage).toContain('"xhigh"');
    expect(f.userMessage).toContain('Advanced settings → Analyzer request controls');
  });
});

describe('a stored level no longer offered is refused before start (P17)', () => {
  it('maps a stored level no longer offered to analyzer-request-rejected before start, naming where the setting lives', () => {
    const f = classifyAnalysisFailure(new AnalyzerReasoningUnavailableError('gemini-3.8-flash', 'minimal', 'gemini'), 'Gemini 3.8 Flash');
    expect(f.code).toBe('analyzer-request-rejected');
    expect(f.userMessage).toContain('was not started');
    expect(f.userMessage).toContain('"minimal"');
    expect(f.userMessage).toContain('Advanced settings → Analyzer request controls');
    const endpoint = classifyAnalysisFailure(new AnalyzerReasoningUnavailableError('openai:lab::m', 'xhigh', 'openai'), 'Lab · m');
    expect(endpoint.code).toBe('analyzer-request-rejected');
    expect(endpoint.userMessage).toContain("the endpoint's Reasoning setting");
    expect(endpoint.userMessage).not.toContain('Analyzer request controls');
  });
});
