import { describe, it, expect } from 'vitest';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { whisperPipInstallArgs } from '../../tts-sidecar/scripts/install-whisper.mjs';

describe('whisperPipInstallArgs', () => {
  it('constrains the install and does NOT pass -U', () => {
    const args = whisperPipInstallArgs('/tmp/constraints.txt');
    expect(args).toEqual(['-m', 'pip', 'install', 'faster-whisper', '-c', '/tmp/constraints.txt']);
    expect(args).not.toContain('-U');
  });
});
