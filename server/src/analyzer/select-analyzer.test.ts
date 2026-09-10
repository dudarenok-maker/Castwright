/* selectAnalyzer — the dispatch logic that decides which Analyzer
   implementation the route layer uses, and whether to wrap the primary
   in a FallbackAnalyzer. Tested directly so the route-layer test doesn't
   have to spin up SSE plumbing just to assert this.

   The cases that matter (per plan 29):
     - engine='local' + Gemini key set    → FallbackAnalyzer(Ollama, Gemini)
     - engine='local' + no Gemini key     → bare OllamaAnalyzer (no fallback)
     - engine='gemini' + key set          → GeminiAnalyzer
     - engine='gemini' + no key           → throws (hard requirement) */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectAnalyzer, FallbackAnalyzer } from './index.js';
import { OllamaAnalyzer } from './ollama.js';
import { GeminiAnalyzer } from './gemini.js';
import {
  selectAnalyzerForPhase,
  isPerPhaseModelSelectionActive,
  resolvePhase1MinLagChapters,
  DEFAULT_PHASE1_MIN_LAG_CHAPTERS,
} from './select-analyzer.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

/** Test helper — seeds a single `configOverrides` key atop
    DEFAULT_USER_SETTINGS via the synchronous in-process cache (no disk
    round-trip), mirroring the Advanced Settings persisted-override store
    the resolver reads through `readConfigOverrides()`. */
function setConfigOverride(key: string, value: number | boolean | string): void {
  _setUserSettingsCacheForTest({ configOverrides: { [key]: value } });
}

const originalEnv = { ...process.env };

beforeEach(() => {
  _resetUserSettingsCache();
  /* Clear analysis-related env so each case sets only what it needs. */
  delete process.env.ANALYZER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
  delete process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
});

afterEach(() => {
  process.env = { ...originalEnv };
  _resetUserSettingsCache();
});

