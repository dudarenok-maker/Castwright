/* fs-38 Wave 3c GATE 1 — the voice-library contract shapes that changed in
   the fix round, pinned against the GENERATED types (`api-types.ts` is
   emitted from openapi.yaml by `npm run openapi:types` — never hand-edited).

   These are compile-time assertions: they fail under `npm run typecheck`
   (pre-commit/pre-push/CI), not at vitest runtime. That IS the gate for a
   contract change — a spec that lies about a reachable response shape has no
   runtime symptom until a caller trusts it.

   1. DELETE /api/voice-library/{voiceUuid} used to pin
      `deleted: { type: boolean, enum: [true] }`. The Critical-fix round made
      `deleted: false` reachable: when the artifact purge leaves anything
      behind, the route KEEPS the manifest entry (the consent gates key off
      it) and reports the incomplete purge instead of claiming an erasure it
      did not achieve. The spec then said the opposite of the server.

   2. POST /api/voice-library/{voiceUuid}/assign now reports WHICH engine
      slots it persisted, because it does not always persist the one the
      caller asked for.

   3. DELETE /api/voice-library/{voiceUuid}/assign is the new unassign.

   4. Plan 276, Task 9 — PATCH /api/voice-library/{voiceUuid} grew a
      `transcript` body field (the "Add transcript" cast-time-gate CTA), and
      POST /api/voice-library/{voiceUuid}/engines/{engine}/retry is a brand
      new route (the "Retry derive" CTA). Both responses go through
      `withComputedStaleness`, so their `engines[*].status` is the COMPUTED
      status, not necessarily what is persisted — pinned here so a client
      change can't quietly start trusting the persisted value instead. */

import { afterEach, describe, expect, it, expectTypeOf, vi } from 'vitest';
import type { paths } from './api-types';
import { api } from './api';
import type { VoiceLibraryPatch } from './api';

type DeleteEntryOk =
  paths['/api/voice-library/{voiceUuid}']['delete']['responses']['200']['content']['application/json'];
type AssignOk =
  paths['/api/voice-library/{voiceUuid}/assign']['post']['responses']['200']['content']['application/json'];
type UnassignOk =
  paths['/api/voice-library/{voiceUuid}/assign']['delete']['responses']['200']['content']['application/json'];
type PatchEntryBody =
  paths['/api/voice-library/{voiceUuid}']['patch']['requestBody']['content']['application/json'];
type PatchEntryOk =
  paths['/api/voice-library/{voiceUuid}']['patch']['responses']['200']['content']['application/json'];
type RetryEngineParams =
  paths['/api/voice-library/{voiceUuid}/engines/{engine}/retry']['post']['parameters']['path'];
type RetryEngineOk =
  paths['/api/voice-library/{voiceUuid}/engines/{engine}/retry']['post']['responses']['200']['content']['application/json'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openapi: DELETE /api/voice-library/{voiceUuid} — deleted is a real boolean', () => {
  it('types `deleted` as boolean, not the literal true', () => {
    expectTypeOf<DeleteEntryOk['deleted']>().toEqualTypeOf<boolean>();
  });

  it('accepts the incomplete-purge response the route actually sends', () => {
    /* The exact shape server/src/routes/voice-library.ts answers when
       `eraseLibraryVoiceArtifacts` reports a non-empty `failed`. Under the
       old `enum: [true]` spec this object was not assignable at all. */
    const incompletePurge: DeleteEntryOk = {
      deleted: false,
      artifactPurgeIncomplete: true,
      artifactPurgeFailedPaths: ['voices/xtts/xtts-abc.pt'],
    };
    expect(incompletePurge.deleted).toBe(false);
    expectTypeOf(incompletePurge.artifactPurgeFailedPaths).toEqualTypeOf<string[] | undefined>();
  });

  it('the client surfaces an incomplete purge instead of flattening it to success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            deleted: false,
            artifactPurgeIncomplete: true,
            artifactPurgeFailedPaths: ['voices/xtts/xtts-abc.pt'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await api.deleteVoiceLibrary('lib-1', { confirm: true });
    /* Reading these fields off the client's return type is itself the
       regression: the old hand-written `{ deleted: true } | { usage }` had no
       room for either, so this block did not compile. */
    expect('deleted' in result && result.deleted).toBe(false);
    expect('deleted' in result && result.artifactPurgeIncomplete).toBe(true);
    expect('deleted' in result && result.artifactPurgeFailedPaths).toEqual([
      'voices/xtts/xtts-abc.pt',
    ]);
  });
});

