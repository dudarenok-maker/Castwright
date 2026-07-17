/* Task 6 (per-model-keepalive plan) — analyzerKeepAliveByModel round-trip.

   mockPutUserSettings enforces an explicit whitelist of patchable fields
   (both a destructure block and an Object.entries block); a new field
   dropped from either one is silently discarded rather than persisted.
   This test exercises the mock path directly (VITE_USE_MOCKS=true) so a
   whitelist miss fails loudly instead of only surfacing once the real
   Model Manager UI (Task 7) tries to save a keep-alive override. */

import { describe, it, expect, vi } from 'vitest';

// Force mock mode so `api` resolves to the mock object (not the real fetch-based one).
vi.stubEnv('VITE_USE_MOCKS', 'true');

// Must be a dynamic import AFTER stubEnv so the module sees the stubbed env.
const { api } = await import('./api');

describe('mockPutUserSettings — analyzerKeepAliveByModel', () => {
  it('persists analyzerKeepAliveByModel', async () => {
    const out = await api.putUserSettings({
      analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300 },
    });
    // analyzerKeepAliveByModel is optional on the generated UserSettings type
    // (not in the schema's `required` list); the mock always seeds it to {}.
    expect(out.analyzerKeepAliveByModel!['qwen36-castwright:latest']).toBe(300);
  });
});