describe('selectAnalyzer dispatch', () => {
  it('local + Gemini key → FallbackAnalyzer wrapping Ollama with Gemini fallback', () => {
    /* Engine=local is the cold-cache default now (ANALYZER env retired). */
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    /* Default analysis model — comes from DEFAULT_USER_SETTINGS via
       getResolvedOllamaModel. Flip in lockstep with that. */
    expect(s.model).toBe('qwen3.5:4b');
    /* Fallback model resolves through configValue('analyzer.gemini.model')
       (#2179) — with no GEMINI_MODEL env set, that's the registry default. */
    expect(s.fallbackModel).toBe('gemini-3.5-flash-lite');
  });

  it('local + no Gemini key → bare OllamaAnalyzer (no fallback)', () => {
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
    expect(s.analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('local + key + allowCloudFallback OFF → bare OllamaAnalyzer (Part 1 gate, strict-local)', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'local', allowCloudFallback: false });
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
    expect(s.analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(s.analyzer).not.toBeInstanceOf(FallbackAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('local + key + allowCloudFallback ON (default) → FallbackAnalyzer (pins the non-breaking default)', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'local', allowCloudFallback: true });
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    expect(s.fallbackModel).toBe('gemini-3.5-flash-lite');
  });

  /* #2179 — the five direct `process.env.GEMINI_MODEL ?? 'gemma-4-31b-it'`
     readers were converted to `configValue('analyzer.gemini.model')`. The
     property most likely to break in a careless conversion is env-override
     still winning — configValue resolves env before the registry default,
     but only a live assertion proves it. */
  it('GEMINI_MODEL env still overrides the registry default for the fallback model', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
    const s = selectAnalyzer();
    expect(s.fallbackModel).toBe('gemini-3.1-flash-lite');
  });

  it('with GEMINI_MODEL unset, the fallback model is the registry default (gemini-3.5-flash-lite), not the retired gemma-4-31b-it literal', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_MODEL;
    const s = selectAnalyzer();
    expect(s.fallbackModel).toBe('gemini-3.5-flash-lite');
  });

  it('GEMINI_MODEL env overrides the registry default on the direct gemini engine too', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
    const s = selectAnalyzer();
    expect(s.engine).toBe('gemini');
    expect(s.model).toBe('gemini-3.1-flash-lite');
  });

  it('direct gemini engine + no GEMINI_MODEL env → resolves to the registry default', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_MODEL;
    const s = selectAnalyzer();
    expect(s.model).toBe('gemini-3.5-flash-lite');
  });

  it('per-request model override wins on the local path', () => {
    const s = selectAnalyzer({ model: 'llama3.1:8b' });
    expect(s.engine).toBe('local');
    expect(s.model).toBe('llama3.1:8b');
  });

  it('per-request model override of Gemini shape (no colon) routes to Gemini even when engine=local', () => {
    /* The model-picker dropdown groups local + Gemini options. When the user
       picks a Gemini option mid-run, the override must route to Gemini —
       otherwise we'd hand a Gemini id to Ollama, which 404s. */
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer({ model: 'gemini-2.5-flash' });
    expect(s.engine).toBe('gemini');
    expect(s.model).toBe('gemini-2.5-flash');
    /* No fallback wrap when routing directly to Gemini via override. */
    expect(s.fallbackModel).toBeNull();
  });

  it('per-request model override of Ollama shape (contains colon) routes to local even when engine=gemini', () => {
    /* Symmetric: a user on engine=gemini who picks qwen3.5:9b from the
       dropdown should get the local engine for that run. */
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer({ model: 'qwen3.5:9b' });
    expect(s.engine).toBe('local');
    expect(s.model).toBe('qwen3.5:9b');
    /* Fallback wired because we still have a Gemini key in env. */
    expect(s.fallbackModel).toBe('gemini-3.5-flash-lite');
  });

  it('OLLAMA_MODEL env beats the static default', () => {
    /* Arbitrary fictional tag — the assertion is "env var overrides the
       DEFAULT_USER_SETTINGS fallback", independent of which real model
       the user has pulled. */
    process.env.OLLAMA_MODEL = 'placeholder:test-7b';
    const s = selectAnalyzer();
    expect(s.model).toBe('placeholder:test-7b');
  });

  it('gemini + key → bare GeminiAnalyzer', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.engine).toBe('gemini');
    expect(s.analyzer).toBeInstanceOf(GeminiAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('gemini + no key → throws (hard requirement, no silent fall-through)', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    expect(() => selectAnalyzer()).toThrow(/GEMINI_API_KEY is required/);
  });

  it('Part 5 — gemini engine + key → GeminiAnalyzer regardless of allowCloudFallback (explicit selection is never gated)', () => {
    /* The allowCloudFallback gate only governs the LOCAL branch's Gemini
       fallback wrap; a user who explicitly picked Gemini as their engine still
       routes to Gemini even with the gate off. */
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini', allowCloudFallback: false });
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.engine).toBe('gemini');
    expect(s.analyzer).toBeInstanceOf(GeminiAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('no saved engine (cold cache) → defaults to local', () => {
    /* Local is the default; gemini is opt-in via user-settings. */
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
  });

  it('a stray ANALYZER=gemini in env is inert — engine stays local (env retired, Part 0)', () => {
    /* ANALYZER no longer selects the engine; the cold-cache DEFAULT (local)
       wins over any legacy `.env` value. */
    process.env.ANALYZER = 'gemini';
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
  });
});

/* Plan 88 — pipelined two-model analyzer. `selectAnalyzerForPhase`
   sits on top of `selectAnalyzer`: Phase 0 reads `ANALYZER_PHASE0_MODEL`,
   Phase 1 reads `ANALYZER_PHASE1_MODEL`. When neither is set the
   selector falls through to today's single-model `selectAnalyzer`
   for both phases — the regression contract the legacy path needs. */
