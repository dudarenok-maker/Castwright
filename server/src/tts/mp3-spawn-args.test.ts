/* Spawn-args coverage for encodePcmToAudio (plan 71). This is a sibling to
   mp3.test.ts's real-ffmpeg integration suite — that suite mustn't mock
   node:child_process (the value is exercising the real subprocess), so the
   arg-inspection tests live in their own file with a module-level mock.

   What we lock down:
   - Legacy call shape (no `loudnorm` option) emits NO `-af loudnorm` flag
     i.e. back-compat: pre-plan-71 callers are unchanged.
   - Single-pass `loudnorm` option appends one `-af <single-pass-filter>`
     to the encode args. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* Mock node:child_process at module level so the encoder's spawn call hits
   a controllable fake. The mock factory uses `vi.hoisted` so we can grab
   the same vi.fn() reference inside both the factory and the tests. */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function fakeFfmpegChild(): {
  on: ReturnType<typeof vi.fn>;
  stdin: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
} {
  let closeHandler: ((code: number) => void) | null = null;
  return {
    on: vi.fn((event: string, handler: (code: number) => void) => {
      if (event === 'close') closeHandler = handler;
    }),
    stdin: {
      on: vi.fn(),
      end: vi.fn(() => {
        /* Resolve on next microtask so the encoder's awaited Promise has
           attached its .then chain before we fire 'close'. */
        queueMicrotask(() => closeHandler?.(0));
      }),
    },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

describe('encodePcmToAudio spawn args', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeFfmpegChild());
  });

  it('omits any -af loudnorm flag when opts.loudnorm is undefined', async () => {
    /* Import lazily so the vi.mock above takes effect before the encoder's
       transitive import of node:child_process resolves. */
    const { encodePcmToAudio } = await import('./mp3.js');
    await encodePcmToAudio(Buffer.alloc(2), 24_000, { quality: 2 });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('ffmpeg');
    expect(Array.isArray(args)).toBe(true);
    const flat = (args as string[]).join(' ');
    expect(flat).not.toContain('loudnorm');
    expect(flat).not.toContain('-af');
  });

  it('appends one -af <single-pass filter> when twoPass=false', async () => {
    const { encodePcmToAudio } = await import('./mp3.js');
    await encodePcmToAudio(Buffer.alloc(2), 24_000, {
      quality: 2,
      loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: false },
    });

    /* Single-pass: exactly one ffmpeg spawn (no analysis pass before encode). */
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    const afIndex = args.indexOf('-af');
    expect(afIndex).toBeGreaterThanOrEqual(0);
    expect(args[afIndex + 1]).toBe('loudnorm=I=-16:LRA=11:TP=-1.5:linear=true');
    expect(args[afIndex + 1]).not.toContain('measured_');
  });
});
