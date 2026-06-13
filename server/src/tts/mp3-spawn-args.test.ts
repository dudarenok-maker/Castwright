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

/* Plan 109: the MP3 path now writes to a seekable temp file and reads it back
   (so libmp3lame can stamp the Xing header). The mocked spawn never writes
   that file, so stub `readFile`/`unlink` — otherwise the encoder's read-back
   throws ENOENT under the fake child. Everything else stays real. */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async () => Buffer.from('stub-mp3-bytes')),
    unlink: vi.fn(async () => {}),
  };
});

function fakeFfmpegChild(opts: { stderr?: string } = {}): {
  on: ReturnType<typeof vi.fn>;
  stdin: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
} {
  let closeHandler: ((code: number) => void) | null = null;
  let stderrDataHandler: ((chunk: Buffer) => void) | null = null;
  return {
    on: vi.fn((event: string, handler: (code: number) => void) => {
      if (event === 'close') closeHandler = handler;
    }),
    stdin: {
      on: vi.fn(),
      end: vi.fn(() => {
        /* Resolve on next microtask so the encoder's awaited Promise has
           attached its .then chain before we fire stderr / 'close'. */
        queueMicrotask(() => {
          if (opts.stderr && stderrDataHandler) {
            stderrDataHandler(Buffer.from(opts.stderr, 'utf8'));
          }
          closeHandler?.(0);
        });
      }),
    },
    stdout: { on: vi.fn() },
    stderr: {
      on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
        if (event === 'data') stderrDataHandler = handler;
      }),
    },
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

  /* Regression for the ffmpeg 8.x loudnorm sample-rate drift (5 The Ebb
     chapters corrupted on 2026-05-21 — 3.05x duration MP3s on 24 kHz
     Kokoro PCM). The loudnorm filter resamples internally to 192 kHz;
     ffmpeg 7.x followed the input rate at the filter output, 8.x did
     not. Fix: every codec builder must emit an explicit output `-ar`
     AFTER the `-af` flag, BEFORE the `-c:a` flag, so the encoder
     receives stream metadata pinned to the input rate regardless of
     filter-chain behaviour. */
  describe.each([
    {
      format: 'mp3' as const,
      codec: 'libmp3lame',
    },
    {
      format: 'aac-m4a' as const,
      codec: /^(libfdk_aac|aac)$/,
    },
    {
      format: 'opus' as const,
      codec: 'libopus',
    },
  ])('$format loudnorm output rate pinning', ({ format, codec }) => {
    it('emits an output -ar matching the input rate between -af and -c:a', async () => {
      const { encodePcmToAudio } = await import('./mp3.js');
      const sampleRate = 24_000;
      await encodePcmToAudio(Buffer.alloc(2), sampleRate, {
        format,
        quality: 2,
        loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: false },
      });

      const args = spawnMock.mock.calls[0][1] as string[];
      const afIndex = args.indexOf('-af');
      const caIndex = args.indexOf('-c:a');
      expect(afIndex).toBeGreaterThanOrEqual(0);
      expect(caIndex).toBeGreaterThan(afIndex);

      /* The output `-ar` that fixes the bug lives between `-af` and `-c:a`.
         There is also an input `-ar` BEFORE the `-i pipe:0` flag; that one
         must NOT be confused for the output one. We look for `-ar` strictly
         in the (afIndex, caIndex) window. */
      let outputArIdx = -1;
      for (let i = afIndex + 2; i < caIndex; i += 1) {
        if (args[i] === '-ar') {
          outputArIdx = i;
          break;
        }
      }
      expect(outputArIdx, 'output -ar missing between -af and -c:a').toBeGreaterThan(-1);
      expect(args[outputArIdx + 1]).toBe(String(sampleRate));
      expect(args[caIndex + 1]).toMatch(codec);
    });
  });

  /* Regression for plan 109: MP3 must encode to a seekable file (not the
     non-seekable `pipe:1`) so libmp3lame can seek back and write the Xing VBR
     header. Without it, players estimate duration from a sampled bitrate and
     inflate it ~7x. We assert the output target is a temp file path and that
     `-write_xing 1` is present; AAC/Opus keep streaming to stdout. */
  describe('mp3 output target', () => {
    it('writes mp3 to a seekable temp file, not pipe:1, with -write_xing 1', async () => {
      const { encodePcmToAudio } = await import('./mp3.js');
      await encodePcmToAudio(Buffer.alloc(2), 24_000, { format: 'mp3', quality: 2 });

      const args = spawnMock.mock.calls[0][1] as string[];
      const outTarget = args[args.length - 1];
      expect(outTarget).not.toBe('pipe:1');
      expect(outTarget).toContain('audiobook-encode-');
      expect(outTarget.endsWith('.mp3')).toBe(true);

      const xingIdx = args.indexOf('-write_xing');
      expect(xingIdx).toBeGreaterThanOrEqual(0);
      expect(args[xingIdx + 1]).toBe('1');
    });

    it.each(['aac-m4a', 'opus'] as const)('keeps %s streaming to pipe:1', async (format) => {
      const { encodePcmToAudio } = await import('./mp3.js');
      await encodePcmToAudio(Buffer.alloc(2), 24_000, { format, quality: 2 });

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args[args.length - 1]).toBe('pipe:1');
      expect(args).not.toContain('-write_xing');
    });
  });
});

