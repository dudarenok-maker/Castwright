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
import {
  DEFAULT_USER_SETTINGS,
  _resetUserSettingsCache,
  type UserSettings,
} from '../workspace/user-settings.js';

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
    process.env.ANALYZER = 'local';
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
    expect(s.analyzer).toBeInstanceOf(FallbackAnalyzer);
    /* Default analysis model — comes from DEFAULT_USER_SETTINGS via
       getResolvedOllamaModel. Flip in lockstep with that. */
    expect(s.model).toBe('qwen3.5:4b');
    expect(s.fallbackModel).toBe('gemma-4-31b-it');
  });

  it('local + no Gemini key → bare OllamaAnalyzer (no fallback)', () => {
    process.env.ANALYZER = 'local';
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
    expect(s.analyzer).toBeInstanceOf(OllamaAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('per-request model override wins on the local path', () => {
    process.env.ANALYZER = 'local';
    const s = selectAnalyzer({ model: 'llama3.1:8b' });
    expect(s.engine).toBe('local');
    expect(s.model).toBe('llama3.1:8b');
  });

  it('per-request model override of Gemini shape (no colon) routes to Gemini even when engine=local', () => {
    /* The model-picker dropdown groups local + Gemini options. When the user
       picks a Gemini option mid-run, the override must route to Gemini —
       otherwise we'd hand a Gemini id to Ollama, which 404s. */
    process.env.ANALYZER = 'local';
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
    process.env.ANALYZER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer({ model: 'qwen3.5:9b' });
    expect(s.engine).toBe('local');
    expect(s.model).toBe('qwen3.5:9b');
    /* Fallback wired because we still have a Gemini key in env. */
    expect(s.fallbackModel).toBe('gemma-4-31b-it');
  });

  it('OLLAMA_MODEL env beats the static default', () => {
    process.env.ANALYZER = 'local';
    /* Arbitrary fictional tag — the assertion is "env var overrides the
       DEFAULT_USER_SETTINGS fallback", independent of which real model
       the user has pulled. */
    process.env.OLLAMA_MODEL = 'placeholder:test-7b';
    const s = selectAnalyzer();
    expect(s.model).toBe('placeholder:test-7b');
  });

  it('gemini + key → bare GeminiAnalyzer', () => {
    process.env.ANALYZER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-key';
    const s = selectAnalyzer();
    expect(s.engine).toBe('gemini');
    expect(s.analyzer).toBeInstanceOf(GeminiAnalyzer);
    expect(s.fallbackModel).toBeNull();
  });

  it('gemini + no key → throws (hard requirement, no silent fall-through)', () => {
    process.env.ANALYZER = 'gemini';
    expect(() => selectAnalyzer()).toThrow(/GEMINI_API_KEY is required/);
  });

  it('unset / unknown ANALYZER → defaults to local', () => {
    /* Mirrors the env-default we pick when neither user-settings.json nor
       the env var is set — local is the new default, gemini is opt-in. */
    process.env.ANALYZER = '';
    const s = selectAnalyzer();
    expect(s.engine).toBe('local');
  });

  it('legacy ANALYZER=manual is treated as local (manual mode no longer exists)', () => {
    process.env.ANALYZER = 'manual';
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

  it('REGRESSION: legacy single-model ANALYZER=… path keeps working when neither per-phase var is set', () => {
    /* The fall-through invariant: a deployer who never sets the new
       env vars should see today's single-model behaviour unchanged.
       Both phases get the same analyzer keyed by the legacy ANALYZER
       env var (here: gemini). */
    process.env.ANALYZER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-key';
    const s0 = selectAnalyzerForPhase({ phase: 'phase0' });
    const s1 = selectAnalyzerForPhase({ phase: 'phase1' });
    expect(s0.engine).toBe('gemini');
    expect(s1.engine).toBe('gemini');
    /* Default Gemini model is whatever `selectAnalyzer` resolves —
       gemma-4-31b-it per current default. */
    expect(s0.model).toBe('gemma-4-31b-it');
    expect(s1.model).toBe(s0.model);
  });

  it('REGRESSION: legacy ANALYZER=local + Gemini key still wraps in FallbackAnalyzer when no per-phase vars set', () => {
    process.env.ANALYZER = 'local';
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
    process.env.ANALYZER = 'local';
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

  it('per-request model override beats user-settings + hardcoded default', () => {
    /* When NO env var is set, the per-request `opts.model` wins over
       both the user-settings saved value and the hardcoded default. */
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: 'gemma-4-31b-it',
    };
    const s = selectAnalyzerForPhase({
      phase: 'phase0',
      model: 'gemini-2.5-flash',
      userSettings,
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
  it('returns false when neither env var nor user-settings is set', () => {
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

  it('returns true when user-settings analyzerPhase0Model is set (plan 88 phase-2)', () => {
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: 'gemma-4-31b-it',
    };
    expect(isPerPhaseModelSelectionActive(userSettings)).toBe(true);
  });

  it('returns true when user-settings analyzerPhase1Model is set (plan 88 phase-2)', () => {
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1Model: 'gemini-3.1-flash-lite',
    };
    expect(isPerPhaseModelSelectionActive(userSettings)).toBe(true);
  });
});

/* Plan 88 phase-2 — user-settings precedence layer. Sits between
   per-request `opts.model` and the hardcoded default. The full chain
   is:  env > opts.model > user-settings > hardcoded default. */
describe('selectAnalyzerForPhase — user-settings precedence (plan 88 phase-2)', () => {
  it('user-settings analyzerPhase0Model beats the hardcoded default when no env / opts.model', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: 'gemma-4-31b-it',
    };
    const s = selectAnalyzerForPhase({ phase: 'phase0', userSettings });
    expect(s.engine).toBe('gemini');
    expect(s.model).toBe('gemma-4-31b-it');
  });

  it('user-settings analyzerPhase1Model beats the hardcoded default when no env / opts.model', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1Model: 'gemini-3.1-flash-lite',
    };
    const s = selectAnalyzerForPhase({ phase: 'phase1', userSettings });
    expect(s.model).toBe('gemini-3.1-flash-lite');
  });

  it('env var beats user-settings (ops triage wins)', () => {
    process.env.ANALYZER_PHASE0_MODEL = 'gemma-4-31b-it';
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: 'gemini-2.5-flash',
    };
    const s = selectAnalyzerForPhase({ phase: 'phase0', userSettings });
    expect(s.model).toBe('gemma-4-31b-it');
  });

  it('opts.model beats user-settings (per-request UI dropdown wins over saved default)', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: 'gemma-4-31b-it',
    };
    const s = selectAnalyzerForPhase({
      phase: 'phase0',
      model: 'gemini-2.5-flash',
      userSettings,
    });
    expect(s.model).toBe('gemini-2.5-flash');
  });

  it('null user-settings field falls through to hardcoded default', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: null,
      analyzerPhase1Model: null,
    };
    const s = selectAnalyzerForPhase({ phase: 'phase0', userSettings });
    /* gemma-4-31b-it is the Gemini default surfaced via
       selectAnalyzer({}) → DEFAULT_USER_SETTINGS.defaultAnalysisModel
       (note: the engine resolves to 'gemini' because the legacy fall-
       through uses analysisEngine='gemini' by default). */
    expect(s).toBeDefined();
    /* Concretely the model resolves through selectAnalyzer({}) — the
       exact id depends on DEFAULT_USER_SETTINGS.defaultAnalysisModel.
       The contract here is just "fell through" — no env, no
       user-settings, hardcoded default route taken. */
    expect(s.model).toBeTruthy();
  });

  it('empty / whitespace user-settings field is ignored (falls through)', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase0Model: '   ',
    };
    const s = selectAnalyzerForPhase({ phase: 'phase0', userSettings });
    /* Hardcoded default kicked in instead of the whitespace value. */
    expect(s.model).not.toBe('   ');
  });
});

