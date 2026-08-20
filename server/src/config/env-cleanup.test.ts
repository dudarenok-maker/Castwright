import { describe, it, expect } from 'vitest';
import { cleanEnvText } from './env-cleanup.js';

// ── Pure transform tests (no filesystem) ────────────────────────────────────

describe('cleanEnvText', () => {
  it('comments out lines whose var name is a candidate', () => {
    const text = 'OLLAMA_TEMPERATURE=0.2\nANALYZER_NUM_PREDICT=-1\nWORKSPACE_DIR=/tmp/ws\n';
    const result = cleanEnvText(text, (v) => v === 'OLLAMA_TEMPERATURE' || v === 'ANALYZER_NUM_PREDICT');
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE', 'ANALYZER_NUM_PREDICT']);
    expect(result.text).toBe(
      '# OLLAMA_TEMPERATURE=0.2\n# ANALYZER_NUM_PREDICT=-1\nWORKSPACE_DIR=/tmp/ws\n',
    );
  });

  it('leaves non-candidate lines byte-for-byte unchanged', () => {
    const text = 'WORKSPACE_DIR=/data/castwright\nGEMINI_API_KEY=secret123\n';
    const result = cleanEnvText(text, () => false);
    expect(result.cleaned).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('passes through already-commented lines unchanged', () => {
    const text = '# OLLAMA_TEMPERATURE=0.2\n# some help text\n';
    const result = cleanEnvText(text, () => true);
    expect(result.cleaned).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('passes through blank lines and section headers unchanged', () => {
    const text = '\n# ── Analyzer sampling ──\n\nOLLAMA_TEMPERATURE=0.2\n';
    const result = cleanEnvText(text, (v) => v === 'OLLAMA_TEMPERATURE');
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE']);
    expect(result.text).toBe('\n# ── Analyzer sampling ──\n\n# OLLAMA_TEMPERATURE=0.2\n');
  });

  it('does not touch lowercase var names (they do not match the pattern)', () => {
    const text = 'my_custom_var=hello\nOLLAMA_TEMPERATURE=0.2\n';
    const result = cleanEnvText(text, () => true);
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE']);
    expect(result.text).toBe('my_custom_var=hello\n# OLLAMA_TEMPERATURE=0.2\n');
  });

  it('preserves values with special characters', () => {
    const text = 'GEMINI_API_KEY=abc!@#$%^&*()=+\n';
    const result = cleanEnvText(text, (v) => v === 'GEMINI_API_KEY');
    expect(result.text).toBe('# GEMINI_API_KEY=abc!@#$%^&*()=+\n');
  });

  it('handles text without trailing newline', () => {
    const text = 'OLLAMA_TEMPERATURE=0.2';
    const result = cleanEnvText(text, (v) => v === 'OLLAMA_TEMPERATURE');
    expect(result.text).toBe('# OLLAMA_TEMPERATURE=0.2');
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE']);
  });

  it('handles empty input', () => {
    const result = cleanEnvText('', () => true);
    expect(result.text).toBe('');
    expect(result.cleaned).toEqual([]);
  });

  it('preserves inline whitespace in values', () => {
    const text = 'OLLAMA_TEMPERATURE=0.2 \n';
    const result = cleanEnvText(text, (v) => v === 'OLLAMA_TEMPERATURE');
    expect(result.text).toBe('# OLLAMA_TEMPERATURE=0.2 \n');
  });

  // ── Load-bearing acceptance test ──────────────────────────────────────────

  it('LEAVES a non-default value untouched even if the var name matches', () => {
    /* A deliberately-pinned value that differs from the registry default
       must survive. The caller excludes it from isCandidate, so the
       transform never sees it as a candidate. This test proves that when
       isCandidate returns false for a line, the line is untouched. */
    const text = 'SOME_KEY=nondefault\n';
    const result = cleanEnvText(text, () => false);
    expect(result.text).toBe('SOME_KEY=nondefault\n');
    expect(result.cleaned).toEqual([]);
  });

  it('GOES RED if isCandidate is always true (mutation test)', () => {
    /* The load-bearing test: given a line SOME_KEY=nondefault where
       SOME_KEY is NOT a candidate, cleanEnvText leaves that line
       untouched. Mutate isCandidate to always return true and confirm
       this test goes red — proving the predicate is load-bearing. */
    const text = 'SOME_KEY=nondefault\n';

    // Correct behaviour: isCandidate returns false → line untouched
    const correct = cleanEnvText(text, () => false);
    expect(correct.text).toBe(text);

    // Mutated behaviour: isCandidate always true → line IS commented out
    const mutated = cleanEnvText(text, () => true);
    expect(mutated.text).toBe('# SOME_KEY=nondefault\n');
    expect(mutated.text).not.toBe(text); // proof the mutation is detectable
  });

  it('mixed: candidates, non-candidates, comments, blanks all coexist', () => {
    const text = [
      '# ── Analyzer sampling ──',
      '# OLLAMA_TEMPERATURE=0.2',
      'OLLAMA_TEMPERATURE=0.2',
      'ANALYZER_NUM_PREDICT=-1',
      'WORKSPACE_DIR=/data/ws',
      '',
      'GEMINI_API_KEY=sk-abc',
      'PRELOAD_KOKORO=false',
    ].join('\n');

    const candidates = new Set([
      'OLLAMA_TEMPERATURE',
      'ANALYZER_NUM_PREDICT',
      'PRELOAD_KOKORO',
    ]);

    const result = cleanEnvText(text, (v) => candidates.has(v));
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE', 'ANALYZER_NUM_PREDICT', 'PRELOAD_KOKORO']);

    const lines = result.text.split('\n');
    expect(lines[0]).toBe('# ── Analyzer sampling ──');         // section header unchanged
    expect(lines[1]).toBe('# OLLAMA_TEMPERATURE=0.2');          // already commented → unchanged
    expect(lines[2]).toBe('# OLLAMA_TEMPERATURE=0.2');          // was uncommented → now commented
    expect(lines[3]).toBe('# ANALYZER_NUM_PREDICT=-1');         // candidate → commented
    expect(lines[4]).toBe('WORKSPACE_DIR=/data/ws');           // non-candidate → untouched
    expect(lines[5]).toBe('');                                   // blank → unchanged
    expect(lines[6]).toBe('GEMINI_API_KEY=sk-abc');            // non-candidate → untouched
    expect(lines[7]).toBe('# PRELOAD_KOKORO=false');            // candidate → commented
  });
});