/* Two-pass sidecar payload coverage (2026-05-22 LUFS-drift fix). Both passes
   are spawned through node:child_process; we mock both:
   - First spawn = analysis pass. Returns a valid first-pass JSON in stderr
     so the encoder progresses to the second pass.
   - Second spawn = encode pass. Its stderr is what `parseLoudnormSecondPassJson`
     consumes. We vary it per case to exercise success + fallback paths.

   These tests assert the sidecar payload shape (onLoudnessMeasured callback
   value) rather than the args. They live in the spawn-args file because they
   need the same mocked-spawn primitive. */
describe('encodePcmToAudio two-pass sidecar payload', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  /* A complete first-pass JSON block (input_* only — no output_*). Stable
     real-shape input that makes isMeasurementUseable return true and lets
     the encoder progress to the second pass. */
  const firstPassStderr =
    `[Parsed_loudnorm @ 0x1] \n` +
    `{\n` +
    `        "input_i" : "-22.50",\n` +
    `        "input_tp" : "-2.13",\n` +
    `        "input_lra" : "9.40",\n` +
    `        "input_thresh" : "-32.50",\n` +
    `        "target_offset" : "6.45"\n` +
    `}\n`;

  /* Real-shape second-pass JSON. output_i is the post-normalisation value
     we want persisted into the sidecar. */
  const secondPassStderr =
    `[Parsed_loudnorm @ 0x1] \n` +
    `{\n` +
    `        "input_i" : "-22.50",\n` +
    `        "input_tp" : "-2.13",\n` +
    `        "input_lra" : "9.40",\n` +
    `        "input_thresh" : "-32.50",\n` +
    `        "output_i" : "-16.02",\n` +
    `        "output_tp" : "-1.51",\n` +
    `        "output_lra" : "8.40",\n` +
    `        "output_thresh" : "-26.10",\n` +
    `        "normalization_type" : "linear",\n` +
    `        "target_offset" : "6.45"\n` +
    `}\n`;

  it('writes output_i to the sidecar when the second-pass stderr is parseable', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeFfmpegChild({ stderr: firstPassStderr }))
      .mockImplementationOnce(() => fakeFfmpegChild({ stderr: secondPassStderr }));

    const { encodePcmToAudio } = await import('./mp3.js');
    let sidecar: { i: number; lra: number; tp: number; twoPass: boolean; target: number } | null =
      null;
    await encodePcmToAudio(Buffer.alloc(2), 24_000, {
      quality: 2,
      loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: true },
      onLoudnessMeasured: (s) => {
        sidecar = s;
      },
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.twoPass).toBe(true);
    expect(sidecar!.target).toBe(-16);
    /* The fix: i is output_i (-16.02), NOT input_i (-22.50). */
    expect(sidecar!.i).toBe(-16.02);
    expect(sidecar!.lra).toBe(8.4);
    expect(sidecar!.tp).toBe(-1.51);
  });

  it('falls back to input_i when the second-pass stderr lacks a JSON block', async () => {
    /* Simulates ffmpeg builds / log levels that suppress the loudnorm
       summary. The encode still succeeded (MP3 bytes are on disk) — we
       just persist the pre-filter measurement and log a warning, rather
       than corrupting the sidecar with NaN or failing the encode. */
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      spawnMock
        .mockImplementationOnce(() => fakeFfmpegChild({ stderr: firstPassStderr }))
        .mockImplementationOnce(() => fakeFfmpegChild({ stderr: 'no json here, just text' }));

      const { encodePcmToAudio } = await import('./mp3.js');
      let sidecar: { i: number; twoPass: boolean } | null = null;
      await encodePcmToAudio(Buffer.alloc(2), 24_000, {
        quality: 2,
        loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: true },
        onLoudnessMeasured: (s) => {
          sidecar = s;
        },
      });

      expect(sidecar).not.toBeNull();
      expect(sidecar!.twoPass).toBe(true);
      /* Fallback path: persist input_i so the sidecar carries SOMETHING
         rather than nothing. UI pill will look stale but the MP3 plays. */
      expect(sidecar!.i).toBe(-22.5);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/second-pass stderr did not include a JSON block/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to input_i when the second-pass JSON is missing output_i', async () => {
    /* Same fallback path, different trigger: stderr DOES have a JSON block
       (e.g. ffmpeg only printed the first-pass-shape summary) but it
       lacks the output_* fields parseLoudnormSecondPassJson requires. */
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      spawnMock
        .mockImplementationOnce(() => fakeFfmpegChild({ stderr: firstPassStderr }))
        .mockImplementationOnce(() => fakeFfmpegChild({ stderr: firstPassStderr }));

      const { encodePcmToAudio } = await import('./mp3.js');
      let sidecar: { i: number; twoPass: boolean } | null = null;
      await encodePcmToAudio(Buffer.alloc(2), 24_000, {
        quality: 2,
        loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: true },
        onLoudnessMeasured: (s) => {
          sidecar = s;
        },
      });

      expect(sidecar).not.toBeNull();
      expect(sidecar!.i).toBe(-22.5);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/failed to parse second-pass stderr JSON/),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
