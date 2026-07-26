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

  /* #1836 — mock mode must not keep reproducing the bug the real route just
     fixed, so it mirrors the same precedence: a supplied non-blank transcript
     wins and flips transcriptSource to 'user'. */
  it('prefers a supplied transcript and records transcriptSource=user', async () => {
    const entry = await mockCloneVoice({
      candidateId: 'cand-1',
      transcript: 'the quick brown fox jumped over',
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
    });
    expect(entry.master?.transcript).toBe('the quick brown fox jumped over');
    expect(entry.master?.transcriptSource).toBe('user');
    expect(entry.sampleTranscript).toBe('the quick brown fox jumped over');
  });

  it('falls back to the canned Whisper transcript when none/blank is supplied', async () => {
    const none = await mockCloneVoice({
      candidateId: 'cand-1',
      consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
    });
    expect(none.master?.transcript).toBe('the quick brown fox jumped');
    expect(none.master?.transcriptSource).toBe('whisper');

    const blank = await mockCloneVoice({
      candidateId: 'cand-2',
      transcript: '   ',
      consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
    });
    expect(blank.master?.transcript).toBe('the quick brown fox jumped');
    expect(blank.master?.transcriptSource).toBe('whisper');
  });

  it('keeps transcriptSource=whisper when the supplied text matches the canned one', async () => {
    const entry = await mockCloneVoice({
      candidateId: 'cand-1',
      transcript: 'the quick brown fox jumped',
      consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
    });
    expect(entry.master?.transcriptSource).toBe('whisper');
  });
});
