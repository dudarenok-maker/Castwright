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

/* Task 20a fix round 1 (F2) — a SUCCEEDING fake decode child (exit code 0,
   empty stdout is fine: `readDesignedMasterPcmDefault` only cares whether
   `decodeAudioToPcm` resolves at all, not the byte content). Mirrors
   mp3-spawn-args.test.ts's `fakeFfmpegChild` shape. */
function fakeSucceedingFfmpegChild(): {
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
        queueMicrotask(() => closeHandler?.(0));
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
  mod = await import('./synthesise-chapter.js');
  paths = await import('../workspace/paths.js');
  mkdirSync(paths.qwenVoicesDir(), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks(); // fs-38 Wave 3c, Task 22 — undo the per-test `global.fetch` spy below.
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

/* fs-38 Wave 3c, Task 20a fix round 1 (F2) — the REAL `readDesignedMasterPcmDefault`
   against a REAL decode, proving the `[DELTA-M1]` refText-split engine gate
   actually executes: a coqui derive proceeds past an EMPTY refText (never
   sent on the wire — derive-engine-artifact.ts), while a qwen derive with the
   identical empty-refText manifest is gated exactly as before. Every prior
   coqui unit test mocked `readDesignedMasterPcm` wholesale, so this gate
   never ran with `engine: 'coqui'` until now — the reviewer's own words. */
describe('synthesise-chapter designed-voice self-heal — REAL readDesignedMasterPcmDefault, the DELTA-M1 refText split (fs-38 Wave 3c, Task 20a fix round 1)', () => {
  const COQUI_UUID = 'lib-real-coqui-designed';
  const coquiDesignedCast: CastCharacter[] = [
    {
      id: 'orin',
      name: 'Orin',
      gender: 'male',
      overrideTtsVoices: {
        coqui: { name: 'xtts-lib-real-coqui-designed', libraryUuid: COQUI_UUID, provenance: 'designed' },
      },
    },
  ];

  function designedEntry(uuid: string) {
    return {
      voiceUuid: uuid,
      name: 'Orin',
      provenance: 'designed' as const,
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('a COQUI derive proceeds past a real decode with an EMPTY refText manifest (refText is never required off this branch)', async () => {
    const storageKey = `qwen-${COQUI_UUID}`; // the retained clip always lives under the qwen- prefix (DELTA-M1).
    writeFileSync(
      paths.qwenVoiceSidecarPath(storageKey),
      JSON.stringify({ voiceId: storageKey, refText: '' }), // deliberately EMPTY.
    );
    writeFileSync(paths.qwenVoiceWavPath(`${storageKey}__master`), Buffer.from('not really a wav'));
    spawnMock.mockImplementation(() => fakeSucceedingFfmpegChild()); // this test's whole point: decode SUCCEEDS.

    /* fs-38 Wave 3c, Task 22 — a coqui-engine designed self-heal request now
       has the pre-pass call `evictQwenForCoquiPhase()` (sidecar `/unload`)
       BEFORE the resolver runs — see synthesise-chapter.ts's Task 22
       comment. Mock `global.fetch` so that call doesn't ECONNREFUSED
       against a real (absent) sidecar. */
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const provider = makeProvider();
    const entry = designedEntry(COQUI_UUID);
    const deriveEngineArtifact = vi.fn(async (..._args: unknown[]) => ({
      previewPcm: Buffer.alloc(0),
      sampleRate: 24000,
      coquiVersion: 'v2.0.5',
    }));

    await mod.synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      designedResolverDepsOverride: {
        readEntry: (async (uuid: string) =>
          uuid === COQUI_UUID ? entry : null) as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists: (async () => false) as unknown as ResolveDesignedVoiceDeps['ptExists'],
        currentArtifactVersion: (() => '') as unknown as ResolveDesignedVoiceDeps['currentArtifactVersion'],
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(spawnMock).toHaveBeenCalled(); // the real decode really ran (and succeeded).
    // The load-bearing assertion: the REAL readDesignedMasterPcmDefault did
    // NOT gate on the empty refText for a coqui request — the derive fired.
    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    const [, , input] = deriveEngineArtifact.mock.calls[0];
    expect((input as { refText: string }).refText).toBe('');
  });

  it('the SAME empty-refText manifest gates a QWEN derive (the contrast — unchanged pre-3c behaviour)', async () => {
    const storageKey = `qwen-${UUID}`;
    writeFileSync(
      paths.qwenVoiceSidecarPath(storageKey),
      JSON.stringify({ voiceId: storageKey, refText: '' }), // same empty refText.
    );
    writeFileSync(paths.qwenVoiceWavPath(`${storageKey}__master`), Buffer.from('not really a wav'));
    spawnMock.mockImplementation(() => fakeSucceedingFfmpegChild()); // decode would succeed if reached...

    const provider = makeProvider();
    const deriveEngineArtifact = vi.fn();

    await mod.synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: designedCast, // the qwen-slot fixture from the top of this file.
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      designedResolverDepsOverride: {
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    // ...but the qwen arm's refText gate fires BEFORE decodeAudioToPcm is
    // even reached (readDesignedMasterPcmDefault's own !refText check), so
    // spawn never runs — the gate, not the decode, is what's proven here.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(deriveEngineArtifact).not.toHaveBeenCalled();
    expect(provider.calls.length).toBeGreaterThan(0); // falls through, chapter still renders.
  });

  /* #1813, placebo trap (design doc's own "Wiring" test) — mirrors the cloned
     resolver's real-deps wiring test: a hand-built ResolveDesignedVoiceDeps
     could pass `onVoicePrepare` straight through and prove nothing about
     production, since the actual bug was `reportProgress: undefined` baked
     into `buildDefaultDesignedResolverDeps` itself. Drives the SAME
     COQUI self-heal derive as the test above through `synthesiseChapter` with
     `onVoicePrepare` on `opts` and NO override touching it. */
  it('opts.onVoicePrepare fires through the REAL buildDefaultDesignedResolverDeps wiring for a COQUI self-heal derive', async () => {
    const storageKey = `qwen-${COQUI_UUID}`;
    writeFileSync(
      paths.qwenVoiceSidecarPath(storageKey),
      JSON.stringify({ voiceId: storageKey, refText: '' }),
    );
    writeFileSync(paths.qwenVoiceWavPath(`${storageKey}__master`), Buffer.from('not really a wav'));
    spawnMock.mockImplementation(() => fakeSucceedingFfmpegChild());
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const provider = makeProvider();
    const entry = designedEntry(COQUI_UUID);
    const onVoicePrepare = vi.fn();
    const deriveEngineArtifact = vi.fn(async (..._args: unknown[]) => ({
      previewPcm: Buffer.alloc(0),
      sampleRate: 24000,
      coquiVersion: 'v2.0.5',
    }));

    await mod.synthesiseChapter({
      sentences: [sentence(1, 'orin')],
      cast: coquiDesignedCast,
      provider,
      modelKey: 'coqui-xtts-v2',
      engine: 'coqui',
      onVoicePrepare,
      designedResolverDepsOverride: {
        readEntry: (async (uuid: string) =>
          uuid === COQUI_UUID ? entry : null) as unknown as ResolveDesignedVoiceDeps['readEntry'],
        ptExists: (async () => false) as unknown as ResolveDesignedVoiceDeps['ptExists'],
        currentArtifactVersion: (() => '') as unknown as ResolveDesignedVoiceDeps['currentArtifactVersion'],
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveDesignedVoiceDeps['deriveEngineArtifact'],
      },
    });

    expect(onVoicePrepare).toHaveBeenCalledTimes(1);
    expect(onVoicePrepare).toHaveBeenCalledWith({ characterId: 'orin', characterName: 'Orin' });
  });
});
