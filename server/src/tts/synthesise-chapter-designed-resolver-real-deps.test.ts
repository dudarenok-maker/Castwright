/* fs-38 Wave 3b2, Task 12 (§2.3) review — IMPORTANT-1 (I-1). The designed-
   voice self-heal pre-pass's doc comment on `readDesignedMasterPcmDefault`
   claims "Returns null (never throws)", but `decodeAudioToPcm` (mp3.ts)
   rejects on an ffmpeg spawn failure or a non-zero exit — and that call used
   to sit OUTSIDE every try in the default reader, so a corrupt/undecodable
   retained `__master.wav` threw straight out of a function whose whole
   contract is "never throws", up through the resolver's unguarded await, and
   would have aborted a chapter that would otherwise render fine.

   This drives the REAL production wiring end to end — real
   `buildDefaultDesignedResolverDeps`, real `readDesignedMasterPcmDefault`,
   real `qwenVoiceSidecarPath`/`qwenVoiceWavPath` — against a real temp
   workspace, with ONLY `node:child_process`'s `spawn` mocked to simulate
   ffmpeg failing to decode the retained clip (deterministic, no dependency
   on real ffmpeg actually rejecting a given byte sequence). Mirrors the
   tempdir-workspace + resetModules() pattern of
   `synthesise-chapter-cloned-resolver-real-deps.test.ts`. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import type { CastCharacter } from './synthesise-chapter.js';
import type { ResolveDesignedVoiceDeps } from './clone-voice-resolver.js';

/* Mock node:child_process at module level so ffmpeg (spawned inside
   decodeAudioToPcm) always "fails" — exits non-zero — regardless of the
   bytes fed to it. Same vi.hoisted convention as mp3-spawn-args.test.ts. */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

function fakeFailingFfmpegChild(): {
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
        // Resolve on next microtask, mirroring mp3-spawn-args.test.ts, so the
        // decoder's Promise has attached its .then chain before 'close' fires.
        queueMicrotask(() => closeHandler?.(1));
      }),
    },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

function makeProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

function sentence(id: number, characterId: string): SentenceOutput {
  return { id, chapterId: 1, characterId, text: 'Hello, this is an English test sentence.' };
}

const UUID = 'lib-real-designed';

const designedCast: CastCharacter[] = [
  {
    id: 'orin',
    name: 'Orin',
    gender: 'male',
    overrideTtsVoices: {
      qwen: { name: 'Orin (unused)', libraryUuid: UUID, provenance: 'designed' },
    },
  },
];

let dir: string;
let mod: typeof import('./synthesise-chapter.js');
let paths: typeof import('../workspace/paths.js');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-designed-resolver-real-deps-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeFailingFfmpegChild());
  [mod, paths] = await Promise.all([import('./synthesise-chapter.js'), import('../workspace/paths.js')]);
  mkdirSync(paths.qwenVoicesDir(), { recursive: true });
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('synthesise-chapter designed-voice self-heal pre-pass — REAL production deps (fs-38 Wave 3b2, Task 12 review I-1)', () => {
  it('a corrupt/undecodable retained master.wav never throws — chapter still renders, no re-derive attempted', async () => {
    const storageKey = `qwen-${UUID}`;
    // Real manifest with a valid refText (so the reader gets past that gate)...
    writeFileSync(
      paths.qwenVoiceSidecarPath(storageKey),
      JSON.stringify({ voiceId: storageKey, refText: 'A retained calibration clip.' }),
    );
    // ...and a retained clip that exists on disk (any bytes — the mocked
    // ffmpeg spawn "fails" to decode it regardless of content).
    writeFileSync(paths.qwenVoiceWavPath(`${storageKey}__master`), Buffer.from('not really a wav'));
    // Deliberately NO .pt written — ptExists() resolves false, so the
    // self-heal proceeds to read the (undecodable) master clip.

    const provider = makeProvider();
    const deriveEngineArtifact = vi.fn();

    const result = await mod.synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      // Only override the sidecar-calling derive step (must never be
      // called here) — ptExists and readDesignedMasterPcm stay the REAL
      // production wiring from buildDefaultDesignedResolverDeps, so the
      // real decodeAudioToPcm (backed by the mocked failing ffmpeg spawn)
      // actually runs.
      designedResolverDepsOverride: {
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(spawnMock).toHaveBeenCalled(); // the real decode really ran (and "failed")
    expect(deriveEngineArtifact).not.toHaveBeenCalled(); // readDesignedMasterPcm returned null -> no re-derive
    expect(provider.calls.length).toBeGreaterThan(0); // the chapter still rendered (fall-through, no abort)
    expect(result.segments.length).toBeGreaterThan(0);
  });
});
