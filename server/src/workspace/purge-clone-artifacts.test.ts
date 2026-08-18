/* fs-38 Wave 3b2, Task 2 — purgeCloneArtifacts erases every consent-scoped
   Qwen clone artifact for a voice: base .pt/.json, the 1.7B variant (the gap
   the ad-hoc cleanup this replaces used to miss), and any staged preview —
   then evicts the sidecar's in-memory cache, files first. Mirrors the
   tempdir-workspace fixture pattern used across workspace/*.test.ts
   (voice-library.test.ts): mkdtempSync + WORKSPACE_DIR env +
   vi.resetModules() so paths.ts re-reads WORKSPACE_ROOT fresh per test.

   purgeVoiceSamples / removeEntryDir / getResolvedSidecarUrl are spied via
   the importOriginal-merge pattern (not full-replaced) — routes/qwen-voice.js
   (needed here for the real qwenVoicePtPath sanitizer/containment logic) and
   its own transitive imports pull in other named exports from those same
   modules, so a full replace would silently undefine them. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

const { purgeVoiceSamples, purgeVoiceSamplesActual } = vi.hoisted(() => ({
  purgeVoiceSamples: vi.fn(),
  // Fix wave — most tests in this file only assert on purgeVoiceSamples'
  // CALL ARGUMENTS (it's a bare vi.fn() stub with no implementation). The
  // real-file end-to-end test below needs the actual sweep implementation,
  // so the mock factory stashes it here for that one test to opt into via
  // `purgeVoiceSamples.mockImplementation(purgeVoiceSamplesActual.fn!)`.
  purgeVoiceSamplesActual: { fn: null as null | typeof import('../tts/voice-sample-cache.js').purgeVoiceSamples },
}));
vi.mock('../tts/voice-sample-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/voice-sample-cache.js')>();
  purgeVoiceSamplesActual.fn = actual.purgeVoiceSamples;
  return { ...actual, purgeVoiceSamples };
});

const { removeEntryDir } = vi.hoisted(() => ({ removeEntryDir: vi.fn() }));
vi.mock('./voice-library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-library.js')>();
  return { ...actual, removeEntryDir };
});

const { getResolvedSidecarUrl } = vi.hoisted(() => ({ getResolvedSidecarUrl: vi.fn() }));
vi.mock('./user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./user-settings.js')>();
  return { ...actual, getResolvedSidecarUrl };
});

// Review I-2 — `rmMock` defaults to the REAL `rm` (delegated in the factory
// below) so every other test in this file is unaffected; only the I-2 test
// overrides a single call via `mockImplementationOnce` to simulate an unlink
// that fails for a reason other than "already gone" (e.g. Windows EBUSY).
const { rmMock } = vi.hoisted(() => ({ rmMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  rmMock.mockImplementation(actual.rm);
  return { ...actual, rm: rmMock };
});

let dir: string;
let purge: typeof import('./purge-clone-artifacts.js');
let paths: typeof import('./paths.js');
let vl: typeof import('./voice-library.js');
let cache: typeof import('../tts/voice-sample-cache.js');
let fetchMock: ReturnType<typeof vi.fn>;

function seed(name: string, ext: 'pt' | 'json' | 'wav'): string {
  const p = join(paths.qwenVoicesDir(), `${name}.${ext}`);
  writeFileSync(p, ext === 'json' ? '{}' : 'binary-stub');
  return p;
}

// fs-38 Wave 3c, Task 13 — same idea as `seed` above, but under xttsVoicesDir.
function seedXtts(name: string, ext: 'pt' | 'json'): string {
  const p = join(paths.xttsVoicesDir(), `${name}.${ext}`);
  writeFileSync(p, ext === 'json' ? '{}' : 'binary-stub');
  return p;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-purge-clone-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();

  purgeVoiceSamples.mockReset();
  removeEntryDir.mockReset().mockResolvedValue(undefined);
  getResolvedSidecarUrl.mockReset().mockReturnValue('http://127.0.0.1:9000');

  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);

  // Sequential, not Promise.all: `voice-library.js` must finish resolving
  // through its mock factory (importOriginal-merge) BEFORE
  // `purge-clone-artifacts.js` (which statically imports from it) does —
  // importing them concurrently raced the mock factory against itself and
  // left `purge`'s internal `removeEntryDir` reference desynced from this
  // test file's mocked one.
  vl = await import('./voice-library.js');
  purge = await import('./purge-clone-artifacts.js');
  paths = await import('./paths.js');
  cache = await import('../tts/voice-sample-cache.js');

  mkdirSync(paths.qwenVoicesDir(), { recursive: true });
  mkdirSync(paths.xttsVoicesDir(), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('purgeCloneArtifacts', () => {
  it('erases the base, 1.7B, manifest, preview, and master-clip artifacts, and purges samples', async () => {
    const key = 'qwen-u1';
    const ptFile = seed(key, 'pt');
    const jsonFile = seed(key, 'json');
    const pt17bFile = seed(`${key}__1.7b`, 'pt'); // the gap this closes
    const previewPtFile = seed(`${key}-preview`, 'pt');
    const previewJsonFile = seed(`${key}-preview`, 'json');
    // M2 (review) — the preview's own 1.7B variant; the same gap as the base
    // key's `__1.7b.pt`, just for `-preview`.
    const previewPt17bFile = seed(`${key}-preview__1.7b`, 'pt');
    const masterWavFile = seed(`${key}__master`, 'wav'); // §2.3 designed-voice reference clip
    // Fix wave (consent-erasure gap) — the PREVIEW design writes its own
    // `<key>-preview__master.wav` clip; nothing erased it before this fix.
    const previewMasterWavFile = seed(`${key}-preview__master`, 'wav');

    await purge.purgeCloneArtifacts('u1');

    for (const f of [
      ptFile,
      jsonFile,
      pt17bFile,
      previewPtFile,
      previewJsonFile,
      previewPt17bFile,
      masterWavFile,
      previewMasterWavFile,
    ]) {
      expect(existsSync(f)).toBe(false);
    }
    expect(purgeVoiceSamples).toHaveBeenCalledWith(key);
    expect(removeEntryDir).not.toHaveBeenCalled();
  });

  /* fs-38 Wave 3c, Task 2 — routes/voice-sample.ts (the cast-view audition
     route) caches under scopes purgeCloneArtifacts never used to know
     about: the canonical `xtts-<uuid>` form (this function only ever swept
     `qwen-<uuid>`), and the raw-speaker bypass's own
     `raw-<engine>-<djb2(voiceName)-hash6>` scope (:112) — a DIFFERENT scope
     string that embeds no literal `<uuid>` substring, but IS fully
     reconstructable from voiceName alone (its hash has no sample-text
     input), unlike the cast-view's regular per-character scope. Erasure
     must reach every one of these — "regardless of cache scope" — not just
     the one scope this function happened to already know about. */
  it('fs-38 Wave 3c: sweeps the xtts canonical scope and both engines\' raw-branch scopes, regardless of cache scope', async () => {
    await purge.purgeCloneArtifacts('u1');

    const qwenRawScope = `raw-qwen-${cache.djb2('qwen-u1').toString(36).slice(0, 6)}`;
    const xttsRawScope = `raw-coqui-${cache.djb2('xtts-u1').toString(36).slice(0, 6)}`;

    expect(purgeVoiceSamples).toHaveBeenCalledWith('qwen-u1');
    expect(purgeVoiceSamples).toHaveBeenCalledWith('xtts-u1');
    expect(purgeVoiceSamples).toHaveBeenCalledWith(qwenRawScope);
    expect(purgeVoiceSamples).toHaveBeenCalledWith(xttsRawScope);
  });

  /* Fix wave (fs-38 Wave 3c, Task 2 review, finding 1) — the two tests above
     only assert purgeVoiceSamples was CALLED with the right scope string;
     this test opts the mock into the REAL sweep implementation and plants a
     file directly under the qwen-<uuid> storage-key scope, proving
     purgeCloneArtifacts's OWN sweep logic actually removes a file that's
     sitting at that path — not just that it calls purgeVoiceSamples with the
     right argument.

     Correction (fix wave, review B1) — despite the name this test used to
     carry, it does NOT prove the loop end-to-end: it hardcodes
     `cacheScope: 'qwen-u1'` and calls purgeCloneArtifacts directly, so it
     never exercises routes/voice-sample.ts — the route whose cache-scope fix
     is the actual thing that must keep working. It would still pass even if
     that route fix were reverted (the route isn't in the call graph at all).
     The genuine end-to-end regression lock — real POST through the real
     route, real MP3 on disk, real purgeCloneArtifacts call, real file gone —
     lives in routes/voice-sample.test.ts's "end-to-end: route writes a real
     cache file, purge actually erases it" test. This one stays as a
     narrower, purge-side-only check. */
  it('purge sweep alone: erases a REAL file already planted under the qwen-<uuid> storage-key scope (does not exercise the route)', async () => {
    const audioDir = join(dir, 'audio-voices');
    mkdirSync(audioDir, { recursive: true });
    process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
    try {
      purgeVoiceSamples.mockImplementation(purgeVoiceSamplesActual.fn!);

      const fileName = cache.voiceSampleFileName({
        cacheScope: 'qwen-u1',
        modelKey: 'qwen3-tts-0.6b',
        text: 'Hello there.',
        voiceName: 'qwen-u1',
      });
      const filePath = cache.voiceSampleFilePath(fileName);
      writeFileSync(filePath, 'fake-mp3-bytes');
      expect(existsSync(filePath)).toBe(true);

      await purge.purgeCloneArtifacts('u1');

      expect(existsSync(filePath)).toBe(false);
    } finally {
      delete process.env.VOICE_SAMPLE_AUDIO_DIR;
    }
  });

  /* fs-38 Wave 3c, Task 13 — the Coqui/XTTS on-disk artifact set is THREE
     paths, not two: the latents `.pt`, the `.json` sidecar manifest, and a
     `<key>.derive-src.tmp.wav` reference-audio temp file that Task 9's
     `clone_voice` writes and cleans up on every testable path but which
     SURVIVES a hard/external process kill. That surviving copy is the real
     person's source audio — a Phase-0-consent-hole-class leftover unless
     purge attempt-deletes it too. */
  it('fs-38 Wave 3c, Task 13: erases the xtts latents, sidecar json, and derive-src tmp wav', async () => {
    const ptFile = seedXtts('xtts-u1', 'pt');
    const jsonFile = seedXtts('xtts-u1', 'json');
    const tmpWavFile = paths.xttsVoiceDeriveSrcTmpWavPath('xtts-u1');
    writeFileSync(tmpWavFile, 'binary-stub');

    await purge.purgeCloneArtifacts('u1');

    for (const f of [ptFile, jsonFile, tmpWavFile]) {
      expect(existsSync(f)).toBe(false);
    }
  });

  it('fs-38 Wave 3c, Task 13: a failing xtts unlink is reported in `failed`, not swallowed', async () => {
    const ptFile = seedXtts('xtts-u1', 'pt');
    rmMock.mockImplementation(async (f: string, opts?: unknown) => {
      if (f === ptFile) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.rm(f, opts as never);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await purge.purgeCloneArtifacts('u1');

    expect(result.failed).toContain(ptFile);
    expect(existsSync(ptFile)).toBe(true); // never actually removed
    // The path is no longer baked into the format-string argument; it is now
    // the %s placeholder value, and the trailing error survives after it.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining(ptFile),
      ptFile,
      'u1',
      expect.objectContaining({ code: 'EBUSY' }),
    );

    warnSpy.mockRestore();
  });

  /* GATE 1 fix (C5) — the sidecar's `_atomic_torch_save`/`_atomic_wav_save`
     stage through `tempfile.mkstemp(prefix=f"{basename}.", suffix=".tmp")`
     and only unlink in an `except BaseException` handler, which a hard kill
     (`taskkill /T /F`, an OOM kill mid-derive) skips. The names are RANDOM,
     so a fixed path list cannot reach them — revoke reported clean erasure
     while the latents AND the raw human reference clip survived. */
  it('GATE 1 C5: erases crash-orphaned <key>.<rand>.tmp siblings a fixed path list cannot name', async () => {
    // Exactly the two shapes main.py can strand in voices/xtts.
    const strandedPt = join(paths.xttsVoicesDir(), 'xtts-u1.pt.a1b2c3.tmp');
    const strandedWav = join(
      paths.xttsVoicesDir(),
      'xtts-u1.derive-src.tmp.wav.d4e5f6.tmp', // the real person's source audio
    );
    // ...and the qwen equivalents, whose writes use the same helpers.
    const strandedQwenPt = join(paths.qwenVoicesDir(), 'qwen-u1.pt.9z8y7x.tmp');
    const strandedQwen17b = join(paths.qwenVoicesDir(), 'qwen-u1__1.7b.pt.5w4v3u.tmp');
    const strandedQwenMasterWav = join(paths.qwenVoicesDir(), 'qwen-u1__master.wav.2t1s0r.tmp');
    for (const f of [
      strandedPt,
      strandedWav,
      strandedQwenPt,
      strandedQwen17b,
      strandedQwenMasterWav,
    ]) {
      writeFileSync(f, 'orphaned-bytes');
    }

    const result = await purge.purgeCloneArtifacts('u1');

    for (const f of [
      strandedPt,
      strandedWav,
      strandedQwenPt,
      strandedQwen17b,
      strandedQwenMasterWav,
    ]) {
      expect(existsSync(f)).toBe(false);
    }
    expect(result.failed).toEqual([]);
  });

  /* The anchoring half of the same fix. uuids come from randomUUID()/nanoid(),
     so one voice's key is readily a string-prefix of another's — an
     unanchored `startsWith(key)` sweep would erase a DIFFERENT person's
     consented voice, turning a Property 2 fix into a data-loss bug. */
  it('GATE 1 C5: the sweep is anchored — a longer uuid sharing the prefix is untouched', async () => {
    const victimPt = seedXtts('xtts-u1234', 'pt'); // 'u1' is a prefix of 'u1234'
    const victimTmp = join(paths.xttsVoicesDir(), 'xtts-u1234.pt.aaaaaa.tmp');
    writeFileSync(victimTmp, 'other-voice-bytes');
    const victimQwenPt = seed('qwen-u1234', 'pt');
    // Same uuid, an artifact key that merely SHARES the base — must survive.
    const ownTarget = seedXtts('xtts-u1', 'pt');

    await purge.purgeCloneArtifacts('u1');

    expect(existsSync(ownTarget)).toBe(false); // its own artifact still goes
    expect(existsSync(victimPt)).toBe(true); // ...but not the other voice's
    expect(existsSync(victimTmp)).toBe(true);
    expect(existsSync(victimQwenPt)).toBe(true);
  });

  it('removes the entry dir only when deleteEntryDir is set', async () => {
    await purge.purgeCloneArtifacts('u1');
    expect(removeEntryDir).not.toHaveBeenCalled();

    await purge.purgeCloneArtifacts('u1', { deleteEntryDir: true });
    expect(removeEntryDir).toHaveBeenCalledWith('u1');
  });

  it('evicts the sidecar cache for both the base and -preview voice keys, after the files are gone', async () => {
    const ptFile = seed('qwen-u1', 'pt');
    let ptFileExistedAtFirstEvict: boolean | null = null;
    fetchMock.mockImplementationOnce(async () => {
      ptFileExistedAtFirstEvict = existsSync(ptFile);
      return { ok: true };
    });

    await purge.purgeCloneArtifacts('u1');

    // M2 (review) — evicts BOTH the base key and its `-preview` sidecar so a
    // `-preview` clone-prompt can't linger resident after "every artifact"
    // was supposedly erased.
    // fs-38 Wave 3c, Task 13 — plus the xtts-<uuid> voice on /xtts/evict-voice
    // (Coqui has no `-preview` design flow, so just the one canonical key).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9000/qwen/evict-voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voiceId: 'qwen-u1' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9000/qwen/evict-voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voiceId: 'qwen-u1-preview' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:9000/xtts/evict-voice',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ voiceId: 'xtts-u1' }),
      }),
    );
    expect(ptFileExistedAtFirstEvict).toBe(false);
  });

  /* Task 14a fix round 1, MEDIUM-1 — a REFUSED connection means nothing is
     listening on the sidecar port: no process, no in-process cache, so
     erasure genuinely IS total. Reporting `artifactPurgeIncomplete` here on
     every revoke for a user with `autoStartSidecar` off (the common case)
     would train them to ignore the signal — so this specific, provable
     shape reports clean, deliberately, not "every failure". Two forms of
     ECONNREFUSED are both recognised: a plain string message (what a test
     — or some platforms — hands back with no structured cause) and the
     real Node/undici shape (`TypeError: fetch failed` + `.cause.code`). */
  it('does not throw when the sidecar is not running (ECONNREFUSED), and reports failed: [] — erasure IS total', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await purge.purgeCloneArtifacts('u1');
    expect(result.failed).toEqual([]);
  });

  it('recognises the real Node/undici ECONNREFUSED shape (TypeError "fetch failed" + .cause.code), not just the bare string', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), {
          code: 'ECONNREFUSED',
        }),
      }),
    );
    const result = await purge.purgeCloneArtifacts('u1');
    expect(result.failed).toEqual([]);
  });

  /* Task 14a fix round 1, MEDIUM-1 (the other side of the same fix) — a
     rejection that is NOT provably "nothing is listening" (no ECONNREFUSED
     code/message — e.g. a generic network error, or the 10s AbortSignal
     firing on a wedged-but-alive process) carries no proof the sidecar's
     cache is empty, so it must still surface as a real failure. This is
     what the OLD (pre-Task-14a) code swallowed entirely via a bare
     `catch {}` with no accumulator of its own. */
  it('a non-ECONNREFUSED rejection (e.g. a timeout) still reports every lost evict in `failed`', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    const result = await purge.purgeCloneArtifacts('u1');
    expect(result.failed).toEqual([
      'sidecar:qwen:qwen-u1',
      'sidecar:qwen:qwen-u1-preview',
      'sidecar:xtts:xtts-u1',
    ]);
  });

  /* Task 14a — the OTHER failure shape: the sidecar is reached and responds,
     but with a non-2xx status (evict itself failed, e.g. the sidecar
     couldn't find/pop the cache entry). This never threw/rejected before —
     `fetch` only rejects on a network error/timeout, not on a non-2xx HTTP
     response — so the prior bare `catch {}` never even ran; the outcome was
     discarded because nothing checked `res.ok` at all. Timeout/rejection
     (above) and non-2xx (here) are different code paths through
     `evictSidecarVoice` and must both be covered. */
  it('a non-2xx sidecar evict response is reported in `failed` (different code path than a rejection)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const result = await purge.purgeCloneArtifacts('u1');
    expect(result.failed).toEqual([
      'sidecar:qwen:qwen-u1',
      'sidecar:qwen:qwen-u1-preview',
      'sidecar:xtts:xtts-u1',
    ]);
  });

  it('a clean sidecar evict (2xx on every call) still reports failed: []', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const result = await purge.purgeCloneArtifacts('u1');
    expect(result.failed).toEqual([]);
  });

  /* Review I-2 — every unlink used to be `rm(f, { force: true }).catch(() =>
     {})`: a real removal failure (not "file doesn't exist" — `force` already
     swallows that) was silently dropped, so a Windows EBUSY from the sidecar
     holding a `.pt` open mid-load would leave a live, resynthesis-capable
     artifact on disk while the caller believed erasure was total. This test
     fails before the fix — the prior signature always resolved `undefined`
     regardless of any unlink outcome, so there was no way to observe (or
     even detect) a partial failure. */
  it('review I-2: a failing unlink is reported in `failed`, logged, and does not skip the rest', async () => {
    // `qwenVoicePtPath(key)` is the FIRST entry in purgeCloneArtifacts'
    // internal `files` list, so the next `rm` call the module makes is for
    // this exact path — no path-matching needed in the mock.
    const ptFile = seed('qwen-u1', 'pt');
    const jsonFile = seed('qwen-u1', 'json');
    rmMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await purge.purgeCloneArtifacts('u1');

    expect(result.failed).toEqual([ptFile]);
    expect(existsSync(ptFile)).toBe(true); // never actually removed
    expect(existsSync(jsonFile)).toBe(false); // the OTHER file's removal still ran
    // The path is no longer baked into the format-string argument; it is now
    // the %s placeholder value, and the trailing error survives after it.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining(ptFile),
      ptFile,
      'u1',
      expect.objectContaining({ code: 'EBUSY' }),
    );

    warnSpy.mockRestore();
  });

  it('a base-key evict failure does not skip the -preview evict', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true });

    await purge.purgeCloneArtifacts('u1');

    // fs-38 Wave 3c, Task 13 — +1 for the xtts evict, now always attempted too.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /* fs-38 Wave 3c, Task 13 — evict is best-effort while file erasure must be
     reliable: an unreachable sidecar leaves latents resident in
     `CoquiEngine._latents_cache` for the rest of the process's lifetime
     (unlike the qwen prompt cache, which IS cleared on the base model's own
     `/unload`, there is no TTL reclaim for XTTS's cache) — but that must not
     stop the qwen evicts (or anything else) from running.

     Task 14a — this test used to assert `result.failed).toEqual([])` here,
     i.e. it pinned the exact defect Task 14a closes: the lost xtts evict
     (the one that matters most, since XTTS's cache has no TTL) vanished
     with no trace in the return value. Flipped to assert it now shows up.

     Fix round 1, MEDIUM-1 — the injected rejection is deliberately NOT
     ECONNREFUSED (a timeout, not a refused connection): a refused
     connection is now the one deliberate fail-open case (see the
     "not running" tests above), so this test — whose whole point is
     proving a REAL lost evict surfaces — needs a failure shape that isn't
     that carve-out. */
  it('an xtts evict failure does not skip anything else, and files are still gone', async () => {
    const ptFile = seedXtts('xtts-u1', 'pt');
    fetchMock
      .mockResolvedValueOnce({ ok: true }) // qwen base
      .mockResolvedValueOnce({ ok: true }) // qwen -preview
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout')); // xtts

    const result = await purge.purgeCloneArtifacts('u1');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(ptFile)).toBe(false);
    expect(result.failed).toEqual(['sidecar:xtts:xtts-u1']);
  });

  /* Fix wave (review I-2) — `purgeCloneArtifacts` can run INSIDE
     `updateEntry`'s per-uuid lock (the revoke `deleteMasterClip` branch and
     the cloned-resolver's revoked/gone status-stamp both call it from
     inside a mutate), and this best-effort evict used to be a bare
     unbounded `fetch` — a wedged/OOM'd sidecar that accepts the connection
     but never responds would park that uuid's lock indefinitely, including
     the revoke route's own SECOND `updateEntry` call. Each evict must now
     carry an abortable signal so the caller is never left waiting forever.
     Actually waiting out the real timeout isn't exercised here (that's a
     runtime property of Node's own `AbortSignal.timeout`, not this
     module's logic) — this pins the WIRING: every evict-voice fetch gets a
     real `AbortSignal`. */
  it('review I-2: every evict-voice fetch carries an abortable signal, so a hung sidecar cannot hold the lock forever', async () => {
    await purge.purgeCloneArtifacts('u1');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    }
  });
});

