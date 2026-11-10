/* #2015 — the single-read primitive behind `readPriorCastLockFree`: one
   `readFile`, the parsed value plus the hash of the exact bytes parsed, with
   `ABSENT` / `UNREADABLE` kept distinct from a parse failure. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Mock fs/promises so a single test can inject a non-ENOENT read failure
   without relying on the real filesystem (#2185 review, item 1) — every
   other call (the default readFile path, writeFile, rename, ...) still
   points at the real impl. Module-scoped swap, mirroring state-io.test.ts's
   setRenameImpl pattern: each test installs its own failure via
   setReadFileImpl(). */
type ReadFileUtf8 = (path: string, encoding: BufferEncoding) => Promise<string>;
let readFileImpl: ReadFileUtf8 | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const actualReadFile = actual.readFile as unknown as ReadFileUtf8;
  return {
    ...actual,
    readFile: (path: string, encoding: BufferEncoding): Promise<string> =>
      (readFileImpl ?? actualReadFile)(path, encoding),
  };
});

function setReadFileImpl(fn: ReadFileUtf8 | null): void {
  readFileImpl = fn;
}

/* Import AFTER vi.mock so cast-fingerprint.ts picks up the mocked readFile. */
const {
  ABSENT,
  UNREADABLE,
  hashBytes,
  readJsonWithFingerprint,
} = await import('./cast-fingerprint.js');

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

  it('parses a BOM-prefixed cast.json, hashing the RAW (unstripped) bytes (#2365 C1)', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    const pNoBom = join(dir, 'cast-no-bom.json');
    try {
      const body = '{"characters":[]}';
      writeFileSync(p, '\ufeff' + body, 'utf8');
      writeFileSync(pNoBom, body, 'utf8');

      const withBom = await readJsonWithFingerprint(p);
      const withoutBom = await readJsonWithFingerprint(pNoBom);

      /* The parse must succeed despite the BOM. */
      expect(withBom.value).toEqual({ characters: [] });

      /* The fingerprint must be over the RAW bytes actually on disk — a BOM'd
         file and its BOM-less twin are different bytes and MUST fingerprint
         differently. A stripped-then-hashed implementation would collapse
         the two, which would silently invalidate every fingerprint stored
         before this fix (they were computed over un-stripped bytes) the
         moment a BOM'd file was introduced. */
      expect(withBom.fingerprint).not.toBe(withoutBom.fingerprint);
      expect(withBom.fingerprint).toBe(hashBytes('\ufeff' + body));
      expect(withoutBom.fingerprint).toBe(hashBytes(body));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns UNREADABLE — not ABSENT — for a non-ENOENT read failure (#2185 review)', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      writeFileSync(p, '{"characters":[]}', 'utf8');
      const err = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      setReadFileImpl(async () => {
        throw err;
      });

      const got = await readJsonWithFingerprint(p);

      expect(got.value).toBeNull();
      expect(got.fingerprint).toBe(UNREADABLE);
      expect(got.fingerprint).not.toBe(ABSENT);
    } finally {
      setReadFileImpl(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still returns ABSENT for a real ENOENT even with the mock installed (no regression on the happy path)', async () => {
    const dir = tmpDir();
    try {
      setReadFileImpl(null); // default pass-through — ENOENT comes from the real fs
      const got = await readJsonWithFingerprint(join(dir, 'nope.json'));
      expect(got.value).toBeNull();
      expect(got.fingerprint).toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
