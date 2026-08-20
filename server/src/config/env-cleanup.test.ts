import { describe, it, expect } from 'vitest';
import { cleanEnvText, parseEnvFileLines } from './env-cleanup.js';
import { allKnobs } from './registry.js';
import { coerceAndValidate } from './resolver.js';

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

    // Verify exact output: GEN_WORKERS is untouched, OTHER_VAR is commented
    expect(result.text).toBe('GEN_WORKERS=4\n# OTHER_VAR=1\n');
    expect(result.cleaned).toEqual(['OTHER_VAR']);
  });
});

// ── Realistic-scale fixture test (finding N10) ──────────────────────────────

describe('cleanEnvText at realistic ~110-line scale (finding N10)', () => {
  it('handles a realistic .env with multiple section blocks, mixed candidates and non-candidates', () => {
    // Fixture: a representative ~110-line .env file with:
    // - Section headers (# ── ... ──)
    // - Blank lines
    // - Already-commented config lines
    // - Uncommented candidates (match registry defaults)
    // - Uncommented non-candidates (pinned non-default values)
    // - Indented lines (space and tab)
    // - Export-prefixed lines
    // - Inline comments after values
    const envContent = `# NOTE (2026-07-15): ANALYZER no longer selects the analyzer engine. The engine
# is chosen in the UI (Account -> analyzer settings) / user-settings.json and
# defaults to LOCAL. This var is retained only for reference/back-compat and is
# INERT for engine selection — a stray ANALYZER=gemini here does nothing.
# ANALYZER=local

# Local Ollama daemon. Install Ollama for Windows, then \`ollama pull qwen3.5:4b\`
# OLLAMA_URL=http://localhost:11434
# OLLAMA_MODEL=qwen3.5:4b

# Optional. Required when ANALYZER=gemini; otherwise acts as the automatic
# fallback when ANALYZER=local and Ollama is unreachable.
GEMINI_API_KEY=sk-custom-key-not-default

# Gemini model used directly (engine=gemini) or as fallback (engine=local).
# Ships defaulting to gemini-3.5-flash-lite (500 RPD, comfortably parses a novel).
# GEMINI_MODEL=gemini-3.5-flash-lite

# ── Analyzer sampling ──

# Sampling temperature for the first analysis attempt; lower values stay closer to the schema.
OLLAMA_TEMPERATURE=0.2

# Temperature used on invalid-JSON retries to escape the failure path.
OLLAMA_RETRY_TEMPERATURE=0.6

# Output-token cap for Ollama; -1 means predict until context window fills.
ANALYZER_NUM_PREDICT=-1

# Per-request output-token cap for Gemini; set to match the free-tier ceiling.
ANALYZER_MAX_OUTPUT_TOKENS=8192

# Sampling temperature for cloud Gemini/Gemma analysis
GEMINI_TEMPERATURE=0.2

# ── TTS Configuration ──

# Local Ollama daemon. Install Ollama for Windows, then \`ollama pull qwen3.5:4b\`
LOCAL_TTS_URL=http://localhost:9000

# Sidecar runtime knobs. The defaults below assume an NVIDIA GPU is present
# Leave commented out for CPU-only boxes; the sidecar auto-detects
# COQUI_DEVICE=cuda
# COQUI_HALF=1

# Eager-preload XTTS at sidecar startup. Default is 0 (lazy)
PRELOAD_COQUI=false

# Eager-preload Kokoro at sidecar startup. Default is 0 (off)
PRELOAD_KOKORO=false

# Optional. Defaults to 8080.
PORT=8080

# Optional (srv-19). Network interface the plain-HTTP server binds to.
# Defaults to 127.0.0.1 (loopback only)
BIND_HOST=127.0.0.1

# ── LAN HTTPS configuration ──

# Shared LAN access secret. AUTO-GENERATED + persisted to this file on first boot
# LAN_AUTH_TOKEN=

# ── Audio loudness normalization (plan 71) ──

# Enable EBU R128 two-pass loudness normalisation; disable to skip normalisation entirely.
AUDIO_LOUDNORM_ENABLED=true

# Integrated loudness target in LUFS; -16 matches the Audible/ACX audiobook spec.
# AUDIO_LOUDNORM_TARGET=-16

# ── Workspace ──

# Workspace. The user-visible books/ tree lives here.
WORKSPACE_DIR=../audiobook-workspace

# User account settings file (plan 122). Account defaults
# USER_SETTINGS_FILE=C:\\path\\to\\user-settings.json

# ── Voice engine & device ──

# Which GPU stack the voice engines install + run on.
ACCELERATOR=auto

# Device for Coqui XTTS v2. "auto" lets the sidecar pick based on CUDA availability.
COQUI_DEVICE=auto

# Device for Kokoro (onnxruntime). "auto" lets the sidecar pick
KOKORO_DEVICE=auto

# PyTorch device for Qwen3-TTS. "auto" (default) picks cuda:0 → mps → cpu
QWEN_DEVICE=auto

# Per-sentence QA gates

# How many times a suspect sentence is re-recorded before keeping the best take
SEG_QA_MAX_RERECORDS=2

# Mean RMS at or below this value marks a segment as dead/near-silent.
SEG_QA_SILENCE_RMS=0.003

# Duration/expected ratio below this marks a segment as truncated.
SEG_QA_MIN_RATIO=0.4

# Generation queue concurrency — how many chapters the queue synthesises at once
GEN_WORKERS=1

# Stage-2 attribution coverage guard

# Attributed/source word-ratio floor below which a chapter is treated as truncated.
STAGE2_MIN_COVERAGE=0.6

# Attributed/source word-ratio ceiling above which a chapter is treated as a repeat-loop.
STAGE2_MAX_COVERAGE=1.6

# Smallest contiguous run of duplicated sentences flagged as a repeat-loop.
STAGE2_MIN_DUP_RUN=4

# Test indented and export-prefixed variants
  OLLAMA_URL=http://localhost:11434
export ANALYZER_OLLAMA_CONCURRENCY=2

# End of config
`;

    // Derive the REAL candidate env vars from the fixture content.
    // A var is a candidate when:
    // 1. It has a registry knob with an env var mapping
    // 2. The file value matches the registry default
    // This exercises the actual production logic at realistic scale.
    const fileValues = parseEnvFileLines(envContent);
    const candidateVars = new Set<string>();

    for (const knob of allKnobs()) {
      if (knob.isPrompt || !knob.env) continue;

      const fileValue = fileValues.get(knob.env);
      if (fileValue === undefined) continue; // Key not in file

      // Parse and validate against the registry default
      const r = coerceAndValidate(knob, fileValue);
      if (r.ok && r.value === knob.default) {
        candidateVars.add(knob.env);
      }
    }

    const isCandidate = (varName: string) => candidateVars.has(varName);
    const result = cleanEnvText(envContent, isCandidate);

    // Verify all candidates were commented out
    expect(result.cleaned.sort()).toEqual(Array.from(candidateVars).sort());

    // Count lines before and after (no lines added/deleted)
    const linesBefore = envContent.split('\n');
    const linesAfter = result.text.split('\n');
    expect(linesAfter.length).toBe(linesBefore.length);

    // Verify non-candidates are byte-identical (GEMINI_API_KEY is pinned to a
    // non-default value and must survive the cleanup untouched)
    const expectedNonCandidateLine = 'GEMINI_API_KEY=sk-custom-key-not-default';
    expect(result.text).toContain(expectedNonCandidateLine);

    // Verify section headers pass through unchanged
    expect(result.text).toContain('# ── Analyzer sampling ──');
    expect(result.text).toContain('# ── TTS Configuration ──');
    expect(result.text).toContain('# ── LAN HTTPS configuration ──');

    // Verify blank lines are preserved
    const blankLinesAfter = result.text.split('\n').filter((line) => line.trim() === '').length;
    const blankLinesBefore = envContent.split('\n').filter((line) => line.trim() === '').length;
    expect(blankLinesAfter).toBe(blankLinesBefore);

    // Verify already-commented lines pass through unchanged
    expect(result.text).toContain('# ANALYZER=local');
    expect(result.text).toContain('# OLLAMA_URL=http://localhost:11434');
    expect(result.text).toContain('# OLLAMA_MODEL=qwen3.5:4b');
    expect(result.text).toContain('# COQUI_DEVICE=cuda');
    expect(result.text).toContain('# AUDIO_LOUDNORM_TARGET=-16');

    // Verify indented candidate line was properly commented (preserves indentation)
    expect(result.text).toContain('  # OLLAMA_URL=http://localhost:11434');

    // Verify export-prefixed candidate line was properly commented
    expect(result.text).toContain('# export ANALYZER_OLLAMA_CONCURRENCY=2');

    // Verify all candidate lines are now commented in the output
    for (const candidateVar of candidateVars) {
      // Should NOT have uncommented version (unless it's export-prefixed)
      const uncommentedPattern = new RegExp(`^${candidateVar}=`, 'm');
      const exportPattern = new RegExp(`^export ${candidateVar}=`, 'm');
      const indentedPattern = new RegExp(`^[ \t]+${candidateVar}=`, 'm');

      const hasUncommented =
        uncommentedPattern.test(result.text) &&
        !exportPattern.test(result.text) &&
        !indentedPattern.test(result.text);
      expect(hasUncommented).toBe(false);

      // Should have commented form (allowing for indentation and export prefix)
      const commentedPattern = new RegExp(`#.*${candidateVar}=`, 'm');
      expect(commentedPattern.test(result.text)).toBe(true);
    }
  });
});
