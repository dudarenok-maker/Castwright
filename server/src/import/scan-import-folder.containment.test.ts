/* #3711 -- bundle containment. yauzl refuses `..` entry names by default, which
   this importer must not be the only thing standing on: a bundle-supplied
   `state.manuscriptFile` or `audio/` entry name that resolves outside the
   staging / book folder is rejected as an InvalidBundleError. yauzl is replaced
   by a fake that hands back whatever names the test gives it, so the importer's
   own check is what is exercised. */

import { readdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let fakeEntries: [string, Buffer][] = [];

vi.mock('yauzl', () => ({
  fromBuffer: (
    _buf: Buffer,
    _opts: unknown,
    cb: (err: Error | null, zip?: EventEmitter) => void,
  ) => {
    const z = new EventEmitter() as EventEmitter & {
      readEntry: () => void;
      openReadStream: (e: { fileName: string }, cb2: (e: null, rs: Readable) => void) => void;
    };
    let i = 0;
    z.readEntry = () => {
      setImmediate(() => {
        if (i >= fakeEntries.length) return z.emit('end');
        z.emit('entry', { fileName: fakeEntries[i][0] });
      });
    };
    z.openReadStream = (e, cb2) => {
      const hit = fakeEntries[i++];
      void e;
      cb2(null, Readable.from([hit[1]]));
    };
    cb(null, z);
  },
}));

const { importPortableBundle, InvalidBundleError } = await import('./scan-import-folder.js');

function bundle(manuscriptFile: string, extra: [string, Buffer][]): void {
  const state = {
    bookId: 'demo__standalones__containment',
    manuscriptId: 'mns_c',
    title: 'Containment Test',
    author: 'Demo Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile,
    castConfirmed: true,
    chapters: [],
    coverGradient: ['#abc', '#def'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
  fakeEntries = [
    ['MANIFEST.json', Buffer.from(JSON.stringify({ schemaVersion: 1 }))],
    ['state.json', Buffer.from(JSON.stringify(state))],
    [manuscriptFile, Buffer.from('body')],
    ...extra,
  ];
}

describe('importPortableBundle containment', () => {
  beforeEach(() => {
    fakeEntries = [];
  });

  it('rejects an audio entry name that climbs out of the book folder', async () => {
    bundle('manuscript.txt', [['audio/../../../../escaped-audio.mp3', Buffer.from('x')]]);
    await expect(importPortableBundle(Buffer.alloc(0))).rejects.toBeInstanceOf(InvalidBundleError);
  });

  it('rejects a manuscriptFile that climbs out of the book folder', async () => {
    bundle('../../../escaped-manuscript.txt', []);
    await expect(importPortableBundle(Buffer.alloc(0))).rejects.toBeInstanceOf(InvalidBundleError);
  });

  it('still imports a well-formed bundle through the same fake', async () => {
    bundle('manuscript.txt', [['audio/01-a.mp3', Buffer.from('x')]]);
    const r = await importPortableBundle(Buffer.alloc(0), { onConflict: 'rename' });
    expect(r.importedFiles).toBeGreaterThan(0);
    try {
      expect(readdirSync(r.targetPath)).toContain('manuscript.txt');
    } finally {
      rmSync(r.targetPath, { recursive: true, force: true });
    }
  });
});
