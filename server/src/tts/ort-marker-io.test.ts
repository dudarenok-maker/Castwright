import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MARKER_INSTALLER, isOurMarker, writeOrtMarker, deleteOrtMarkerIfOurs, findPlainOrtDistInfos,
  // @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
} from '../../tts-sidecar/scripts/install-ort.mjs';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function sp() {
  const d = mkdtempSync(join(tmpdir(), 'sp-'));
  tmpDirs.push(d);
  return d;
}

/** A REAL plain onnxruntime distribution — byte-identical directory name to ours. */
function realPlainDist(root: string, version = '1.28.0') {
  const d = join(root, `onnxruntime-${version}.dist-info`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'METADATA'), `Metadata-Version: 2.1\nName: onnxruntime\nVersion: ${version}\n`);
  writeFileSync(join(d, 'INSTALLER'), 'pip\n');
  writeFileSync(join(d, 'RECORD'), 'onnxruntime/capi/_pybind_state.pyd,sha256=abc,123\n');
  return d;
}

describe('isOurMarker', () => {
  it('accepts a marker we wrote', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');
    expect(isOurMarker(join(root, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('REFUSES the real plain distribution (name is identical — identity is not)', () => {
    const root = sp();
    const real = realPlainDist(root);
    expect(isOurMarker(real)).toBe(false);
  });

  it('refuses a dir with our INSTALLER but a non-empty RECORD', () => {
    const root = sp();
    const d = join(root, 'onnxruntime-9.9.9.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'INSTALLER'), `${MARKER_INSTALLER}\n`);
    writeFileSync(join(d, 'RECORD'), 'something\n');
    expect(isOurMarker(d)).toBe(false);
  });

  it('REFUSES a foreign dist-info even when its RECORD is empty', () => {
    const root = sp();
    const d = join(root, 'onnxruntime-1.28.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime\nVersion: 1.28.0\n');
    writeFileSync(join(d, 'INSTALLER'), 'pip\n');
    writeFileSync(join(d, 'RECORD'), '');
    expect(isOurMarker(d)).toBe(false);
  });
});

describe('writeOrtMarker', () => {
  it('writes METADATA, INSTALLER and an EMPTY RECORD', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');
    const d = join(root, 'onnxruntime-1.27.0.dist-info');
    expect(readFileSync(join(d, 'METADATA'), 'utf8')).toContain('Name: onnxruntime');
    expect(readFileSync(join(d, 'METADATA'), 'utf8')).toContain('Version: 1.27.0');
    expect(readFileSync(join(d, 'INSTALLER'), 'utf8').trim()).toBe(MARKER_INSTALLER);
    expect(readFileSync(join(d, 'RECORD'), 'utf8')).toBe('');
  });

  it('overwrites a STALE marker rather than skipping it', () => {
    const root = sp();
    writeOrtMarker(root, '1.26.0');
    writeOrtMarker(root, '1.27.0');
    expect(existsSync(join(root, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
    expect(existsSync(join(root, 'onnxruntime-1.26.0.dist-info'))).toBe(false);
  });
});

describe('deleteOrtMarkerIfOurs', () => {
  it('removes our marker and reports true', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');
    expect(deleteOrtMarkerIfOurs(root)).toBe(true);
    expect(existsSync(join(root, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
  });

  it('REFUSES to delete the real plain distribution', () => {
    const root = sp();
    const real = realPlainDist(root);
    expect(deleteOrtMarkerIfOurs(root)).toBe(false);
    expect(existsSync(real)).toBe(true);
  });

  it('is a no-op when nothing is present', () => {
    expect(deleteOrtMarkerIfOurs(sp())).toBe(false);
  });

  it('deletes ours even when a real distribution sits beside it', () => {
    const root = sp();
    const real = realPlainDist(root, '1.28.0');
    writeOrtMarker(root, '1.27.0');
    expect(deleteOrtMarkerIfOurs(root)).toBe(true);
    expect(existsSync(real)).toBe(true);
  });

  it('REFUSES to delete a foreign dist-info with an empty RECORD', () => {
    const root = sp();
    const d = join(root, 'onnxruntime-1.28.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'INSTALLER'), 'pip\n');
    writeFileSync(join(d, 'RECORD'), '');
    expect(deleteOrtMarkerIfOurs(root)).toBe(false);
    expect(existsSync(d)).toBe(true);
  });
});

describe('findPlainOrtDistInfos', () => {
  it('identity-tests EVERY match, not just the first', () => {
    const root = sp();
    writeOrtMarker(root, '1.27.0');          // ours, sorts first
    const realA = realPlainDist(root, '1.28.0');
    const realB = realPlainDist(root, '1.29.0');
    expect(findPlainOrtDistInfos(root).sort()).toEqual([realA, realB].sort());
  });
});
