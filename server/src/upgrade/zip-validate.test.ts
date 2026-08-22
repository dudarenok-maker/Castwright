/* fs-1 — pin validateUpgradeManifest (pure structural + version checks) and the
   resolved-requirements hash readUpgradeZip/validateUpgradeZip produce. */

import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import yazl from 'yazl';

import { validateUpgradeManifest, validateUpgradeZip, REQUIRED_ENTRIES } from './zip-validate.js';
import { computeReqHash, resolveRequired } from '../../tts-sidecar/scripts/venv-migration.mjs';

const TOP = 'castwright-v1.6.0';
function goodEntries(top = TOP): string[] {
  return [`${top}/`, ...REQUIRED_ENTRIES.map((e) => `${top}/${e}`), `${top}/src/main.tsx`];
}

describe('validateUpgradeManifest', () => {
  it('accepts a well-formed newer release', () => {
    const r = validateUpgradeManifest({
      entryNames: goodEntries(),
      packageJsonVersion: '1.6.0',
      runningVersion: '1.5.1',
    });
    expect(r.ok).toBe(true);
    expect(r.candidateVersion).toBe('1.6.0');
    expect(r.isDowngrade).toBe(false);
  });

  it('rejects more than one top-level directory', () => {
    const r = validateUpgradeManifest({
      entryNames: [...goodEntries(), 'evil/passwd'],
      packageJsonVersion: '1.6.0',
      runningVersion: '1.5.1',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad-structure');
  });

  it('rejects a wrong top-dir name', () => {
    const r = validateUpgradeManifest({
      entryNames: goodEntries('totally-not-us-v1.6.0'),
      packageJsonVersion: '1.6.0',
      runningVersion: '1.5.1',
    });
    expect(r.code).toBe('bad-structure');
  });

  it('rejects a missing required artefact', () => {
    const entries = goodEntries().filter((e) => !e.endsWith('server/dist/index.js'));
    const r = validateUpgradeManifest({
      entryNames: entries,
      packageJsonVersion: '1.6.0',
      runningVersion: '1.5.1',
    });
    expect(r.code).toBe('missing-entry');
    expect(r.reason).toContain('server/dist/index.js');
  });

  it('rejects an unparseable version', () => {
    const r = validateUpgradeManifest({
      entryNames: goodEntries(),
      packageJsonVersion: 'nope',
      runningVersion: '1.5.1',
    });
    expect(r.code).toBe('bad-version');
  });

  it('refuses a downgrade unless forced', () => {
    const down = validateUpgradeManifest({
      entryNames: goodEntries('castwright-v1.4.0'),
      packageJsonVersion: '1.4.0',
      runningVersion: '1.6.0',
    });
    expect(down.ok).toBe(false);
    expect(down.code).toBe('downgrade');
    expect(down.isDowngrade).toBe(true);

    const forced = validateUpgradeManifest({
      entryNames: goodEntries('castwright-v1.4.0'),
      packageJsonVersion: '1.4.0',
      runningVersion: '1.6.0',
      allowDowngrade: true,
    });
    expect(forced.ok).toBe(true);
    expect(forced.isDowngrade).toBe(true);
  });

  it('allows a same-version reinstall (not a downgrade)', () => {
    const r = validateUpgradeManifest({
      entryNames: goodEntries(),
      packageJsonVersion: '1.6.0',
      runningVersion: '1.6.0',
    });
    expect(r.ok).toBe(true);
    expect(r.isDowngrade).toBe(false);
  });

  it('rejects a legacy audiobook-generator-* top dir as bad-structure', () => {
    const res = validateUpgradeManifest({
      entryNames: ['audiobook-generator-v1.6.0/package.json'],
      packageJsonVersion: '1.7.0',
      runningVersion: '1.6.0',
      allowDowngrade: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('bad-structure');
  });
});

describe('validateUpgradeZip reqHash (resolved overlay + base + speaker-qa, not the shim)', () => {
  const TOP_Z = 'castwright-v1.7.0';
  // The requirements.txt shim is `-r requirements/nvidia-cuda.txt`; the real pins
  // live in the overlay (which `-r base.txt`), base, and speaker-qa.txt (which every
  // overlay `-r`s). The hash MUST cover the resolved set, in resolveRequired's
  // order (overlay THEN base THEN speaker-qa).
  const SHIM = '-r requirements/nvidia-cuda.txt\n';
  const OVERLAY = '-r base.txt\nqwen-tts\nkokoro-onnx>=0.4.0,<0.5.0\n';
  const BASE = 'fastapi>=0.115,<0.116\nnumpy>=1.26,<3.0\ntransformers>=4.45,<5.0\n';
  const SPEAKER_QA = 'speechbrain==1.1.0\nhuggingface_hub==0.36.2\n';

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zipvalidate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a minimal-but-valid release zip on disk; returns its path. Pass null
      for overlay/base/speakerQa to omit that entry (the defensive missing-file
      path). */
  function buildZip(opts: {
    overlay?: string | null;
    base?: string | null;
    speakerQa?: string | null;
    shim?: string | null;
    version?: string;
  }): Promise<string> {
    const {
      overlay = OVERLAY,
      base = BASE,
      speakerQa = SPEAKER_QA,
      shim = SHIM,
      version = '1.7.0',
    } = opts;
    const zipPath = join(dir, `${TOP_Z}.zip`);
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(JSON.stringify({ version }), 'utf8'), `${TOP_Z}/package.json`);
    for (const req of REQUIRED_ENTRIES) {
      if (req === 'package.json') continue;
      zf.addBuffer(Buffer.from('x', 'utf8'), `${TOP_Z}/${req}`);
    }
    if (shim !== null) {
      zf.addBuffer(Buffer.from(shim, 'utf8'), `${TOP_Z}/server/tts-sidecar/requirements.txt`);
    }
    if (overlay !== null) {
      zf.addBuffer(
        Buffer.from(overlay, 'utf8'),
        `${TOP_Z}/server/tts-sidecar/requirements/nvidia-cuda.txt`,
      );
    }
    if (base !== null) {
      zf.addBuffer(Buffer.from(base, 'utf8'), `${TOP_Z}/server/tts-sidecar/requirements/base.txt`);
    }
    if (speakerQa !== null) {
      zf.addBuffer(
        Buffer.from(speakerQa, 'utf8'),
        `${TOP_Z}/server/tts-sidecar/requirements/speaker-qa.txt`,
      );
    }
    zf.end();
    return new Promise((resolve, reject) => {
      const out = createWriteStream(zipPath);
      zf.outputStream.pipe(out);
      out.on('close', () => resolve(zipPath));
      out.on('error', reject);
    });
  }

  it('hashes the resolved overlay+base+speaker-qa in resolveRequired order (matches the stamp hash)', async () => {
    const zipPath = await buildZip({});
    const v = await validateUpgradeZip(zipPath, '1.6.0');
    expect(v.ok).toBe(true);
    // Byte-identical to what resolveRequired writes into the venv stamp.
    expect(v.reqHash).toBe(computeReqHash([OVERLAY, BASE, SPEAKER_QA]));
  });

  it('changes when an overlay pin is edited', async () => {
    const baseline = await validateUpgradeZip(await buildZip({}), '1.6.0');
    const edited = await validateUpgradeZip(
      await buildZip({ overlay: OVERLAY.replace('0.4.0', '0.5.0') }),
      '1.6.0',
    );
    expect(edited.reqHash).not.toBe(baseline.reqHash);
  });

  it('changes when a base pin is edited', async () => {
    const baseline = await validateUpgradeZip(await buildZip({}), '1.6.0');
    const edited = await validateUpgradeZip(
      await buildZip({ base: BASE.replace('4.45', '4.46') }),
      '1.6.0',
    );
    expect(edited.reqHash).not.toBe(baseline.reqHash);
  });

  it('changes when a speaker-qa pin is edited (#2588 pass-3: the failure mode this whole block guards)', async () => {
    const baseline = await validateUpgradeZip(await buildZip({}), '1.6.0');
    const edited = await validateUpgradeZip(
      await buildZip({ speakerQa: SPEAKER_QA.replace('1.1.0', '1.2.0') }),
      '1.6.0',
    );
    expect(edited.reqHash).not.toBe(baseline.reqHash);
  });

  it('does NOT change when only the shim text is edited (proves the shim is no longer hashed)', async () => {
    const baseline = await validateUpgradeZip(await buildZip({}), '1.6.0');
    const shimEdited = await validateUpgradeZip(
      await buildZip({ shim: '-r requirements/nvidia-cuda.txt  # touched\n' }),
      '1.6.0',
    );
    expect(shimEdited.reqHash).toBe(baseline.reqHash);
  });

  it('falls back to null reqHash when the overlay file is absent', async () => {
    const v = await validateUpgradeZip(await buildZip({ overlay: null }), '1.6.0');
    expect(v.reqHash).toBeNull();
  });

  it('falls back to null reqHash when the base file is absent', async () => {
    const v = await validateUpgradeZip(await buildZip({ base: null }), '1.6.0');
    expect(v.reqHash).toBeNull();
  });

  it('falls back to null reqHash when the speaker-qa file is absent', async () => {
    const v = await validateUpgradeZip(await buildZip({ speakerQa: null }), '1.6.0');
    expect(v.reqHash).toBeNull();
  });
});

describe('validateUpgradeZip reqHash vs. resolveRequired — the two producers cannot silently diverge (#2588 pass 3)', () => {
  // resolveRequired (venv-migration.mjs, consumed by bootstrap-venv.mjs + apply.ts)
  // and validateUpgradeZip (this file, consumed by the zip-upload upgrade path) are
  // two SEPARATE producers of "the requirements hash for this release". #2588 pass 3
  // caught them drifting: resolveRequired grew a 3rd file (speaker-qa.txt) that
  // validateUpgradeZip never learned to hash, so a speaker-qa-only version bump left
  // ctx.reqHash unchanged on the zip/self-upgrade path — #2534's exact failure mode,
  // reopened. This test builds a real sidecarDir tree AND a zip with identical
  // requirements content and asserts the two producers agree over it, so a future
  // requirements-file addition that updates only one producer fails HERE rather than
  // silently shipping.
  const TOP_Z = 'castwright-v1.7.0';
  const OVERLAY = '-r base.txt\nqwen-tts\nkokoro-onnx>=0.4.0,<0.5.0\n';
  const BASE = 'fastapi>=0.115,<0.116\nnumpy>=1.26,<3.0\ntransformers>=4.45,<5.0\n';
  const SPEAKER_QA = 'speechbrain==1.1.0\nhuggingface_hub==0.36.2\n';

  let dir: string;
  let sidecarDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zipvalidate-parity-'));
    sidecarDir = join(dir, 'sidecar');
    mkdirSync(join(sidecarDir, 'requirements'), { recursive: true });
    writeFileSync(join(sidecarDir, 'python-tag.txt'), 'cp312-cp312-win_amd64\n', 'utf8');
    writeFileSync(join(sidecarDir, 'requirements', 'nvidia-cuda.txt'), OVERLAY, 'utf8');
    writeFileSync(join(sidecarDir, 'requirements', 'base.txt'), BASE, 'utf8');
    writeFileSync(join(sidecarDir, 'requirements', 'speaker-qa.txt'), SPEAKER_QA, 'utf8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildMatchingZip(): Promise<string> {
    const zipPath = join(dir, `${TOP_Z}.zip`);
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(JSON.stringify({ version: '1.7.0' }), 'utf8'), `${TOP_Z}/package.json`);
    for (const req of REQUIRED_ENTRIES) {
      if (req === 'package.json') continue;
      zf.addBuffer(Buffer.from('x', 'utf8'), `${TOP_Z}/${req}`);
    }
    zf.addBuffer(Buffer.from(OVERLAY, 'utf8'), `${TOP_Z}/server/tts-sidecar/requirements/nvidia-cuda.txt`);
    zf.addBuffer(Buffer.from(BASE, 'utf8'), `${TOP_Z}/server/tts-sidecar/requirements/base.txt`);
    zf.addBuffer(
      Buffer.from(SPEAKER_QA, 'utf8'),
      `${TOP_Z}/server/tts-sidecar/requirements/speaker-qa.txt`,
    );
    zf.end();
    return new Promise((resolve, reject) => {
      const out = createWriteStream(zipPath);
      zf.outputStream.pipe(out);
      out.on('close', () => resolve(zipPath));
      out.on('error', reject);
    });
  }

  it('produces the SAME reqHash as resolveRequired over identical requirements content', async () => {
    const required = resolveRequired(sidecarDir, 'nvidia');
    const zipPath = await buildMatchingZip();
    const v = await validateUpgradeZip(zipPath, '1.6.0');
    expect(v.reqHash).toBe(required.reqHash);
  });
});
