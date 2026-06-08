/* Focused test: Qwen batching knobs read through the config registry so app
   overrides are reflected. Covers tts.batch.size (QWEN_BATCH_SIZE) and
   tts.batch.bucket (QWEN_BATCH_BUCKET). */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
  resolveUserSettingsPath: () => '/tmp/test-user-settings.json',
  USER_SETTINGS_PATH: '/tmp/test-user-settings.json',
  LEGACY_USER_SETTINGS_PATH: '/tmp/legacy-user-settings.json',
}));

import { configValue } from '../config/resolver.js';
import * as us from '../workspace/user-settings.js';

describe('config resolver wiring — Qwen batching knobs', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it('tts.batch.size returns 32 by default', () => {
    expect(configValue<number>('tts.batch.size')).toBe(32);
  });

  it('app override of tts.batch.size changes the resolved batch width', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.batch.size': 4,
    });
    expect(configValue<number>('tts.batch.size')).toBe(4);
  });

  it('tts.batch.bucket is true by default', () => {
    expect(configValue<boolean>('tts.batch.bucket')).toBe(true);
  });

  it('app override of tts.batch.bucket can disable length-bucketing', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.batch.bucket': false,
    });
    expect(configValue<boolean>('tts.batch.bucket')).toBe(false);
  });
});
