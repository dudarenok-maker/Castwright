/* #3084 wave 3d review pass 3 (H) — the run's one fallback switch, through the REAL selectors. The job
   tests build their FallbackAnalyzers by hand around job.fallbackSwitch, and the route tests only see a
   mocked selector receive it, so a drop of the switch anywhere below the route (withFallback,
   selectAnalyzerForPhase, either branch of selectAnalyzer) would bring the per-selection switch back with
   those suites green. A phase-0 failure must send phase 1's very next call straight to the target. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { RunFallbackSwitch } from './index.js';
import { selectAnalyzerForPhase } from './select-analyzer.js';
import { OllamaAnalyzer } from './ollama.js';
import { OpenAIAnalyzer } from './openai.js';
import { AnalyzerUnreachableError, LocalUnreachableError } from './errors.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

/* The local target's first call reads the installed digest (fail-open); no daemon in unit tests. */
vi.mock('./ollama-digest.js', () => ({ ollamaModelDigest: vi.fn().mockResolvedValue(undefined) }));

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });
const ENDPOINT = 'openai:lab::qwen3-30b';

afterEach(() => {
  _resetUserSettingsCache();
  vi.restoreAllMocks();
});

describe('selectAnalyzerForPhase — one RunFallbackSwitch spans both phases', () => {
  it('endpoint branch: a phase-0 failure sends phase 1 straight to the target, the primary gets no call', async () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, defaultAnalysisModel: 'qwen3.5:4b', configOverrides: { 'analyzer.fallback.target': 'local' } });
    vi.spyOn(OpenAIAnalyzer.prototype, 'runStage1Chapter').mockRejectedValue(new AnalyzerUnreachableError('connect ECONNREFUSED', 'openai'));
    vi.spyOn(OllamaAnalyzer.prototype, 'runStage1Chapter').mockResolvedValue({} as never);
    const primaryStage2 = vi.spyOn(OpenAIAnalyzer.prototype, 'runStage2Chapter').mockResolvedValue({} as never);
    const targetStage2 = vi.spyOn(OllamaAnalyzer.prototype, 'runStage2Chapter').mockResolvedValue({} as never);
    const fallbackSwitch = new RunFallbackSwitch();
    const phase0 = selectAnalyzerForPhase({ phase: 'phase0', phaseModel: ENDPOINT, fallbackSwitch });
    const phase1 = selectAnalyzerForPhase({ phase: 'phase1', phaseModel: ENDPOINT, fallbackSwitch });
    await phase0.analyzer.runStage1Chapter('m', 1, 'p', {} as never);
    await phase1.analyzer.runStage2Chapter('m', 1, 'p', {} as never);
    expect(primaryStage2).not.toHaveBeenCalled();
    expect(targetStage2).toHaveBeenCalledTimes(1);
  });

  it('Ollama branch: a phase-0 failure sends phase 1 straight to the target, the primary gets no call', async () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, configOverrides: { 'analyzer.fallback.target': ENDPOINT } });
    vi.spyOn(OllamaAnalyzer.prototype, 'runStage1Chapter').mockRejectedValue(new LocalUnreachableError('connect ECONNREFUSED'));
    vi.spyOn(OpenAIAnalyzer.prototype, 'runStage1Chapter').mockResolvedValue({} as never);
    const primaryStage2 = vi.spyOn(OllamaAnalyzer.prototype, 'runStage2Chapter').mockResolvedValue({} as never);
    const targetStage2 = vi.spyOn(OpenAIAnalyzer.prototype, 'runStage2Chapter').mockResolvedValue({} as never);
    const fallbackSwitch = new RunFallbackSwitch();
    const phase0 = selectAnalyzerForPhase({ phase: 'phase0', phaseModel: 'qwen3.5:4b', fallbackSwitch });
    const phase1 = selectAnalyzerForPhase({ phase: 'phase1', phaseModel: 'qwen3.5:9b', fallbackSwitch });
    await phase0.analyzer.runStage1Chapter('m', 1, 'p', {} as never);
    await phase1.analyzer.runStage2Chapter('m', 1, 'p', {} as never);
    expect(primaryStage2).not.toHaveBeenCalled();
    expect(targetStage2).toHaveBeenCalledTimes(1);
  });
  it('engine-default phases (no model named) share the switch as well', async () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {}, configOverrides: { 'analyzer.fallback.target': ENDPOINT } });
    vi.spyOn(OllamaAnalyzer.prototype, 'runStage1Chapter').mockRejectedValue(new LocalUnreachableError('connect ECONNREFUSED'));
    vi.spyOn(OpenAIAnalyzer.prototype, 'runStage1Chapter').mockResolvedValue({} as never);
    const primaryStage2 = vi.spyOn(OllamaAnalyzer.prototype, 'runStage2Chapter').mockResolvedValue({} as never);
    const targetStage2 = vi.spyOn(OpenAIAnalyzer.prototype, 'runStage2Chapter').mockResolvedValue({} as never);
    const fallbackSwitch = new RunFallbackSwitch();
    const phase0 = selectAnalyzerForPhase({ phase: 'phase0', fallbackSwitch });
    const phase1 = selectAnalyzerForPhase({ phase: 'phase1', fallbackSwitch });
    await phase0.analyzer.runStage1Chapter('m', 1, 'p', {} as never);
    await phase1.analyzer.runStage2Chapter('m', 1, 'p', {} as never);
    expect(primaryStage2).not.toHaveBeenCalled();
    expect(targetStage2).toHaveBeenCalledTimes(1);
  });
});
