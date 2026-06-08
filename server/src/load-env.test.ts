import { describe, it, expect } from 'vitest';
import { formatMissingEnvWarning } from './load-env.js';

describe('formatMissingEnvWarning', () => {
  it('names the CWD and the unloaded knobs so a wrong-CWD launch self-diagnoses', () => {
    const msg = formatMissingEnvWarning('C:\\wrong\\cwd');
    expect(msg).toContain('C:\\wrong\\cwd');
    expect(msg).toContain('DEFAULTS');
    expect(msg).toMatch(/GEN_WORKERS|GPU_VRAM_BUDGET|WORKSPACE_DIR/);
  });
});
