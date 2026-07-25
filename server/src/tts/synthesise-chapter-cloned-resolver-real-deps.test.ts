/* fs-38 Wave 3b2, Task 6 review — IMPORTANT-3. The resolver pre-pass's
   PRODUCTION dependency wiring — `buildDefaultCloneResolverDeps`,
   `readMasterPcmDefault`, and `qwenVoicePtPath` (workspace/paths.js) — was
   executed by no test: every case in `synthesise-chapter-cloned-resolver
   .test.ts` overrides every dep via `cloneResolverDepsOverride`. This file
   drives the pre-pass through the REAL `synthesiseChapter` with NO override
   (case 1) or only the sidecar-calling `deriveEngineArtifact` overridden
   (case 2, to avoid a live network call), against a real temp-workspace
   voice-library manifest + a real cached `.pt` file, proving real
   `readEntry` + real `ptExists` path resolution + `readMasterPcmDefault`'s
   real ffmpeg decode of a retained `master.wav`.

   Mirrors the established tempdir-workspace fixture pattern (workspace/
   purge-clone-artifacts.test.ts, tts/verify-designed-voice-language.test.ts):
   mkdtempSync + WORKSPACE_DIR env + vi.resetModules(), then dynamic-import
   every module whose module-level state depends on WORKSPACE_ROOT — all from
   the SAME resetModules() epoch, so `UnresolvableClonedVoiceError`'s class
   identity (not needed by these two cases, but kept consistent for anyone
   adding a throwing case later) lines up for `instanceof` checks. Vitest
   isolates module state per test FILE, so this has no cross-file side
   effect on the override-based tests in the sibling file.

   Real ffmpeg subprocess for the WAV decode in case 2 — same no-mock
   convention as tts/decode-audio-to-pcm.test.ts. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePcmToWav } from './wav.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import type { CastCharacter } from './synthesise-chapter.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { ResolveChapterDeps } from './clone-voice-resolver.js';

const UUID = 'lib-real-clone';
const STORAGE_KEY = `qwen-${UUID}`;

function sine(durationSec: number, sampleRate: number, freq = 220, amp = 12000): Buffer {
  const n = Math.round(durationSec * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  return buf;
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

const clonedCast: CastCharacter[] = [
  {
    id: 'wren',
    name: 'Wren',
    gender: 'female',
    overrideTtsVoices: {
      qwen: { name: 'Wren (unused)', libraryUuid: UUID, provenance: 'cloned' },
    },
  },
];

function baseEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: UUID,
    name: 'Wren clone',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    // Real writeEntry() (unlike the override-based tests) enforces the
    // structural consent guard for a 'cloned' entry — see
    // assertConsentForClone in workspace/voice-library.ts.
    consent: {
      personName: 'Wren',
      relationship: 'self',
      permittedUse: 'personal',
      attestedAt: '2026-01-01T00:00:00.000Z',
      attestedBy: 'Wren',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let dir: string;
let mod: typeof import('./synthesise-chapter.js');
let voiceLibrary: typeof import('../workspace/voice-library.js');
let paths: typeof import('../workspace/paths.js');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-clone-resolver-real-deps-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  [mod, voiceLibrary, paths] = await Promise.all([
    import('./synthesise-chapter.js'),
    import('../workspace/voice-library.js'),
    import('../workspace/paths.js'),
  ]);
  mkdirSync(paths.qwenVoicesDir(), { recursive: true });
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('synthesise-chapter cloned-voice resolver pre-pass — REAL production deps (fs-38 Wave 3b2, Task 6 review IMPORTANT-3)', () => {
  it('classifies healthy via the REAL readEntry + REAL ptExists path resolution when the manifest + .pt both exist', async () => {
    await voiceLibrary.writeEntry(baseEntry());
    writeFileSync(paths.qwenVoicePtPath(STORAGE_KEY), 'fake-pt-bytes');

    const provider = makeProvider();
    const result = await mod.synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast: clonedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      // No cloneResolverDepsOverride at all — this exercises
      // buildDefaultCloneResolverDeps() end to end, proving the real
      // readEntry() + real ptExists()/qwenVoicePtPath() resolve this
      // manifest+.pt pair to 'healthy' and the pre-pass is a true no-op
      // (no derive, no throw).
    });

    expect(provider.calls.length).toBeGreaterThan(0); // rendered normally
    expect(result.segments.length).toBeGreaterThan(0);
  });

  it('goes repairable when the .pt is missing, and readMasterPcmDefault decodes the real retained master.wav', async () => {
    const pcm = sine(1.0, 24000);
    const wav = encodePcmToWav(pcm, 24000);
    const dirForEntry = voiceLibrary.entryDir(UUID);
    mkdirSync(dirForEntry, { recursive: true });
    writeFileSync(join(dirForEntry, 'master.wav'), wav);
    await voiceLibrary.writeEntry(
      baseEntry({
        master: {
          clipFile: 'master.wav',
          sampleRate: 24000,
          durationSeconds: 1,
          transcript: 'A retained reference clip.',
          transcriptSource: 'whisper',
          captureMethod: 'upload',
        },
      }),
    );
    // Deliberately NO .pt written this time — the real ptExists() resolves
    // false, so classifyClonedVoice lands on 'repairable' (entry.master is
    // present).

    const provider = makeProvider();
    const deriveEngineArtifact = vi.fn(async (..._args: unknown[]) => ({
      previewPcm: Buffer.alloc(10),
      sampleRate: 24000,
      baseModel: 'qwen3-tts-0.6b',
    }));

    const result = await mod.synthesiseChapter({
      sentences: [sentence(1, 'wren')],
      cast: clonedCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      // Only override the sidecar-calling derive step (no live network
      // call in a unit test) — readEntry, ptExists, and readMasterPcm all
      // stay the REAL production wiring from buildDefaultCloneResolverDeps.
      cloneResolverDepsOverride: {
        deriveEngineArtifact: deriveEngineArtifact as unknown as ResolveChapterDeps['deriveEngineArtifact'],
      },
    });

    expect(deriveEngineArtifact).toHaveBeenCalledTimes(1);
    const [, , input] = deriveEngineArtifact.mock.calls[0] as [
      string,
      string,
      { masterPcm: Buffer; sampleRate: number; refText: string },
    ];
    // Proves readMasterPcmDefault really spawned ffmpeg over the real
    // master.wav on disk: ~1s of 24kHz mono s16le decodes to a materially
    // non-empty PCM buffer, not an empty/garbage one.
    expect(input.masterPcm.length).toBeGreaterThan(24000 * 2 * 0.9);
    expect(input.sampleRate).toBe(24000);
    expect(input.refText).toBe('A retained reference clip.');

    const persisted = await voiceLibrary.readEntry(UUID);
    expect(persisted?.engines.qwen?.status).toBe('ready');
    expect(provider.calls.length).toBeGreaterThan(0); // then the chapter synthesises normally
    expect(result.segments.length).toBeGreaterThan(0);
  });
});
