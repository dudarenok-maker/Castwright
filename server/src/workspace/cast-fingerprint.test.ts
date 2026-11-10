/* #2015 — the single-read primitive behind `readPriorCastLockFree`: one
   `readFile`, the parsed value plus the read's status, with `ABSENT` /
   `UNREADABLE` kept distinct from a parse failure. (Plan 291 Task 28 fix
   round 1: the bytes' hash fed the deleted merge base and is gone; its
   hash-only cases went with it.) */
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
const { ABSENT, UNREADABLE, READ, readJsonWithStatus } = await import('./cast-fingerprint.js');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'castwright-fingerprint-'));
}

describe('readJsonWithStatus', () => {
  it('returns ABSENT for a file that does not exist', async () => {
    const dir = tmpDir();
    try {
      const got = await readJsonWithStatus(join(dir, 'nope.json'));
      expect(got.value).toBeNull();
      expect(got.status).toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads and parses a cast.json', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      writeFileSync(p, '{  "characters"  :  [ ]  }', 'utf8');
      const got = await readJsonWithStatus(p);
      expect(got.value).toEqual({ characters: [] });
      expect(got.status).toBe(READ);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unparseable bytes are READ with a null value (a malformed cast.json is a real on-disk state)', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      writeFileSync(p, '{ not json', 'utf8');
      const got = await readJsonWithStatus(p);
      expect(got.value).toBeNull();
      expect(got.status).toBe(READ);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a BOM-prefixed cast.json (#2365 C1)', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      writeFileSync(p, '﻿{"characters":[]}', 'utf8');
      const got = await readJsonWithStatus(p);
      expect(got.value).toEqual({ characters: [] });
      expect(got.status).toBe(READ);
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

      const got = await readJsonWithStatus(p);

      expect(got.value).toBeNull();
      expect(got.status).toBe(UNREADABLE);
      expect(got.status).not.toBe(ABSENT);
    } finally {
      setReadFileImpl(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still returns ABSENT for a real ENOENT even with the mock installed (no regression on the happy path)', async () => {
    const dir = tmpDir();
    try {
      setReadFileImpl(null); // default pass-through — ENOENT comes from the real fs
      const got = await readJsonWithStatus(join(dir, 'nope.json'));
      expect(got.value).toBeNull();
      expect(got.status).toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
