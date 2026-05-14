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
import { _resetUserSettingsCache } from '../workspace/user-settings.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  _resetUserSettingsCache();
  /* Clear analysis-related env so each case sets only what it needs. */
  delete process.env.ANALYZER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_MODEL;
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
    process.env.OLLAMA_MODEL = 'mistral:7b';
    const s = selectAnalyzer();
    expect(s.model).toBe('mistral:7b');
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
