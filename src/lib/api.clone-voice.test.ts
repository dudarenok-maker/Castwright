import { describe, it, expect, beforeEach } from 'vitest';
import { mockCloneVoice, _resetMockVoiceLibrary, mockListVoiceLibrary } from './api';

beforeEach(() => _resetMockVoiceLibrary());

describe('mockCloneVoice', () => {
  it('mints a ready cloned entry and appends it to the library', async () => {
    const before = (await mockListVoiceLibrary()).voices.length;
    const entry = await mockCloneVoice({
      candidateId: 'cand-1',
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
    });
    expect(entry.provenance).toBe('cloned');
    expect(entry.engines.qwen?.status).toBe('ready');
    expect(entry.consent?.personName).toBe('Mum');
    expect(entry.master?.clipFile).toBe('master.wav');
    const after = (await mockListVoiceLibrary()).voices.length;
    expect(after).toBe(before + 1);
  });
});
