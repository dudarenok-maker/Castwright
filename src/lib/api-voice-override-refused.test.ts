/* #2718 review round 1 — VoiceOverrideRefusedError's hand-typed shape did not
   match the actual 409 body PUT /api/voices/:voiceId/override returns (which
   openapi.yaml documents correctly): `error` is always the server's own
   sentence, never the literal `'already_cloned'`, and `skipped` is present
   only on the write-time residual refusal, absent on the two upfront
   refusals. VoiceOverrideRefused's constructor also discarded that sentence
   in favour of a hardcoded generic message, so profile-drawer.tsx's
   `(err as Error).message` — the only consumer — showed the wrong text,
   losing the server's remediation guidance. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, VoiceOverrideRefused } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.setVoiceOverride — 409 refusal', () => {
  it("surfaces the server's own sentence, not a hardcoded generic message", async () => {
    const message =
      'Voice "shared-voice-id" has a consented cloned voice on a linked character, on a different ' +
      'engine — switching it to qwen would silently stop that voice rendering. Reassign that ' +
      'character directly instead.';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 409 })),
      ),
    );

    const err = await api
      .setVoiceOverride('shared-voice-id', { engine: 'qwen', name: 'qwen-shared' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(VoiceOverrideRefused);
    expect((err as Error).message).toBe(message);
  });

  it('parses a body with no `skipped` field (the two upfront-refusal shapes)', async () => {
    const message = 'Voice "shared-voice-id" has a consented cloned voice on a linked character.';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 409 })),
      ),
    );

    const err = (await api
      .setVoiceOverride('shared-voice-id', null)
      .catch((e: Error) => e)) as VoiceOverrideRefused;
    expect(err).toBeInstanceOf(VoiceOverrideRefused);
    expect(err.body.error).toBe(message);
    expect(err.body.skipped).toBeUndefined();
  });

  it('carries `skipped` through on the write-time residual-refusal shape', async () => {
    const message = 'Voice "shared-voice-id" has a consented cloned voice on a linked character.';
    const skipped = [{ bookDir: '(unknown)', characterId: 'shared-voice-id', reason: 'already_cloned' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: message, skipped }), { status: 409 }),
        ),
      ),
    );

    const err = (await api
      .setVoiceOverride('shared-voice-id', { engine: 'qwen', name: 'qwen-shared' })
      .catch((e: Error) => e)) as VoiceOverrideRefused;
    expect(err.body.skipped).toEqual(skipped);
  });
});