/* User-directed fix — revoke must also erase the person's original
   recording (the entry-dir clip), not just the derived engine artifacts.
   `deleteMasterClip` is the mechanism: unlike `deleteEntryDir` (delete),
   this keeps the manifest + entry dir, erasing only the clip file itself
   and clearing the manifest's `master` field so it never points at a
   deleted file. */
describe('purgeCloneArtifacts — deleteMasterClip (revoke recording erasure)', () => {
  function makeMaster(overrides: Partial<import('./voice-library.js').VoiceMaster> = {}) {
    return {
      clipFile: 'master.wav',
      sampleRate: 24000,
      durationSeconds: 12,
      transcript: 'hello there',
      transcriptSource: 'whisper' as const,
      captureMethod: 'record' as const,
      ...overrides,
    };
  }

  it('erases the entry-dir recording and clears master, leaving voice.json + consent readable', async () => {
    const voiceUuid = 'r1';
    await vl.writeEntry({
      voiceUuid,
      name: 'Dad',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
        revokedAt: '2026-07-26T00:00:00.000Z',
      },
      master: makeMaster(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const clipPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(clipPath, 'fake-wav-bytes');

    await purge.purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true });

    expect(existsSync(clipPath)).toBe(false); // the recording itself is gone
    const onDisk = await vl.readEntry(voiceUuid);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.master).toBeUndefined(); // cleared — never points at a deleted file
    expect(onDisk?.consent?.revokedAt).toBeTruthy(); // manifest + consent still readable
  });

  it('is a no-op when the entry has no master (nothing to erase)', async () => {
    const voiceUuid = 'r2';
    await vl.writeEntry({
      voiceUuid,
      name: 'No Clip',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'No Clip',
        relationship: 'self',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      purge.purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true }),
    ).resolves.toEqual({ failed: [] });
    const onDisk = await vl.readEntry(voiceUuid);
    expect(onDisk?.master).toBeUndefined();
  });

  it('is a no-op when the entry itself does not exist', async () => {
    await expect(
      purge.purgeCloneArtifacts('does-not-exist', { deleteMasterClip: true }),
    ).resolves.toEqual({ failed: [] });
  });

  it('leaves the recording untouched when deleteMasterClip is not set (existing revoke path)', async () => {
    const voiceUuid = 'r3';
    await vl.writeEntry({
      voiceUuid,
      name: 'Dad',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
      },
      master: makeMaster(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const clipPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(clipPath, 'fake-wav-bytes');

    await purge.purgeCloneArtifacts(voiceUuid);

    expect(existsSync(clipPath)).toBe(true);
    const onDisk = await vl.readEntry(voiceUuid);
    expect(onDisk?.master).toEqual(makeMaster());
  });

  /* GATE 1 fix (C2) — the bypass this locks is NOT "does a failed unlink get
     reported" (it always did, via `failed`); it is that the RETRY the module's
     own doc comment prescribes used to be a guaranteed no-op that reported
     clean. So the test drives both revokes: the first fails the clip unlink,
     the second (clip now unlockable) must actually re-attempt it. Before the
     fix the second call returned early on `fresh.master === undefined`, left
     the clip on disk forever, and resolved `{ failed: [] }` — a clean 200. */
  it('GATE 1 (C2): a FAILED clip unlink keeps `master`, so the documented retry-revoke really re-erases it', async () => {
    const voiceUuid = 'r4';
    await vl.writeEntry({
      voiceUuid,
      name: 'Dad',
      provenance: 'cloned',
      tags: [],
      pinned: false,
      engines: {},
      consent: {
        personName: 'Dad',
        relationship: 'family-with-permission',
        permittedUse: 'personal',
        attestedAt: '2026-01-01T00:00:00.000Z',
        attestedBy: 'me',
        revokedAt: '2026-07-26T00:00:00.000Z',
      },
      master: makeMaster(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const clipPath = join(vl.entryDir(voiceUuid), 'master.wav');
    writeFileSync(clipPath, 'fake-wav-bytes');

    // Fail ONLY the clip's unlink (the Windows EBUSY case unlinkTracked's own
    // doc comment exists for); every other artifact path still really unlinks.
    let clipUnlinkAttempts = 0;
    rmMock.mockImplementation(async (f: string, opts?: unknown) => {
      if (f === clipPath) {
        clipUnlinkAttempts += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.rm(f, opts as never);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await purge.purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true });

    expect(clipUnlinkAttempts).toBe(1);
    expect(first.failed).toContain(clipPath);
    expect(existsSync(clipPath)).toBe(true); // still on disk — the unlink failed
    // The pointer MUST survive: it is the only thing a retry can find the
    // clip from. Clearing it here is what orphaned the recording.
    expect((await vl.readEntry(voiceUuid))?.master).toEqual(makeMaster());

    // Second revoke — the operator's documented recovery, clip no longer held.
    rmMock.mockImplementation(async (f: string, opts?: unknown) => {
      if (f === clipPath) clipUnlinkAttempts += 1;
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.rm(f, opts as never);
    });

    const second = await purge.purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true });

    expect(clipUnlinkAttempts).toBe(2); // it was genuinely RE-attempted
    expect(second.failed).toEqual([]);
    expect(existsSync(clipPath)).toBe(false); // the recording is finally gone
    expect((await vl.readEntry(voiceUuid))?.master).toBeUndefined();

    warnSpy.mockRestore();
  });
  /* CodeQL #211 (js/tainted-format-string) — console.warn treats its FIRST
     argument as a format string when more arguments follow. A `%s` appearing
     inside the interpolated VOICE UUID (diagnostic data that echoes user
     input) used to be absorbed into that format string and swallow the
     trailing `err` — the exact harm this warning exists to surface. This test
     proves the placeholder conversion (voiceUuid is now an ARGUMENT, not part
     of the format string) renders the injected `%s` literally AND keeps the
     error as the rendered line's own tail, instead of letting user data eat it. */
  it('CodeQL #211: a %s injected via the uuid no longer swallows the trailing error in the failure warn', async () => {
    const injectedUuid = 'vo%suuid';
    const ptFile = seed(`qwen-${injectedUuid}`, 'pt');
    const boom = Object.assign(new Error('EBUSY: clone artifact pinned open'), { code: 'EBUSY' });
    rmMock.mockImplementation(async (f: string, opts?: unknown) => {
      if (f === ptFile) throw boom;
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.rm(f, opts as never);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await purge.purgeCloneArtifacts(injectedUuid);

    const warnCall = warnSpy.mock.calls.find((c) => String(c[0]).includes('failed to erase'));
    expect(warnCall).toBeDefined();
    const rendered = format(...(warnCall as unknown[]));
    // The injected `%s` is ARGUMENT text now, not part of the format string —
    // it must render verbatim. Pre-fix it was absorbed into the format and
    // vanished (that is what eats the following error), so this alone goes red.
    expect(rendered).toContain(injectedUuid);
    // And the trailing error is still rendered, AFTER the placeholder that used
    // to swallow it — it was not consumed by the injected `%`.
    expect(rendered.indexOf('EBUSY: clone artifact pinned open')).toBeGreaterThan(
      rendered.indexOf(injectedUuid),
    );

    warnSpy.mockRestore();
  });

});