describe('selectAnalyzerForPhase — plan 88 per-phase selector', () => {
  it('Phase 0 returns the Phase-0 analyzer when ANALYZER_PHASE0_MODEL is set', () => {
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzerForPhase({ phase: 'phase0' });
    expect(s.engine).toBe('gemini');
    expect(s.model).toBe('gemma-4-31b-it');
    expect(s.analyzer).toBeInstanceOf(GeminiAnalyzer);
  });

  it('Phase 1 returns the Phase-1 analyzer when ANALYZER_PHASE1_MODEL is set', () => {
    process.env.ANALYZER_PHASE1_MODEL = 'gemini-3.1-flash-lite';
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzerForPhase({ phase: 'phase1' });
    expect(s.engine).toBe('gemini');
    expect(s.model).toBe('gemini-3.1-flash-lite');
    expect(s.analyzer).toBeInstanceOf(GeminiAnalyzer);
  });

  it('Phase 0 and Phase 1 can pick different models in the same run', () => {
    /* The headline pipeline shape: Gemma drives Phase 0, Gemini-flash
       drives Phase 1. Two independent rate-limit buckets advance in
       parallel. */
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    process.env.ANALYZER_PHASE1_MODEL = 'gemini-3.1-flash-lite';
    process.env.GEMINI_API_KEY = 'test-key';
    const s0 = selectAnalyzerForPhase({ phase: 'phase0' });
    const s1 = selectAnalyzerForPhase({ phase: 'phase1' });
    expect(s0.model).toBe('gemma-4-31b-it');
    expect(s1.model).toBe('gemini-3.1-flash-lite');
    /* Two distinct analyzer instances — the route layer can drive them
       concurrently without sharing in-flight state. */
    expect(s0.analyzer).not.toBe(s1.analyzer);
  });

  it('REGRESSION: single-model path keeps working when neither per-phase var is set', () => {
    /* The fall-through invariant: a deployer who never sets the new
       per-phase env vars should see today's single-model behaviour
       unchanged. Both phases get the same analyzer keyed by the saved
       engine (here: gemini via user-settings). */
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    process.env.GEMINI_API_KEY = 'test-key';
    const s0 = selectAnalyzerForPhase({ phase: 'phase0' });
    const s1 = selectAnalyzerForPhase({ phase: 'phase1' });
    expect(s0.engine).toBe('gemini');
    expect(s1.engine).toBe('gemini');
    /* Default Gemini model is whatever `selectAnalyzer` resolves — the
       registry default (gemini-3.5-flash-lite) via configValue (#2179),
       since no GEMINI_MODEL env / override is set. */
    expect(s0.model).toBe('gemini-3.5-flash-lite');
    expect(s1.model).toBe(s0.model);
  });

  it('REGRESSION: engine=local (default) + Gemini key still wraps in FallbackAnalyzer when no per-phase vars set', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const s0 = selectAnalyzerForPhase({ phase: 'phase0' });
    expect(s0.engine).toBe('local');
    expect(s0.analyzer).toBeInstanceOf(FallbackAnalyzer);
  });

  it('only Phase 0 env var set → Phase 1 falls back to legacy ANALYZER (mixed pipeline still safe)', () => {
    /* Partial activation: deployer sets only ANALYZER_PHASE0_MODEL
       (e.g. wants Gemma for cast but keeps Phase 1 on local Ollama).
       The Phase-1 selector must still return a working analyzer via
       the legacy fall-through. */
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    process.env.GEMINI_API_KEY = 'test-key';
    const s0 = selectAnalyzerForPhase({ phase: 'phase0' });
    const s1 = selectAnalyzerForPhase({ phase: 'phase1' });
    expect(s0.model).toBe('gemma-4-31b-it');
    expect(s0.engine).toBe('gemini');
    expect(s1.engine).toBe('local');
  });

  it('per-phase env var beats the per-request model override (ops triage wins)', () => {
    /* Plan 88 phase-2 — env now takes priority over `opts.model` so an
       ops override at the process boundary can't be silently shadowed
       by a per-request choice. This inverts the plan-88-phase-1
       precedence (where opts.model won); the Account-tab surface is a
       user-default override, env stays the triage trump card. */
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzerForPhase({ phase: 'phase0', model: 'gemini-2.5-flash' });
    expect(s.model).toBe('gemma-4-31b-it');
  });

  it('per-request model override beats a saved Advanced Settings override + hardcoded default', () => {
    /* When NO env var is set, the per-request `opts.model` wins over
       both the saved Advanced Settings override and the hardcoded default. */
    process.env.GEMINI_API_KEY = 'test-key';
    setConfigOverride('analyzer.phase0.model', 'gemma-4-31b-it');
    const s = selectAnalyzerForPhase({
      phase: 'phase0',
      model: 'gemini-2.5-flash',
    });
    expect(s.model).toBe('gemini-2.5-flash');
  });

  it('Ollama-shape Phase 0 env var routes to local engine (engine inferred from id)', () => {
    /* The per-phase env vars accept either Gemini ids or Ollama tags;
       the existing `inferEngineFromModelId` heuristic decides which
       engine handles them. A deployer can pipe local-Ollama for Phase
       0 and Gemini for Phase 1 if they want. */
    process.env.ANALYZER_PHASE0_MODEL = 'qwen3.5:4b';
    const s = selectAnalyzerForPhase({ phase: 'phase0' });
    expect(s.engine).toBe('local');
    expect(s.model).toBe('qwen3.5:4b');
    expect(s.analyzer).toBeInstanceOf(OllamaAnalyzer);
  });
});

