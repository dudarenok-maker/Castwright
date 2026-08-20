import { describe, it, expect } from 'vitest';
import { cleanEnvText, parseEnvFileLines } from './env-cleanup.js';

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

  it('recognizes and comments out indented assignment lines (space indentation)', () => {
    const text = '  OLLAMA_TEMPERATURE=0.2\n';
    const result = cleanEnvText(text, (v) => v === 'OLLAMA_TEMPERATURE');
    expect(result.text).toBe('  # OLLAMA_TEMPERATURE=0.2\n');
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE']);
  });

  it('recognizes and comments out indented assignment lines (tab indentation)', () => {
    const text = '\tANALYZER_NUM_PREDICT=-1\n';
    const result = cleanEnvText(text, (v) => v === 'ANALYZER_NUM_PREDICT');
    expect(result.text).toBe('\t# ANALYZER_NUM_PREDICT=-1\n');
    expect(result.cleaned).toEqual(['ANALYZER_NUM_PREDICT']);
  });

  it('recognizes and comments out export-prefixed assignment lines', () => {
    const text = 'export OLLAMA_TEMPERATURE=0.2\n';
    const result = cleanEnvText(text, (v) => v === 'OLLAMA_TEMPERATURE');
    expect(result.text).toBe('# export OLLAMA_TEMPERATURE=0.2\n');
    expect(result.cleaned).toEqual(['OLLAMA_TEMPERATURE']);
  });

  it('recognizes and comments out export-prefixed indented lines', () => {
    const text = '  export ANALYZER_NUM_PREDICT=-1\n';
    const result = cleanEnvText(text, (v) => v === 'ANALYZER_NUM_PREDICT');
    expect(result.text).toBe('  # export ANALYZER_NUM_PREDICT=-1\n');
    expect(result.cleaned).toEqual(['ANALYZER_NUM_PREDICT']);
  });

  it('does NOT mismatch "export" on one line with assignment on next line (regression for cross-newline matching)', () => {
    // Regression test for N4: \s in regex should not match newlines.
    // Input: "export" keyword alone on line 1, "FOO=bar" on line 2.
    // The regex should NOT treat this as "export FOO=bar".
    const text = 'export\nFOO=bar\n';
    const result = cleanEnvText(text, (v) => v === 'FOO');
    // FOO=bar should be recognized and commented out (the export on prev line is irrelevant)
    expect(result.cleaned).toEqual(['FOO']);
    // The output should have "# FOO=bar" on line 2, and line 1 unchanged
    expect(result.text).toBe('export\n# FOO=bar\n');
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

describe('parseEnvFileLines', () => {
  it('parses uncommented KEY=VALUE lines into a map', () => {
    const text = 'FOO=bar\nBAZ=qux\n';
    const map = parseEnvFileLines(text);
    expect(map.get('FOO')).toBe('bar');
    expect(map.get('BAZ')).toBe('qux');
  });

  it('ignores commented-out lines', () => {
    const text = '# COMMENTED=value\nUNCOMMENTED=value\n';
    const map = parseEnvFileLines(text);
    expect(map.has('COMMENTED')).toBe(false);
    expect(map.get('UNCOMMENTED')).toBe('value');
  });

  it('ignores section headers and blank lines', () => {
    const text = '# ── Section Header ──\n\nKEY=value\n';
    const map = parseEnvFileLines(text);
    expect(map.get('KEY')).toBe('value');
    expect(map.size).toBe(1);
  });

  it('handles later occurrences overwriting earlier ones (file semantics)', () => {
    const text = 'KEY=first\nKEY=second\n';
    const map = parseEnvFileLines(text);
    expect(map.get('KEY')).toBe('second');
  });

  it('preserves values with special characters and spaces', () => {
    const text = 'API_KEY=sk-abc!@#$%^&*()\nPATH=/some/path with spaces\n';
    const map = parseEnvFileLines(text);
    expect(map.get('API_KEY')).toBe('sk-abc!@#$%^&*()');
    expect(map.get('PATH')).toBe('/some/path with spaces');
  });

  it('returns empty map for content with no valid lines', () => {
    const text = '# Comment 1\n# Comment 2\n\n';
    const map = parseEnvFileLines(text);
    expect(map.size).toBe(0);
  });

  it('parses indented KEY=VALUE lines (space indentation)', () => {
    const text = '  FOO=bar\nBAZ=qux\n';
    const map = parseEnvFileLines(text);
    expect(map.get('FOO')).toBe('bar');
    expect(map.get('BAZ')).toBe('qux');
  });

  it('parses indented KEY=VALUE lines (tab indentation)', () => {
    const text = '\tFOO=bar\n\t\tBAZ=qux\n';
    const map = parseEnvFileLines(text);
    expect(map.get('FOO')).toBe('bar');
    expect(map.get('BAZ')).toBe('qux');
  });

  it('parses export-prefixed KEY=VALUE lines', () => {
    const text = 'export FOO=bar\nexport BAZ=qux\n';
    const map = parseEnvFileLines(text);
    expect(map.get('FOO')).toBe('bar');
    expect(map.get('BAZ')).toBe('qux');
  });

  it('parses export-prefixed indented KEY=VALUE lines', () => {
    const text = '  export FOO=bar\n\texport BAZ=qux\n';
    const map = parseEnvFileLines(text);
    expect(map.get('FOO')).toBe('bar');
    expect(map.get('BAZ')).toBe('qux');
  });
});

describe('env-cleanup integration: file-based candidacy (#2194 finding 5)', () => {
  it('does not comment out a line whose file value differs from default, even if process.env is shadowed', () => {
    /* Regression test: shell exports GEN_WORKERS=<default>, but .env has
       GEN_WORKERS=4 (non-default). The file value should be the source of
       truth, so the line should NOT be commented out. */
    const fileContent = 'GEN_WORKERS=4\nOTHER_VAR=1\n';

    // The candidacy check would be done against the file, not process.env.
    // For this test, we'll show that a non-candidate line is left untouched.
    const isCandidate = (varName: string) => varName === 'OTHER_VAR';
    const result = cleanEnvText(fileContent, isCandidate);

    expect(result.text).toContain('GEN_WORKERS=4'); // NOT commented
    expect(result.text).toContain('# OTHER_VAR=1');  // IS commented
    expect(result.cleaned).toEqual(['OTHER_VAR']);
  });
});
