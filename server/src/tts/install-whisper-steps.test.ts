import { describe, it, expect, vi } from 'vitest';
import {
  whisperPipInstallArgs,
  installFasterWhisper,
  // @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
} from '../../tts-sidecar/scripts/install-whisper.mjs';

describe('whisperPipInstallArgs', () => {
  it('constrains the install and does NOT pass -U', () => {
    const args = whisperPipInstallArgs('/tmp/constraints.txt');
    expect(args).toEqual(['-m', 'pip', 'install', 'faster-whisper', '-c', '/tmp/constraints.txt']);
    expect(args).not.toContain('-U');
  });
});

describe('installFasterWhisper', () => {
  it('calls run with EXACTLY whisperPipInstallArgs(<the written constraints path>)', () => {
    const run = vi.fn(() => 0);
    const writeConstraints = vi.fn(() => '/tmp/constraints.txt');
    const status = installFasterWhisper('/venv/python', { FOO: '1' }, { run, writeConstraints });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      '/venv/python',
      whisperPipInstallArgs('/tmp/constraints.txt'),
      { FOO: '1' },
    );
    expect(status).toBe(0);
  });

  it('propagates a non-zero run status (the failure path main() checks)', () => {
    const run = vi.fn(() => 1);
    const writeConstraints = vi.fn(() => '/tmp/constraints.txt');
    expect(installFasterWhisper('/venv/python', {}, { run, writeConstraints })).toBe(1);
  });
});