describe('isPerPhaseModelSelectionActive', () => {
  it('returns false when neither env nor a saved Advanced Settings override is set', () => {
    expect(isPerPhaseModelSelectionActive()).toBe(false);
  });

  it('returns true when ANALYZER_PHASE0_MODEL is set', () => {
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    expect(isPerPhaseModelSelectionActive()).toBe(true);
  });

  it('returns true when ANALYZER_PHASE1_MODEL is set', () => {
    process.env.ANALYZER_PHASE1_MODEL = 'gemini-3.1-flash-lite';
    expect(isPerPhaseModelSelectionActive()).toBe(true);
  });

  it('returns true when a saved analyzer.phase0.model override is set (#3141 step 1)', () => {
    setConfigOverride('analyzer.phase0.model', 'gemma-4-31b-it');
    expect(isPerPhaseModelSelectionActive()).toBe(true);
  });

  it('returns true when a saved analyzer.phase1.model override is set (#3141 step 1)', () => {
    setConfigOverride('analyzer.phase1.model', 'gemini-3.1-flash-lite');
    expect(isPerPhaseModelSelectionActive()).toBe(true);
  });
});

/* #3141 step 1 — saved Advanced Settings override precedence layer. Sits
   between per-request `opts.model` and the hardcoded default. The full
   chain is: env > opts.model > saved override > hardcoded default. */
