import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { ensureOrtMarker, writeOrtMarker } from '../../tts-sidecar/scripts/install-ort.mjs';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function venv({ owner, realDist }: { owner: 'swap' | 'plain' | 'none'; realDist?: boolean }) {
  const root = mkTmp('venv-');
  const sp = join(root, 'Lib', 'site-packages');
  mkdirSync(sp, { recursive: true });
  if (owner !== 'none') {
    const capi = join(sp, 'onnxruntime', 'capi');
    mkdirSync(capi, { recursive: true });
    const name = owner === 'swap' ? 'onnxruntime-gpu' : 'onnxruntime';
    writeFileSync(join(capi, 'build_and_package_info.py'), `package_name = '${name}'\n`);
  }
  if (owner === 'swap') {
    const d = join(sp, 'onnxruntime_gpu-1.27.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime-gpu\nVersion: 1.27.0\n');
  }
  if (realDist) {
    const d = join(sp, 'onnxruntime-1.28.0.dist-info');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime\nVersion: 1.28.0\n');
    writeFileSync(join(d, 'INSTALLER'), 'pip\n');
    writeFileSync(join(d, 'RECORD'), 'onnxruntime/x,sha256=a,1\n');
  }
  return { root, sp };
}

describe('ensureOrtMarker', () => {
  it('writes a marker on a healthy GPU venv bootstrapped before this change', () => {
    const { root, sp } = venv({ owner: 'swap' });
    expect(ensureOrtMarker(root)).toBe('wrote');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
  });

  it('is idempotent — second run is a no-op', () => {
    const { root } = venv({ owner: 'swap' });
    ensureOrtMarker(root);
    expect(ensureOrtMarker(root)).toBe('noop');
  });

  it('REFUSES on a clobbered venv and names the remedy', () => {
    const { root, sp } = venv({ owner: 'swap', realDist: true });

    // Snapshot dist-info directories before the call: should have GPU (onnxruntime_gpu)
    // and real plain (onnxruntime-1.28.0) dist-info directories.
    const distInfoBefore = readdirSync(sp)
      .filter((d) => d.endsWith('.dist-info'))
      .sort();

    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('clobbered');
    expect(existsSync(join(sp, 'onnxruntime-1.28.0.dist-info'))).toBe(true);
    const message = lines.join('\n');

    // Verify NO MARKER was written: the dist-info directories must be unchanged.
    // The fixture starts with 2 dist-info entries (onnxruntime_gpu-1.27.0 and
    // onnxruntime-1.28.0); refusing must not add any (e.g., onnxruntime-1.27.0).
    const distInfoAfter = readdirSync(sp)
      .filter((d) => d.endsWith('.dist-info'))
      .sort();
    expect(distInfoAfter).toEqual(distInfoBefore);

    // The message must accurately describe the state: a stray plain dist-info coexists
    // with the GPU build's files (which own the namespace), NOT the other way around.
    expect(message).not.toContain('installed over the GPU runtime');
    expect(message).not.toContain('GPU Kokoro is disabled');

    // Structural tokens present in the real message (but would survive a gutted stub).
    expect(message).toContain('install-ort.mjs');
    expect(message).toContain('coexist');

    // Substantive semantic content that would be lost in a token-satisfying stub.
    // These catch a message gutted to just '[ort-marker] coexist install-ort.mjs'.
    expect(message).toContain('A stray real plain onnxruntime dist-info');
    expect(message).toContain('dependency resolution');
    expect(message).toContain('inconsistency must be repaired');
    expect(message).toContain('Refusing to write a marker');
    expect(message).toContain('bad state');

    // Pin the specific corrected content from c556f51c: the namespace is owned by the GPU build,
    // not "GPU Kokoro is currently working" as it was before. A revert to the old wording would
    // fail this assertion, catching mutation M1.
    expect(message).toContain('The GPU build\'s files currently own the namespace');

    // Pin the consolidation from commit 07e94d22: the redundant clause '(which own the namespace)'
    // was removed from the first sentence (the message now only states namespace ownership once,
    // in the second sentence). A revert of 07e94d22 would restore that clause, failing this check.
    expect(message).not.toContain('(which own the namespace)');

    // Minimum length guard: the full message is ~444 chars; a gutted stub is ~40 chars.
    // This catches attempts to reduce the message to just the structural tokens.
    expect(message.length).toBeGreaterThan(300);
  });

  it('REFUSES on a clobbered venv even when the real plain dist-info shares the GPU version (in-place-overwrite blind spot)', () => {
    // The fixture above pins the GPU and real-plain dist-infos to DIFFERENT versions
    // (1.27.0 / 1.28.0), so a wrongful write creates a THIRD, differently-named
    // dist-info folder — visible to a directory-listing/existsSync check. But
    // writeOrtMarker's real implementation does `rmSync(dir); renameSync(tmpDir, dir)` —
    // an IN-PLACE replacement when the marker's target version matches an EXISTING
    // folder name. If the real plain dist-info happens to share the GPU build's
    // version, a wrongful write would silently destroy its contents while leaving
    // the directory name (and existsSync) unchanged — invisible to a name-only check.
    // This fixture manufactures exactly that same-version collision and asserts on
    // FILE CONTENT, not just the folder name, to catch that specific regression.
    const { root, sp } = venv({ owner: 'swap' });
    // Manually create a real plain dist-info folder matching the GPU version (1.27.0);
    // the venv() helper supplies no realDist here, so we add it ourselves.
    const realDir = join(sp, 'onnxruntime-1.27.0.dist-info');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'METADATA'), 'Metadata-Version: 2.1\nName: onnxruntime\nVersion: 1.27.0\n');
    writeFileSync(join(realDir, 'INSTALLER'), 'pip\n');
    writeFileSync(join(realDir, 'RECORD'), 'onnxruntime/x,sha256=a,1\n');

    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('clobbered');

    // The folder still exists (a name-only check would stop here and pass even on
    // a regression) — the real assertion is that its CONTENT is untouched.
    expect(existsSync(realDir)).toBe(true);
    expect(readFileSync(join(realDir, 'INSTALLER'), 'utf8')).toBe('pip\n');
    expect(readFileSync(join(realDir, 'RECORD'), 'utf8')).toBe('onnxruntime/x,sha256=a,1\n');
  });

  it('deletes a lying marker when the CPU build owns the namespace', () => {
    const { root, sp } = venv({ owner: 'plain' });
    writeOrtMarker(sp, '1.27.0');
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('deleted');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
    const message = lines.join('\n');
    expect(message).toContain('[ort-marker]');
    expect(message).toContain('plain onnxruntime');
    expect(message).toContain('CPU build');
    expect(message).toContain('without GPU acceleration');
  });

  it('deletes a lying marker after an INTERRUPTED SWAP — no runtime at all', () => {
    const { root, sp } = venv({ owner: 'none' });
    writeOrtMarker(sp, '1.27.0');
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('deleted');
    expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
    const message = lines.join('\n');
    expect(message).toContain('[ort-marker]');
    expect(message).toContain('No onnxruntime runtime is installed');
    expect(message).toContain('Kokoro cannot load at all');
    expect(message).toContain('CASTWRIGHT_ACCELERATOR_PROFILE');
    expect(message).toContain('install-ort.mjs');
  });

  it('never throws on a venv that does not exist', () => {
    const gone = join(tmpdir(), 'definitely-not-a-venv-2192');
    rmSync(gone, { recursive: true, force: true });
    expect(() => ensureOrtMarker(gone)).not.toThrow();
    expect(ensureOrtMarker(gone)).toBe('noop');
  });

  it('never creates a site-packages tree on a half-built venv', () => {
    const root = mkTmp('venv-');
    ensureOrtMarker(root);
    expect(existsSync(join(root, 'Lib', 'site-packages'))).toBe(false);
  });

  it('never throws on a corrupted venv whose site-packages is a file, not a directory', () => {
    const root = mkTmp('venv-');
    mkdirSync(join(root, 'Lib'), { recursive: true });
    writeFileSync(join(root, 'Lib', 'site-packages'), 'not a directory');
    const lines: string[] = [];
    expect(() => ensureOrtMarker(root, (m: string) => lines.push(m))).not.toThrow();
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('noop');
    expect(lines.some((line) => line.includes('skipped') && line.includes('not a directory'))).toBe(true);
  });

  it('returns noop when no runtime exists and no marker is present (row 6)', () => {
    const { root } = venv({ owner: 'none' });
    const lines: string[] = [];
    expect(ensureOrtMarker(root, (m: string) => lines.push(m))).toBe('noop');
    expect(lines.length).toBe(0);
  });

  it.each([
    {
      name: 'clobbered branch',
      setup: () => venv({ owner: 'swap', realDist: true }),
      expectedReturn: 'clobbered',
      verify: (sp: string) => {
        expect(existsSync(join(sp, 'onnxruntime-1.28.0.dist-info'))).toBe(true);
        // No marker written over the real distribution, even when the caller-supplied
        // log throws — the GPU version's marker name must not appear.
        expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
      },
    },
    {
      name: 'wrote branch (fresh marker on GPU venv)',
      setup: () => venv({ owner: 'swap' }),
      expectedReturn: 'wrote',
      verify: (sp: string) => {
        expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(true);
      },
    },
    {
      name: 'deletion branch for plain onnxruntime',
      setup: () => {
        const { root, sp } = venv({ owner: 'plain' });
        writeOrtMarker(sp, '1.27.0');
        return { root, sp };
      },
      expectedReturn: 'deleted',
      verify: (sp: string) => {
        expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
      },
    },
    {
      name: 'deletion branch for no runtime (interrupted swap)',
      setup: () => {
        const { root, sp } = venv({ owner: 'none' });
        writeOrtMarker(sp, '1.27.0');
        return { root, sp };
      },
      expectedReturn: 'deleted',
      verify: (sp: string) => {
        expect(existsSync(join(sp, 'onnxruntime-1.27.0.dist-info'))).toBe(false);
      },
    },
    {
      name: 'catch block for corrupted venv (site-packages is a file)',
      setup: () => {
        const root = mkTmp('venv-');
        mkdirSync(join(root, 'Lib'), { recursive: true });
        writeFileSync(join(root, 'Lib', 'site-packages'), 'not a directory');
        return { root, sp: '' };
      },
      expectedReturn: 'noop',
      verify: (_sp: string) => undefined,
    },
  ])('never throws even when the caller-supplied log itself throws ($name)', ({ setup, expectedReturn, verify }) => {
    // The safeLog wrapper inside ensureOrtMarker must catch and swallow throwing
    // logs at every call site — including the clobbered, wrote, plain-deletion, none-deletion,
    // and catch-block error-handler branches. A throwing log must not defeat the "never throws"
    // guarantee that ensureOrtMarker's callers (server startup) depend on.
    const { root, sp } = setup();
    const throwingLog = () => {
      throw new Error('log sink is down');
    };
    let result;
    expect(() => {
      result = ensureOrtMarker(root, throwingLog);
    }).not.toThrow();
    expect(result).toBe(expectedReturn);
    verify(sp);
  });
});