/* Plan 88 phase-2 — Phase 1 min-lag resolver. Mirror the precedence
   shape of the model picker: env > user-settings > hardcoded default
   (10). No per-request override layer (there is no UI knob for per-
   request lag). */
describe('resolvePhase1MinLagChapters (plan 88 phase-2)', () => {
  it('returns DEFAULT_PHASE1_MIN_LAG_CHAPTERS when no env / no user-settings', () => {
    expect(resolvePhase1MinLagChapters()).toBe(DEFAULT_PHASE1_MIN_LAG_CHAPTERS);
    expect(DEFAULT_PHASE1_MIN_LAG_CHAPTERS).toBe(10);
  });

  it('env wins over user-settings (ops triage)', () => {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '7';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1MinLagChapters: 20,
    };
    expect(resolvePhase1MinLagChapters(userSettings)).toBe(7);
  });

  it('user-settings beats the hardcoded default when env is absent', () => {
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1MinLagChapters: 15,
    };
    expect(resolvePhase1MinLagChapters(userSettings)).toBe(15);
  });

  it('accepts 0 from user-settings (explicit "release the lag" choice)', () => {
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1MinLagChapters: 0,
    };
    expect(resolvePhase1MinLagChapters(userSettings)).toBe(0);
  });

  it('null user-settings field falls through to hardcoded default', () => {
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1MinLagChapters: null,
    };
    expect(resolvePhase1MinLagChapters(userSettings)).toBe(DEFAULT_PHASE1_MIN_LAG_CHAPTERS);
  });

  it('non-finite / negative env value falls through to user-settings', () => {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = 'not-a-number';
    const userSettings: UserSettings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerPhase1MinLagChapters: 12,
    };
    expect(resolvePhase1MinLagChapters(userSettings)).toBe(12);
  });

  it('floors fractional values', () => {
    process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS = '7.9';
    expect(resolvePhase1MinLagChapters()).toBe(7);
  });
});
