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
       so the JSON envelope is part of the message. Pinned in full, because
       a mock that renders a *prettier* error than production hides a real
       wart the wizard shows verbatim — and no test could catch it. */
    await expect(
      mockCloneVoice({
        candidateId: 'cand-1',
        transcript: 'x'.repeat(MAX_CLONE_TRANSCRIPT_CHARS + 1),
        consent,
      }),
    ).rejects.toThrow(
      `Voice clone failed (400): {"error":"Transcript is too long (max ${MAX_CLONE_TRANSCRIPT_CHARS} characters)."}`,
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

/* The cap exists in four places — this constant, the route's
   MAX_CLONE_TRANSCRIPT_CHARS, openapi.yaml's CloneVoiceRequest.transcript
   maxLength, and (generated from that) api-types.ts — tied together only by
   prose. The server suite pins its copy against the contract; this pins the
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

  /* `maxLength` is not the only place the contract states the number: the
     schema description explains the byte arithmetic, and #1840 already shipped
     a version documenting two caps 2x apart. Pinning `maxLength` alone leaves
     that prose free to rot, so scan the whole transcript block plus the clone
     400 for any 4-digit number and require each to be the cap or one of its
     two derived bounds. Reword-proof in a way phrase-matching wouldn't be. */
  it('states no stale copy of the cap anywhere in the clone contract', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const yaml = await readFile(resolve(process.cwd(), 'openapi.yaml'), 'utf8');

    const schemaAnchor = yaml.indexOf('    CloneVoiceRequest:');
    const blockStart = yaml.indexOf('        transcript:', schemaAnchor);
    const blockEnd = yaml.indexOf('        consent:', blockStart);
    // Fail closed if the schema is renamed or its properties reordered.
    expect(schemaAnchor).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const fourHundred = /'400': \{ description: Missing candidateId[^}]*\}/.exec(yaml)?.[0];
    expect(fourHundred).toBeDefined();

    const cap = MAX_CLONE_TRANSCRIPT_CHARS;
    // The cap itself, its worst-case UTF-8 byte bound (3 bytes per UTF-16
    // unit), and that bound base64-encoded (4/3). Nothing else belongs here.
    const allowed = [cap, cap * 3, cap * 4].map(String);
    const region = `${yaml.slice(blockStart, blockEnd)}\n${fourHundred}`;
    for (const found of region.match(/\d{4,}/g) ?? []) {
      expect(allowed).toContain(found);
    }
  });
});
