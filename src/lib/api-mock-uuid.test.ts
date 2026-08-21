import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDesignLibraryVoice, mockPromoteToLibrary, mockCloneVoice } from './api';

describe('API mock functions — secure uuid generation in non-secure contexts', () => {
  let originalCrypto: Crypto | undefined;

  beforeEach(() => {
    originalCrypto = globalThis.crypto;
  });

  afterEach(() => {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      });
    }
  });

  it('mockDesignLibraryVoice generates valid voiceUuid even when crypto.randomUUID throws', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: vi.fn(() => {
          throw new TypeError('randomUUID is only available in secure context');
        }),
        getRandomValues: (buf: Uint8Array) => {
          for (let i = 0; i < buf.length; i++) {
            buf[i] = Math.floor(Math.random() * 256);
          }
          return buf;
        },
      },
      configurable: true,
    });

    const result = await mockDesignLibraryVoice({
      name: 'Test Voice',
      persona: 'friendly',
    });

    expect(result.entry.voiceUuid).toBeTruthy();
    expect(result.entry.voiceUuid).toMatch(/^lib-[0-9a-z]+$/i);
  });

  it('mockPromoteToLibrary generates valid voiceUuid even when crypto is undefined', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const result = await mockPromoteToLibrary({
      bookId: 'book-1',
      characterId: 'char-1',
      name: 'Promoted Voice',
    });

    expect(result.voiceUuid).toBeTruthy();
    expect(result.voiceUuid).toMatch(/^lib-[0-9a-z]+$/i);
  });

  it('mockCloneVoice generates valid voiceUuid even when getRandomValues throws', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: undefined,
        getRandomValues: vi.fn(() => {
          throw new Error('getRandomValues failed');
        }),
      },
      configurable: true,
    });

    const result = await mockCloneVoice({
      candidateId: 'cand-123',
      name: 'Cloned Voice',
      consent: {
        relationship: 'self',
        personName: 'John Doe',
        permittedUse: 'personal',
      },
    });

    expect(result.voiceUuid).toBeTruthy();
    expect(result.voiceUuid).toMatch(/^lib-clone-[0-9a-z]+$/i);
  });
});
