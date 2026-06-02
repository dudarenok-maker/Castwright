/* fs-1 — validation for an uploaded release zip before it's allowed to apply.

   A release zip is `audiobook-generator-vX.Y.Z/` with the repo tree under it.
   We refuse anything that doesn't look like our release (wrong top dir, missing
   required artefacts, unparseable version) and refuse a downgrade unless the
   caller explicitly forces it. The structural checks are a PURE function over
   the entry-name list so they're exhaustively unit-testable without a real zip;
   readUpgradeZip is the thin yauzl reader that feeds it. */

import { createHash } from 'node:crypto';
import yauzl from 'yauzl';

import { compareVersions } from '../app-version.js';

/** Files that MUST be present (relative to the top dir) for a zip to be a
    plausible release — a pre-built frontend + server bundle, the runtime
    entry, and the stable launcher. */
export const REQUIRED_ENTRIES = [
  'package.json',
  'server/dist/index.js',
  'dist/index.html',
  'scripts/start-app-prod.mjs',
  'launch.mjs',
];

const TOP_DIR_RE = /^audiobook-generator-v\d+\.\d+\.\d+$/;

export type ManifestCode = 'ok' | 'bad-structure' | 'missing-entry' | 'bad-version' | 'downgrade';

export interface ManifestResult {
  ok: boolean;
  code: ManifestCode;
  reason?: string;
  topDir?: string;
  candidateVersion?: string;
  isDowngrade?: boolean;
}

/** Pure structural + version validation over a zip's entry names. */
export function validateUpgradeManifest(input: {
  entryNames: string[];
  packageJsonVersion?: string | null;
  runningVersion: string;
  allowDowngrade?: boolean;
}): ManifestResult {
  const { entryNames, packageJsonVersion, runningVersion, allowDowngrade } = input;

  // Exactly one top-level directory, named audiobook-generator-vX.Y.Z.
  const topSegments = new Set(
    entryNames.map((n) => n.replace(/\\/g, '/').split('/')[0]).filter(Boolean),
  );
  if (topSegments.size !== 1) {
    return { ok: false, code: 'bad-structure', reason: `expected a single top-level directory, found ${topSegments.size}` };
  }
  const topDir = [...topSegments][0];
  if (!TOP_DIR_RE.test(topDir)) {
    return { ok: false, code: 'bad-structure', reason: `top-level directory "${topDir}" is not audiobook-generator-vX.Y.Z` };
  }

  // Required artefacts present under the top dir.
  const names = new Set(entryNames.map((n) => n.replace(/\\/g, '/')));
  for (const req of REQUIRED_ENTRIES) {
    if (!names.has(`${topDir}/${req}`)) {
      return { ok: false, code: 'missing-entry', reason: `required file missing: ${req}`, topDir };
    }
  }

  // Version must parse and be well-formed.
  const candidateVersion = (packageJsonVersion ?? '').trim();
  if (!/^\d+\.\d+\.\d+/.test(candidateVersion)) {
    return { ok: false, code: 'bad-version', reason: `package.json version "${candidateVersion}" is not semver`, topDir };
  }

  const cmp = compareVersions(candidateVersion, runningVersion);
  const isDowngrade = cmp < 0;
  if (isDowngrade && !allowDowngrade) {
    return {
      ok: false,
      code: 'downgrade',
      reason: `candidate v${candidateVersion} is older than the running v${runningVersion}`,
      topDir,
      candidateVersion,
      isDowngrade,
    };
  }

  return { ok: true, code: 'ok', topDir, candidateVersion, isDowngrade };
}

export interface ZipReadResult {
  entryNames: string[];
  packageJsonText: string | null;
  requirementsText: string | null;
  topDir: string | null;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Read a zip's entry names + the bytes of the top-level package.json and the
    sidecar requirements.txt (used for the venv-reinstall hash). yauzl streaming
    so a 30 MB bundle never lands fully in memory. */
export function readUpgradeZip(zipPath: string): Promise<ZipReadResult> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const entryNames: string[] = [];
      let packageJsonText: string | null = null;
      let requirementsText: string | null = null;
      let topDir: string | null = null;

      const want = (name: string) => name.endsWith('/package.json') && name.split('/').length === 2
        ? 'pkg'
        : name.endsWith('/server/tts-sidecar/requirements.txt')
          ? 'req'
          : null;

      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        entryNames.push(name);
        if (topDir === null) topDir = name.split('/')[0] || null;
        const which = want(name);
        if (which && !/\/$/.test(name)) {
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return zip.readEntry();
            streamToBuffer(stream)
              .then((buf) => {
                if (which === 'pkg') packageJsonText = buf.toString('utf8');
                else requirementsText = buf.toString('utf8');
              })
              .catch(() => {})
              .finally(() => zip.readEntry());
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => resolve({ entryNames, packageJsonText, requirementsText, topDir }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export interface ValidatedZip extends ManifestResult {
  reqHash: string | null;
}

/** Read + validate a staged zip. Returns the manifest verdict plus a sha256 of
    the sidecar requirements.txt (null when absent) so apply can decide whether a
    pip reinstall into the shared venv is needed. */
export async function validateUpgradeZip(
  zipPath: string,
  runningVersion: string,
  opts: { allowDowngrade?: boolean } = {},
): Promise<ValidatedZip> {
  const read = await readUpgradeZip(zipPath);
  let pkgVersion: string | null = null;
  if (read.packageJsonText) {
    try {
      pkgVersion = (JSON.parse(read.packageJsonText) as { version?: string }).version ?? null;
    } catch {
      pkgVersion = null;
    }
  }
  const manifest = validateUpgradeManifest({
    entryNames: read.entryNames,
    packageJsonVersion: pkgVersion,
    runningVersion,
    allowDowngrade: opts.allowDowngrade,
  });
  const reqHash = read.requirementsText
    ? createHash('sha256').update(read.requirementsText).digest('hex')
    : null;
  return { ...manifest, reqHash };
}
