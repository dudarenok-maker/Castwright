/* fs-18 — ffmpeg/ffprobe presence probe for the admin diagnostics board.
   Both binaries are hard runtime deps: server/src/tts/mp3.ts spawns bare
   `ffmpeg` (MP3/M4A/Opus muxing) and the export path spawns bare `ffprobe`,
   both off PATH with no env override. So a bare-PATH `-version` probe matches
   exactly what those code paths resolve — no false "missing" when a configured
   path would actually work, because there is no configured path.

   ops-35 (#1877) — also reports the ffmpeg VERSION. The audio path does not
   merely invoke ffmpeg, it parses ffmpeg's loudnorm JSON output
   (server/src/tts/loudnorm.ts), which makes the version part of our contract
   rather than an implementation detail.

   The floor is a SUPPORT floor, not a capability floor: below it we simply
   have not tested. That is why every user-facing surface WARNS rather than
   blocks — only scripts/preflight-ffmpeg.cjs hard-fails, and only on boxes we
   control (dev + CI). */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/* server/src/diagnostics/ -> server/src -> server -> repo root. The same depth
   holds from server/dist/diagnostics/ after tsc, so this resolves correctly in
   dev (tsx), in the built server, and in the release zip. Mirrors the REPO_ROOT
   computation in routes/setup-readiness.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface FfmpegProbe {
  ffmpeg: boolean;
  ffprobe: boolean;
  /** Parsed "MAJOR.MINOR", or null when ffmpeg is absent or its banner
   *  carries no semver (git / nightly builds). */
  version: string | null;
  /** True ONLY when ffmpeg is present AND its version parsed AND it is below
   *  the declared floor. Never true on absence or an unparseable banner. */
  belowFloor: boolean;
  /** The declared floor, so callers can render "needs 6.0+". Null when the
   *  check is disabled. */
  minimum: string | null;
}

/** "ffmpeg version 6.1.1-3ubuntu5" -> "6.1"; "n6.1" -> "6.1". Git/nightly
 *  banners ("2026-01-01-git-abc1234", "N-114293-g…") carry no semver and
 *  yield null, which callers MUST treat as acceptable. */
export function parseFfmpegVersion(stdout: string): string | null {
  const m = /^ffmpeg version n?(\d+)\.(\d+)/m.exec(typeof stdout === 'string' ? stdout : '');
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Numeric MAJOR.MINOR compare. Fails OPEN — an unparseable version or an
 *  absent floor is never "below". Rejecting a working install over a regex
 *  miss would cost more than the drift the floor guards against. */
export function isBelowFloor(version: string | null, minimum: string | null): boolean {
  if (!version || !minimum) return false;
  const [vMaj, vMin] = version.split('.').map(Number);
  const [fMaj, fMin] = minimum.split('.').map(Number);
  if (!Number.isFinite(vMaj) || !Number.isFinite(fMaj)) return false;
  if (vMaj !== fMaj) return vMaj < fMaj;
  return (vMin || 0) < (fMin || 0);
}

/** Reads `castwright.ffmpeg.minimum` from root package.json — the same key
 *  scripts/preflight-ffmpeg.cjs and pinokio-scripts/lib/ffmpeg-pin.test.js
 *  read. Any failure yields null, which disables the check rather than
 *  breaking the server. */
export function readFfmpegFloor(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      castwright?: { ffmpeg?: { minimum?: unknown } };
    };
    const min = pkg.castwright?.ffmpeg?.minimum;
    return typeof min === 'string' && min ? min : null;
  } catch {
    return null;
  }
}

/* `spawnSync(bin, ['-version']).status === 0` is the same detection pattern
   already used in server/src/export/build-m4b.test.ts and the libfdk_aac probe
   in mp3.ts. status is null (not 0) when the binary isn't on PATH (ENOENT), so
   the strict `=== 0` correctly reports absence. We now capture stdout too —
   the version lives in the banner's first line. */
function present(bin: string): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, stdout: r.stdout || '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/* DELIBERATELY NOT CACHED. The Setup Wizard's "Re-check" button and the
   diagnostics board's 30 s refresh both exist so a user can install or upgrade
   ffmpeg and see the result WITHOUT restarting the server. A process-lifetime
   cache would freeze the first answer forever — install ffmpeg, click
   Re-check, still be told it is missing. Capturing stdout costs nothing extra
   on a process we already spawn, so there is no saving to trade for that. */
export function probeFfmpeg(): FfmpegProbe {
  const ff = present('ffmpeg');
  const fp = present('ffprobe');
  const minimum = readFfmpegFloor();
  const version = ff.ok ? parseFfmpegVersion(ff.stdout) : null;
  return {
    ffmpeg: ff.ok,
    ffprobe: fp.ok,
    version,
    belowFloor: ff.ok && isBelowFloor(version, minimum),
    minimum,
  };
}

/** First line of `ffmpeg -version` — the full banner including build and
 *  compiler, e.g. "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright …".
 *
 *  `FfmpegProbe.version` deliberately carries only MAJOR.MINOR, which is the
 *  right granularity for a floor check but NOT for deciding whether two
 *  installs will produce byte-identical output: two 8.1 builds can ship
 *  different LAME. The golden-assembly tier (ops-36) gates its exact MP3
 *  comparison on this string.
 *
 *  Spawns afresh — `probeFfmpeg` is deliberately uncached (see the block
 *  comment above it), so there is no captured stdout to reuse. Null when
 *  ffmpeg is absent or produced no output. */
export function ffmpegBannerLine(): string | null {
  const ff = present('ffmpeg');
  if (!ff.ok) return null;
  const first = ff.stdout.split(/\r?\n/, 1)[0]?.trim();
  return first ? first : null;
}
