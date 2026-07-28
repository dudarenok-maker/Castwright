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

   3. DELETE /api/voice-library/{voiceUuid}/assign is the new unassign. */

import { afterEach, describe, expect, it, expectTypeOf, vi } from 'vitest';
import type { paths } from './api-types';
import { api } from './api';

type DeleteEntryOk =
  paths['/api/voice-library/{voiceUuid}']['delete']['responses']['200']['content']['application/json'];
type AssignOk =
  paths['/api/voice-library/{voiceUuid}/assign']['post']['responses']['200']['content']['application/json'];
type UnassignOk =
  paths['/api/voice-library/{voiceUuid}/assign']['delete']['responses']['200']['content']['application/json'];

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
