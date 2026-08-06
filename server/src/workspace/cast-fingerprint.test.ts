/* #2015 — the compare-and-set primitive behind the merge-base staleness
   detector. The coupling test at the bottom is the important one: it is the
   only thing standing between a change to writeJsonAtomic's serialisation and
   a detector that reports a conflict on every write it makes itself. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './state-io.js';
import { readFile } from 'node:fs/promises';
import {
  ABSENT,
  hashBytes,
  readJsonWithFingerprint,
  fingerprintOfWrite,
} from './cast-fingerprint.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'castwright-fingerprint-'));
}

describe('readJsonWithFingerprint', () => {
  it('returns ABSENT — not null, not a hash — for a file that does not exist', async () => {
    const dir = tmpDir();
    try {
      const got = await readJsonWithFingerprint(join(dir, 'nope.json'));
      expect(got.value).toBeNull();
      expect(got.fingerprint).toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes the RAW bytes, not a re-serialised form', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      /* Deliberately non-canonical whitespace: a normalising implementation
         would hash this identically to the compact form below, which is the
         bug this asserts against. */
      writeFileSync(p, '{  "characters"  :  [ ]  }', 'utf8');
      const loose = await readJsonWithFingerprint(p);
      writeFileSync(p, '{"characters":[]}', 'utf8');
      const tight = await readJsonWithFingerprint(p);

      expect(loose.value).toEqual({ characters: [] });
      expect(tight.value).toEqual({ characters: [] });
      expect(loose.fingerprint).not.toBe(tight.fingerprint);
      expect(loose.fingerprint).toBe(hashBytes('{  "characters"  :  [ ]  }'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still fingerprints unparseable bytes (a malformed cast.json is a real on-disk state)', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      writeFileSync(p, '{ not json', 'utf8');
      const got = await readJsonWithFingerprint(p);
      expect(got.value).toBeNull();
      expect(got.fingerprint).toBe(hashBytes('{ not json'));
      expect(got.fingerprint).not.toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fingerprintOfWrite — coupling guard against writeJsonAtomic', () => {
  it('predicts the exact bytes writeJsonAtomic lands on disk', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      const payload = { characters: [{ id: 'nova', voiceId: 'v1', nested: { a: [1, 2] } }] };
      await writeJsonAtomic(p, payload);
      const onDisk = await readFile(p, 'utf8');

      /* If writeJsonAtomic ever changes its serialisation (indent, key order,
         trailing newline), this fails HERE rather than as a detector that
         reports a conflict on every write it made itself. */
      expect(fingerprintOfWrite(payload)).toBe(hashBytes(onDisk));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees with what readJsonWithFingerprint observes after the write', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      const payload = { characters: [{ id: 'wren' }] };
      await writeJsonAtomic(p, payload);
      const observed = await readJsonWithFingerprint(p);
      expect(observed.fingerprint).toBe(fingerprintOfWrite(payload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ABSENT can never collide with a real sha256 hex digest', () => {
    expect(ABSENT).not.toMatch(/^[0-9a-f]{64}$/);
    expect(hashBytes('')).toMatch(/^[0-9a-f]{64}$/);
    /* The name of this test claims the guarantee comes from the NUL prefix, so
       assert THAT, not merely that the sentinel fails a hex-digest regex — a
       plain 'ABSENT' with no prefix would pass the regex check too. A sha256
       hex digest can only contain [0-9a-f], so a leading NUL makes collision
       impossible by construction rather than by length. */
    expect(ABSENT.startsWith(String.fromCharCode(0))).toBe(true);
  });
});
