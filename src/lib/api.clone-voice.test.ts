import { describe, it, expect, beforeEach } from 'vitest';
import { mockCloneVoice, _resetMockVoiceLibrary, mockListVoiceLibrary } from './api';
import { MAX_CLONE_TRANSCRIPT_CHARS } from './clone-transcript-limit';

const consent = { personName: 'Mum', relationship: 'self', permittedUse: 'personal' } as const;

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

  /* #1836 follow-up — the route 400s an over-length transcript. A mock that
     accepted it would make mock/e2e mode strictly more permissive than the
     real server on the one rejection the wizard can surface, so the failure
     would only ever appear against a real backend. */
  it('rejects an over-length transcript the way the route does', async () => {
    const before = (await mockListVoiceLibrary()).voices.length;
    /* The exact string realCloneVoice would build: it interpolates
       `await res.text()` and the route replies `res.status(400).json({ error })`,
       so the JSON envelope is part of the message. A mock rendering a
       *prettier* error than production would hide a real wart the wizard
       shows verbatim, and no test could catch it. Passed as an Error, not a
       string — `toThrow('…')` is a SUBSTRING match, which would accept a mock
       that appended to the message. */
    await expect(
      mockCloneVoice({
        candidateId: 'cand-1',
        transcript: 'x'.repeat(MAX_CLONE_TRANSCRIPT_CHARS + 1),
        consent,
      }),
    ).rejects.toThrow(
      new Error(
        `Voice clone failed (400): {"error":"Transcript is too long (max ${MAX_CLONE_TRANSCRIPT_CHARS} characters)."}`,
      ),
    );
    /* Rejected outright, not truncated-and-saved — no entry appears. */
    expect((await mockListVoiceLibrary()).voices.length).toBe(before);
  });

  it('accepts a transcript exactly at the cap', async () => {
    const atCap = 'x'.repeat(MAX_CLONE_TRANSCRIPT_CHARS);
    const entry = await mockCloneVoice({ candidateId: 'cand-1', transcript: atCap, consent });
    expect(entry.master?.transcript).toBe(atCap);
  });
});

/* The cap exists in three places — this constant, the route's
   MAX_CLONE_TRANSCRIPT_CHARS, and openapi.yaml's
   CloneVoiceRequest.transcript.maxLength — tied together only by prose.
   (api-types.ts is NOT a fourth: openapi-typescript does not encode
   `maxLength`, so the generated type carries no bound and cannot drift.)
   The server suite pins its copy against the contract; this pins the
   frontend's, so raising one in isolation fails on both sides of the wire.
   Asserting against a second literal here would pin nothing. */
describe('MAX_CLONE_TRANSCRIPT_CHARS', () => {
  it('agrees with openapi.yaml CloneVoiceRequest.transcript maxLength', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    /* Not `new URL(..., import.meta.url)`: Vite rewrites import.meta.url to a
       non-file scheme under jsdom. Vitest runs with cwd at the config root,
       which is the repo root. */
    const yaml = await readFile(resolve(process.cwd(), 'openapi.yaml'), 'utf8');
    const anchor = yaml.indexOf('    CloneVoiceRequest:');
    expect(anchor).toBeGreaterThan(-1); // fail closed if the schema is renamed
    const transcriptBlock = yaml.slice(yaml.indexOf('        transcript:', anchor));
    const maxLength = /maxLength:\s*(\d+)/.exec(transcriptBlock)?.[1];
    expect(maxLength).toBe(String(MAX_CLONE_TRANSCRIPT_CHARS));
  });

  /* #1840 shipped a contract documenting two caps 2x apart, because the
     schema description and the 400 both restated the number. The durable fix
     was to delete those restatements rather than to pin them: `maxLength` is
     now the only place the contract states it, so the single pin above covers
     the whole contract. A prose-scanning test was tried here and removed —
     it could not tell a stale `200` from a deliberate one, treated the byte
     and base64 bounds as interchangeable, and false-positived on an issue
     reference like (#1836). Fewer numbers beats a cleverer test. */
  it('states the cap only once, so the pin above covers the whole contract', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const yaml = await readFile(resolve(process.cwd(), 'openapi.yaml'), 'utf8');

    const schemaAnchor = yaml.indexOf('    CloneVoiceRequest:');
    const blockStart = yaml.indexOf('        transcript:', schemaAnchor);
    const blockEnd = yaml.indexOf('        consent:', blockStart);
    /* Fail closed if the schema is renamed or its properties reordered.
       blockStart needs its own guard: indexOf clamps a -1 fromIndex to 0, so
       blockEnd would resolve against a DIFFERENT schema's `consent:` and the
       slice would silently collapse to empty. */
    expect(schemaAnchor).toBeGreaterThan(-1);
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);

    const block = yaml.slice(blockStart, blockEnd);
    expect(block).toContain('base64'); // the slice really is the transcript block
    /* Exactly one occurrence, and it is the maxLength the test above pins. */
    const occurrences = block.match(new RegExp(String(MAX_CLONE_TRANSCRIPT_CHARS), 'g')) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(block).toContain(`maxLength: ${MAX_CLONE_TRANSCRIPT_CHARS}`);
  });
});