describe('openapi: POST /assign reports the written slots [F1]', () => {
  it('requires `written` and restricts it to the clone-capable engines', () => {
    expectTypeOf<AssignOk['written']>().toEqualTypeOf<('qwen' | 'coqui')[]>();
    // Required, not optional — a caller cannot silently skip reconciling.
    expectTypeOf<AssignOk>().toHaveProperty('written');
    const qwenOnly: AssignOk = { updated: 1, written: ['qwen'] };
    expect(qwenOnly.written).toEqual(['qwen']);
  });

  it('the client carries `written` through untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ updated: 1, written: ['qwen'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await api.assignLibraryVoice('lib-1', {
      bookId: 'b1',
      characterId: 'c1',
      modelKey: 'coqui-xtts-v2',
    });
    expect(result).toEqual({ updated: 1, written: ['qwen'] });
  });
});

describe('openapi: DELETE /assign is the unassign affordance [DELTA-I5]', () => {
  it('exists and reports the cleared slots', () => {
    expectTypeOf<UnassignOk['cleared']>().toEqualTypeOf<('qwen' | 'coqui')[]>();
  });

  it('the client sends bookId/characterId as query params on a DELETE', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cleared: ['coqui'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.unassignLibraryVoice('lib-1', {
      bookId: 'book 1',
      characterId: 'char-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice-library/lib-1/assign?bookId=book+1&characterId=char-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(result).toEqual({ cleared: ['coqui'] });
  });

  it('surfaces a non-2xx unassign as a throw rather than a silent no-op', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    );
    await expect(
      api.unassignLibraryVoice('lib-1', { bookId: 'b1', characterId: 'c1' }),
    ).rejects.toThrow('Voice library unassign failed (500)');
  });
});

const minimalEntry = (): PatchEntryOk => ({
  voiceUuid: 'lib-1',
  name: 'Voice',
  provenance: 'cloned',
  tags: [],
  pinned: false,
  engines: { qwen: { status: 'stale' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('openapi: PATCH /api/voice-library/{voiceUuid} accepts `transcript` [Plan 276 Decision 6]', () => {
  it('the request body type matches the hand-written client wrapper', () => {
    // Both sides optional strings — a spec/wrapper mismatch here (e.g. the
    // wrapper adding a maxLength the spec doesn't enforce, or vice versa)
    // would still type-check as a widening/narrowing bug this pins against.
    expectTypeOf<PatchEntryBody['transcript']>().toEqualTypeOf<VoiceLibraryPatch['transcript']>();
  });

  it('the 400 rejection carries a plain `error` string', () => {
    type PatchBadTranscript =
      paths['/api/voice-library/{voiceUuid}']['patch']['responses']['400']['content']['application/json'];
    const rejected: PatchBadTranscript = { error: 'Transcript is too long (max 2000 characters).' };
    expect(rejected.error).toContain('Transcript');
  });

  it('the client sends `transcript` on the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(minimalEntry()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.patchVoiceLibrary('lib-1', { transcript: 'Corrected line.' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice-library/lib-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ transcript: 'Corrected line.' }) }),
    );
  });

  it('a `failed` qwen slot in the response reads through as `failed`, not silently upgraded', async () => {
    // Regression shape for [R4]/eb265d71: this response passes through
    // withComputedStaleness server-side, but that transform must never touch
    // a `failed` slot — only a version-stale ready one. Pinning that the
    // client reads whatever the server sent, unmassaged.
    const failedEntry: PatchEntryOk = { ...minimalEntry(), engines: { qwen: { status: 'failed' } } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(failedEntry), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await api.patchVoiceLibrary('lib-1', { transcript: '' });
    expect(result.engines.qwen?.status).toBe('failed');
  });
});

describe('openapi: POST /api/voice-library/{voiceUuid}/engines/{engine}/retry [Plan 276 Decision 7]', () => {
  it('restricts `engine` to the clone-capable engine names', () => {
    expectTypeOf<RetryEngineParams['engine']>().toEqualTypeOf<'qwen' | 'coqui'>();
  });

  it('the 200 response is a full VoiceLibraryEntry', () => {
    const entry: RetryEngineOk = minimalEntry();
    expect(entry.voiceUuid).toBe('lib-1');
  });

  it('the client POSTs to the engine-scoped retry path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(minimalEntry()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.retryCloneEngine('lib-1', 'coqui');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice-library/lib-1/engines/coqui/retry',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.voiceUuid).toBe('lib-1');
  });

  it('surfaces a non-2xx retry as a throw rather than a silent no-op', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 404 })));
    await expect(api.retryCloneEngine('lib-1', 'qwen')).rejects.toThrow('Voice engine retry failed (404)');
  });
});