describe('selectAnalyzerForPhase — saved Advanced Settings override precedence (#3141 step 1)', () => {
  it('a saved analyzer.phase0.model override beats the hardcoded default when no env / opts.model', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    setConfigOverride('analyzer.phase0.model', 'gemma-4-31b-it');
    const s = selectAnalyzerForPhase({ phase: 'phase0' });
    expect(s.engine).toBe('gemini');
    expect(s.model).toBe('gemma-4-31b-it');
  });

  it('a saved analyzer.phase1.model override beats the hardcoded default when no env / opts.model', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    setConfigOverride('analyzer.phase1.model', 'gemini-3.1-flash-lite');
    const s = selectAnalyzerForPhase({ phase: 'phase1' });
    expect(s.model).toBe('gemini-3.1-flash-lite');
  });

  it('env var beats a saved override (ops triage wins)', () => {
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    process.env.GEMINI_API_KEY = 'test-key';
    setConfigOverride('analyzer.phase0.model', 'gemini-2.5-flash');
    const s = selectAnalyzerForPhase({ phase: 'phase0' });
    expect(s.model).toBe('gemma-4-31b-it');
  });

  it('opts.model beats a saved override (per-request UI dropdown wins over saved default)', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    setConfigOverride('analyzer.phase0.model', 'gemma-4-31b-it');
    const s = selectAnalyzerForPhase({
      phase: 'phase0',
      model: 'gemini-2.5-flash',
    });
    expect(s.model).toBe('gemini-2.5-flash');
  });

  it('no saved override falls through to hardcoded default', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzerForPhase({ phase: 'phase0' });
    /* The model falls through to selectAnalyzer({}); with the local-first
       default (Part 0) the engine resolves to 'local' on a cold cache and
       the model to the resolved Ollama tag. The contract here is just
       "fell through" — no env, no saved override, hardcoded default. */
    expect(s).toBeDefined();
    expect(s.model).toBeTruthy();
  });

  it('empty / whitespace saved override is ignored (falls through)', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    setConfigOverride('analyzer.phase0.model', '   ');
    const s = selectAnalyzerForPhase({ phase: 'phase0' });
    /* Hardcoded default kicked in instead of the whitespace value. */
    expect(s.model).not.toBe('   ');
  });
});

/* #3141 step 1 — Phase 1 min-lag resolver, rewired onto the config
   resolver. Mirrors the precedence shape of the model picker: env > saved
   Advanced Settings override > hardcoded default (10). No per-request
   override layer (there is no UI knob for per-request lag). */
describe('resolvePhase1MinLagChapters (#3141 step 1)', () => {
  it('returns DEFAULT_PHASE1_MIN_LAG_CHAPTERS when no env / no saved override', () => {
    expect(resolvePhase1MinLagChapters()).toBe(DEFAULT_PHASE1_MIN_LAG_CHAPTERS);
    expect(DEFAULT_PHASE1_MIN_LAG_CHAPTERS).toBe(10);
  });

  it('env wins over a saved override (ops triage)', () => {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '7';
    setConfigOverride('analyzer.phase1.minLagChapters', 20);
    expect(resolvePhase1MinLagChapters()).toBe(7);
  });

  it('a saved override beats the hardcoded default when env is absent', () => {
    setConfigOverride('analyzer.phase1.minLagChapters', 15);
    expect(resolvePhase1MinLagChapters()).toBe(15);
  });

  it('accepts 0 from a saved override (explicit "release the lag" choice)', () => {
    setConfigOverride('analyzer.phase1.minLagChapters', 0);
    expect(resolvePhase1MinLagChapters()).toBe(0);
  });

  it('a non-finite/negative saved override falls through to the hardcoded default', () => {
    setConfigOverride('analyzer.phase1.minLagChapters', -1);
    expect(resolvePhase1MinLagChapters()).toBe(DEFAULT_PHASE1_MIN_LAG_CHAPTERS);
  });

  it('non-finite / negative env value falls through to a saved override', () => {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = 'not-a-number';
    setConfigOverride('analyzer.phase1.minLagChapters', 12);
    expect(resolvePhase1MinLagChapters()).toBe(12);
  });

  it('a fractional env value is not a valid integer knob value — falls through to the hardcoded default', () => {
    /* Unlike the old ad-hoc `Number(rawEnv)` + floor, the resolver validates
       `analyzer.phase1.minLagChapters` as an 'integer' knob via
       coerceAndValidate, so a non-integer env string is rejected (with a
       one-shot console.warn) rather than silently floored. */
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '7.9';
    expect(resolvePhase1MinLagChapters()).toBe(DEFAULT_PHASE1_MIN_LAG_CHAPTERS);
  });

  it('floors a fractional saved override', () => {
    /* Overrides aren't re-validated by coerceAndValidate on read (only env
       goes through it), so this exercises resolvePhase1MinLagChapters' own
       Math.floor safety net directly. */
    setConfigOverride('analyzer.phase1.minLagChapters', 7.9);
    expect(resolvePhase1MinLagChapters()).toBe(7);
  });
});
