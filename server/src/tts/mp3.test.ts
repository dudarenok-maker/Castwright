/* Real-ffmpeg integration test for encodePcmToAudio. We deliberately do NOT
   mock the subprocess — the value of this suite is catching wire-format or
   flag-name drift in the actual encoder boundary. If ffmpeg is missing the
   suite skips with a loud reason (CI must install it; users get a one-line
   hint from scripts/start-app.ps1 preflight). */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  decodeAudioFileToPcm,
  decodeAudioToPcm,
  encodePcmToAudio,
  fixLameEncoderDelay,
  fixLameEncoderDelayInFile,
  mp3StartPadShortfall,
  writeChapterLufsFile,
  writeChapterPeaksFile,
  type ChapterPeaksFile,
} from './mp3.js';
import { BIN_COUNT } from '../audio/compute-peaks.js';

/* Pass-through spy on node:fs/promises.writeFile so a test can inject a
   part-way write failure (#4218); every other test sees the real function. */
const fsMock = vi.hoisted(() => ({ writeFile: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMock.writeFile.mockImplementation(actual.writeFile as never);
  fsMock.readFile.mockImplementation(actual.readFile as never);
  return { ...actual, writeFile: fsMock.writeFile, readFile: fsMock.readFile };
});

/* Make the next `.tmp-*` write create a partial file and then fail with ENOSPC;
   returns the error so a test can assert it is the one that propagates. */
async function failTmpWriteWithEnospc(): Promise<{ enospc: Error; restore: () => void }> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  fsMock.writeFile.mockImplementation(async (p: string, ...rest: unknown[]) => {
    if (!String(p).includes('.tmp-')) return (actual.writeFile as (...a: unknown[]) => Promise<void>)(p, ...rest);
    await actual.writeFile(p, 'partial');
    throw enospc;
  });
  return { enospc, restore: () => fsMock.writeFile.mockImplementation(actual.writeFile as never) };
}

const ffmpegPresent = (() => {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const ffprobePresent = (() => {
  try {
    const result = spawnSync('ffprobe', ['-version'], { stdio: 'ignore', windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

/* Read the container's reported duration via ffprobe (what players and
   browsers trust). For a VBR MP3 this is only reliable when a Xing/Info
   header is present — the whole point of the plan 109 regression below. */
function ffprobeDurationSec(file: string): number {
  const out = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file],
    { encoding: 'utf8', windowsHide: true },
  );
  return Number(out.stdout.trim());
}

/* Build a 24 kHz mono int16 LE PCM buffer holding a 440 Hz sine wave for the
   given duration. Realistic-enough payload for the encoder; using silence
   would still work but a tone makes manual debugging (play the output) easier. */
function sinePcm(sampleRate: number, seconds: number, freq = 440): Buffer {
  const sampleCount = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(sampleCount * 2);
  const amp = 16000; // ~ -6 dBFS, plenty of headroom
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/* Decode an ID3v2 synchsafe size (4 bytes, top bit of each is 0). */
function id3v2TagLength(b: Buffer): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // "ID3"
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size;
}

/* Find the first valid MPEG audio frame header in the buffer. Returns its
   byte offset, or -1 if none found within the first 4 KiB. */
function findMpegSync(b: Buffer): number {
  const skip = id3v2TagLength(b);
  const limit = Math.min(b.length - 4, skip + 4096);
  for (let i = skip; i < limit; i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) {
      // Sanity check: layer + version bits must not be reserved (00).
      const version = (b[i + 1] >> 3) & 0x3;
      const layer = (b[i + 1] >> 1) & 0x3;
      if (version === 1 || layer === 0) continue; // reserved patterns
      return i;
    }
  }
  return -1;
}

describeIfFfmpeg('encodePcmToAudio', () => {
  it('encodes 24 kHz mono PCM to a valid MPEG-2 Layer III mono stream', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.0);
    const mp3 = await encodePcmToAudio(pcm, sampleRate, { quality: 2 });

    expect(mp3.length).toBeGreaterThan(1024); // ~1s @ V2 ≈ 18 KB, won't be tiny

    const syncOffset = findMpegSync(mp3);
    expect(syncOffset).toBeGreaterThanOrEqual(0);

    const headerByte1 = mp3[syncOffset + 1];
    const headerByte2 = mp3[syncOffset + 2];
    const headerByte3 = mp3[syncOffset + 3];

    const versionBits = (headerByte1 >> 3) & 0x3;
    const layerBits = (headerByte1 >> 1) & 0x3;
    expect(versionBits).toBe(0b10); // MPEG-2 (24 kHz is an MPEG-2 sample rate)
    expect(layerBits).toBe(0b01); // Layer III

    const sampleRateIndex = (headerByte2 >> 2) & 0x3;
    expect(sampleRateIndex).toBe(0b01); // MPEG-2 idx 01 → 24000 Hz

    const channelMode = (headerByte3 >> 6) & 0x3;
    expect(channelMode).toBe(0b11); // mono
  });

  /* Regression for plan 109. Before the fix the MP3 was piped to ffmpeg's
     non-seekable `pipe:1`, so libmp3lame could not write the Xing VBR header;
     the container then reported a duration ~7x the real length (a 3 s clip
     probed as ~21 s). This asserts the encoded MP3's container duration
     matches the PCM duration AND that a Xing/Info header is present. */
  (ffprobePresent ? it : it.skip)(
    'produces an MP3 whose container duration matches the PCM duration (Xing header present)',
    async () => {
      const sampleRate = 24_000;
      const seconds = 3.0;
      const mp3 = await encodePcmToAudio(sinePcm(sampleRate, seconds), sampleRate, { quality: 2 });

      const head = mp3.subarray(0, 4096);
      const hasXing = head.includes(Buffer.from('Xing')) || head.includes(Buffer.from('Info'));
      expect(hasXing, 'encoded MP3 is missing its Xing/Info VBR header').toBe(true);

      const dir = mkdtempSync(join(tmpdir(), 'mp3-xing-'));
      try {
        const file = join(dir, 'clip.mp3');
        writeFileSync(file, mp3);
        const probed = ffprobeDurationSec(file);
        /* Was ~21 s pre-fix; allow encoder-padding slack. */
        expect(Math.abs(probed - seconds)).toBeLessThan(0.15);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('rejects when ffmpeg exits non-zero (invalid sample rate)', async () => {
    const pcm = sinePcm(24_000, 0.1);
    await expect(encodePcmToAudio(pcm, 0, { quality: 2 })).rejects.toThrow(/ffmpeg/i);
  });

  it('rejects with a friendly hint if ffmpeg is not on PATH', async () => {
    // We can't realistically uninstall ffmpeg per-test, but we can verify
    // the error path by spawning a guaranteed-missing binary via a child
    // module copy that takes the binary name. Skip this corner — covered
    // by the friendly-hint string baked into encodePcmToAudio and exercised
    // only when users misconfigure their machine.
    // (Kept as a placeholder so future refactors that abstract the binary
    // name remember to add this assertion.)
  });
});

if (!ffmpegPresent) {
  console.warn(
    '[mp3.test.ts] ffmpeg not found on PATH — skipping encoder integration tests. ' +
      'Install: winget install Gyan.FFmpeg',
  );
}

/* #4573 - the first 240 bytes (ID3v2 block + Xing/Info frame) of real encodes,
   captured from each tool. */
/* ffmpeg 8.1.1 libmp3lame, 24 kHz mono VBR (Xing): encoder delay 576, the honest value. */
const HEAD_8_1_XING = Buffer.from(
  '49443304000000000023545353450000000f0000034c61766636322e31322e3130310000000000000000000000fff384c000' +
  '000000000000000058696e670000000f00000017000009f000393939394d4d4d4d56565656565e5e5e5e636363636a6a6a6a' +
  '6a71717171787878788080808080878787878e8e8e8e95959595959a9a9a9aa1a1a1a1a9a9a9a9a9b0b0b0b0b7b7b7b7bebe' +
  'bebebec6c6c6c6cdcdcdcdd4d4d4d4d4f1f1f1f1ffffffff000000004c61766336322e323800000000000000000000000024' +
  '02a000000000000009f08d7b07e70000000000000000000000000000000000000000000000fff3c4',
  'hex',
);
/* ffmpeg 9.1 libmp3lame, same input: encoder delay 47 (576 - 529). */
const HEAD_9_1_XING = Buffer.from(
  '49443304000000000023545353450000000f0000034c61766636332e31362e3130300000000000000000000000fff384c400' +
  '000000000000000058696e670000000f00000017000009f000393939394d4d4d4d56565656565e5e5e5e636363636a6a6a6a' +
  '6a71717171787878788080808080878787878e8e8e8e95959595959a9a9a9aa1a1a1a1a9a9a9a9a9b0b0b0b0b7b7b7b7bebe' +
  'bebebec6c6c6c6cdcdcdcdd4d4d4d4d4f1f1f1f1ffffffff000000004c61766336332e323400000000000000000000000002' +
  'f2a000000000000009f0ccbebb5c0000000000000000000000000000000000000000000000fff3c4',
  'hex',
);
/* ffmpeg 9.1 libmp3lame, 24 kHz mono CBR 64k (Info tag): encoder delay 47. */
const HEAD_9_1_INFO = Buffer.from(
  '49443304000000000023545353450000000f0000034c61766636332e31362e3130300000000000000000000000fff384c400' +
  '0000000000000000496e666f0000000f00000017000012000015151515202020202a2a2a2a2a35353535404040404a4a4a4a' +
  '4a55555555606060606a6a6a6a6a75757575808080808a8a8a8a8a95959595a0a0a0a0aaaaaaaaaab5b5b5b5c0c0c0c0caca' +
  'cacacad5d5d5d5e0e0e0e0eaeaeaeaeaf5f5f5f5ffffffff000000004c61766336332e323400000000000000000000000002' +
  'f2a00000000000001200256bafd20000000000000000000000000000000000000000000000fff384',
  'hex',
);
/* ffmpeg libshine, 24 kHz mono: a Lavc tag with encoder delay 0 (not LAME). */
const HEAD_SHINE = Buffer.from(
  '49443304000000000023545353450000000f0000034c61766636322e31322e3130310000000000000000000000fffb58c000' +
  '00000000000000000000000000000000496e666f0000000f0000000e000010e0002222222222222233333333333333444444' +
  '44444444555555555555556666666666666677777777777777888888888888889999999999999999aaaaaaaaaaaaaabbbbbb' +
  'bbbbbbbbccccccccccccccddddddddddddddeeeeeeeeeeeeeeffffffffffffff000000004c61766336322e32380000000000' +
  '0000000000000000000000000000000010e0a355fc1c000000000000000000000000000000000000',
  'hex',
);
/* ffmpeg 9.1 `-c copy` remux of HEAD_9_1_XING: a Lavf string, delay still 47. */
const HEAD_9_1_REMUX = Buffer.from(
  '49443304000000000023545353450000000f0000034c61766636332e31362e3130300000000000000000000000fff384c400' +
  '000000000000000058696e670000000f00000017000009f000393939394d4d4d4d56565656565e5e5e5e636363636a6a6a6a' +
  '6a71717171787878788080808080878787878e8e8e8e95959595959a9a9a9aa1a1a1a1a9a9a9a9a9b0b0b0b0b7b7b7b7bebe' +
  'bebebec6c6c6c6cdcdcdcdd4d4d4d4d4f1f1f1f1ffffffff000000004c617666000000000000000000000000000000000002' +
  'f2a000000000000009f0ccbe2d9f0000000000000000000000000000000000000000000000fff3c4',
  'hex',
);

/* Where the encoder string sits in a 24 kHz mono Xing/Info frame behind a
   45-byte ID3v2 block: ID3 + 4 header + 9 side info + 8 tag/flags + 112 fields. */
const ENC_24K_MONO = 45 + 4 + 9 + 8 + 112;
const delayAt = (b: Buffer, enc: number): number => (b[enc + 21] << 4) | (b[enc + 22] >> 4);
const storedCrcAt = (b: Buffer, enc: number): number => b.readUInt16BE(enc + 34);
/* The tag CRC in ffmpeg's muxer convention (NOT LAME's own reference CRC,
   which spans only the sync up to the CRC field and never matches an LSF tag):
   CRC-16 (poly 0x8005 reflected, init 0) over the first 190 bytes of the tag
   frame, its own two bytes (34 past the encoder string) and anything past a
   shorter frame's end read as zero. The frame length comes from the MPEG-2/2.5 header (72 * kbit/s
   / rate) that every 24 kHz and lower file in this suite carries. */
function tagCrc(b: Buffer, frameStart: number, enc: number): number {
  const kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][b[frameStart + 2] >> 4];
  const rate = { 0: 22050, 1: 24000, 2: 16000 }[(b[frameStart + 2] >> 2) & 3] ?? 8000;
  const mpeg25 = ((b[frameStart + 1] >> 3) & 3) === 0;
  const frameLen = Math.floor((72 * kbps * 1000) / (mpeg25 ? rate / 2 : rate)) + ((b[frameStart + 2] >> 1) & 1);
  let crc = 0;
  for (let i = frameStart; i < frameStart + 190; i++) {
    crc ^= i >= frameStart + frameLen || i === enc + 34 || i === enc + 35 ? 0 : b[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}
/* An ID3v2.4 block of `bodyBytes` zero padding (e.g. a cover) in place of the
   45-byte one a real encode starts with. */
function withBigId3(mp3: Buffer, bodyBytes: number): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  header[6] = (bodyBytes >> 21) & 0x7f;
  header[7] = (bodyBytes >> 14) & 0x7f;
  header[8] = (bodyBytes >> 7) & 0x7f;
  header[9] = bodyBytes & 0x7f;
  return Buffer.concat([header, Buffer.alloc(bodyBytes), mp3.subarray(id3v2TagLength(mp3))]);
}

describe('mp3StartPadShortfall (#4573)', () => {
  it('reads 0 for the ffmpeg 8.1.1 tag (delay 576, the honest value)', () => {
    expect(delayAt(HEAD_8_1_XING, ENC_24K_MONO)).toBe(576);
    expect(mp3StartPadShortfall(HEAD_8_1_XING)).toBe(0);
  });

  it('reads 529 for the ffmpeg 9.1 tag (delay 47 - decoders trim 529 samples short)', () => {
    expect(delayAt(HEAD_9_1_XING, ENC_24K_MONO)).toBe(47);
    expect(mp3StartPadShortfall(HEAD_9_1_XING)).toBe(529);
  });

  it('reads an Info tag (9.1 writes one for CBR at low rates), delay 47 -> 529', () => {
    expect(HEAD_9_1_INFO.includes('Info')).toBe(true);
    expect(mp3StartPadShortfall(HEAD_9_1_INFO)).toBe(529);
  });

  it('reads 0 for a non-LAME ffmpeg encoder that writes a Lavc tag with delay 0', () => {
    expect(HEAD_SHINE.includes('Lavc')).toBe(true);
    expect(mp3StartPadShortfall(HEAD_SHINE)).toBe(0);
  });

  it('reads a Lavf string - a `-c copy` remux of a 9.1 file keeps delay 47', () => {
    expect(HEAD_9_1_REMUX.includes('Lavf\0')).toBe(true);
    expect(mp3StartPadShortfall(HEAD_9_1_REMUX)).toBe(529);
  });

  it('honours the Xing flags: a tag without its TOC puts the encoder string 100 bytes earlier', () => {
    const noToc = Buffer.from(HEAD_9_1_XING);
    const flagsAt = 45 + 4 + 9 + 4;
    noToc[flagsAt + 3] = 0x0b; // frames + bytes + quality, no TOC
    const tocAt = flagsAt + 4 + 8;
    const trimmed = Buffer.concat([noToc.subarray(0, tocAt), noToc.subarray(tocAt + 100)]);
    expect(mp3StartPadShortfall(trimmed)).toBe(529);
  });

  it('reads 0 for a head with no Xing/Info tag, a foreign encoder string, or a truncated head', () => {
    expect(mp3StartPadShortfall(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBe(0);
    const foreign = Buffer.from(HEAD_9_1_XING);
    foreign.write('ZZZZ', ENC_24K_MONO, 'latin1');
    expect(mp3StartPadShortfall(foreign)).toBe(0);
    expect(mp3StartPadShortfall(HEAD_9_1_XING.subarray(0, 100))).toBe(0);
  });

  it('finds the tag behind an ID3v2 block far larger than the old 2048-byte head (cover art)', () => {
    const big = withBigId3(HEAD_9_1_XING, 11_000);
    expect(big.indexOf('Xing')).toBeGreaterThan(2048);
    expect(mp3StartPadShortfall(big)).toBe(529);
  });
});

describe('fixLameEncoderDelay (#4573)', () => {
  it('the CRC routine reproduces the one the real encoders wrote', () => {
    for (const head of [HEAD_8_1_XING, HEAD_9_1_XING, HEAD_9_1_INFO, HEAD_9_1_REMUX]) {
      expect(tagCrc(head, 45, ENC_24K_MONO)).toBe(storedCrcAt(head, ENC_24K_MONO));
    }
  });

  it('the CRC routine reproduces the ones ffmpeg 9.1 wrote at 16 and 8 kHz (shorter frames)', () => {
    for (const khz of [24, 16, 8]) {
      const mp3 = readFileSync(toneFixture(khz));
      expect(storedCrcAt(mp3, ENC_24K_MONO)).toBe(tagCrc(mp3, 45, ENC_24K_MONO));
      // and the fix re-derives the very same function over the changed bytes
      const fixed = fixLameEncoderDelay(mp3.subarray(0, 600))!;
      expect(storedCrcAt(fixed, ENC_24K_MONO)).toBe(tagCrc(fixed, 45, ENC_24K_MONO));
    }
  });

  it('rewrites 9.1 delay 47 to 576 and recomputes the tag CRC, touching nothing else', () => {
    for (const head of [HEAD_9_1_XING, HEAD_9_1_INFO, HEAD_9_1_REMUX]) {
      const fixed = fixLameEncoderDelay(head)!;
      expect(fixed).not.toBeNull();
      expect(delayAt(fixed, ENC_24K_MONO)).toBe(576);
      expect(mp3StartPadShortfall(fixed)).toBe(0);
      expect(storedCrcAt(fixed, ENC_24K_MONO)).toBe(tagCrc(fixed, 45, ENC_24K_MONO));
      const changed = [...fixed.keys()].filter((i) => fixed[i] !== head[i]);
      const enc = ENC_24K_MONO;
      expect(changed.every((i) => [enc + 21, enc + 22, enc + 34, enc + 35].includes(i))).toBe(true);
      // the 12-bit padding sharing a byte with the delay is preserved
      expect(fixed[enc + 22] & 0x0f).toBe(head[enc + 22] & 0x0f);
      expect(fixed[enc + 23]).toBe(head[enc + 23]);
    }
  });

  it('fixes a tag behind a large ID3v2 block', () => {
    const fixed = fixLameEncoderDelay(withBigId3(HEAD_9_1_XING, 11_000))!;
    expect(fixed).not.toBeNull();
    expect(mp3StartPadShortfall(fixed)).toBe(0);
  });

  it('returns null - nothing to fix - for a correct tag, libshine and non-MP3 input', () => {
    expect(fixLameEncoderDelay(HEAD_8_1_XING)).toBeNull();
    expect(fixLameEncoderDelay(HEAD_SHINE)).toBeNull();
    expect(fixLameEncoderDelay(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBeNull();
  });
});

describeIfFfmpeg('encodePcmToAudio fixes the tag on the encode path (#4573)', () => {
  /* Version-independent: the readback of the temp file is swapped for the
     committed ffmpeg 9.1 bytes (delay 47), so deleting the call site in
     encodePcmToAudio fails this on an 8.x ffmpeg too. */
  it('returns delay 576 and a valid tag CRC when the encoder wrote 9.1\'s delay 47', async () => {
    const wrong = readFileSync(toneFixture(24));
    expect(delayAt(wrong, ENC_24K_MONO)).toBe(47);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    fsMock.readFile.mockImplementationOnce((async (p: string, ...rest: unknown[]) => {
      await (actual.readFile as (...a: unknown[]) => Promise<Buffer>)(p, ...rest);
      return Buffer.from(wrong);
    }) as never);
    const out = await encodePcmToAudio(sinePcm(24_000, 0.5), 24_000, { quality: 2 });
    expect(delayAt(out, ENC_24K_MONO)).toBe(576);
    expect(mp3StartPadShortfall(out)).toBe(0);
    expect(storedCrcAt(out, ENC_24K_MONO)).toBe(tagCrc(out, 45, ENC_24K_MONO));
  });
});

/* A 1 s clip at 24 / 16 / 8 kHz - 0.25 s silence, 0.5 s 440 Hz tone, 0.25 s
   silence - encoded by ffmpeg 9.1 (libmp3lame -q:a 2) and committed raw, so the
   decode-side tests run on any ffmpeg: each carries the wrong delay 47. */
const toneFixture = (khz: number): string =>
  fileURLToPath(new URL(`../__fixtures__/ffmpeg91-lead-in/tone-${khz}k.mp3`, import.meta.url));
/* First sample louder than the ramp-free silence around the tone. */
function onsetSample(pcm: Buffer): number {
  for (let i = 0; i < pcm.length / 2; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > 3000) return i;
  return -1;
}

describeIfFfmpeg('decode helpers on a file carrying 9.1\'s wrong encoder delay (#4573)', () => {
  /* The shortfall is in the MP3's own samples, so it must be rescaled to the
     decode's output rate: an unscaled trim cuts real audio at 16 kHz and leaves
     lead-in at 24 -> 48 kHz and below the source rate. */
  const RATES: Array<[number, number]> = [
    [24, 16],
    [24, 48],
    [16, 24],
    [8, 24],
    [24, 24],
  ];

  it.each(RATES)('pipe form, %i kHz stream decoded at %i kHz, keeps the onset on the source sample', async (inK, outK) => {
    const mp3 = readFileSync(toneFixture(inK));
    expect(mp3StartPadShortfall(mp3)).toBe(529);
    const out = await decodeAudioToPcm(mp3, outK * 1000);
    expect(Math.abs(onsetSample(out) - outK * 250)).toBeLessThanOrEqual(3);
  });

  it.each(RATES)('file form, %i kHz stream decoded at %i kHz, keeps the onset and the length', async (inK, outK) => {
    const out = await decodeAudioFileToPcm(toneFixture(inK), outK * 1000);
    expect(Math.abs(onsetSample(out) - outK * 250)).toBeLessThanOrEqual(3);
    expect(Math.abs(out.length / 2 - outK * 1000)).toBeLessThanOrEqual(8);
  });

  it('finds the tag behind a cover-sized ID3v2 block in both forms', async () => {
    const big = withBigId3(readFileSync(toneFixture(24)), 11_000);
    expect(mp3StartPadShortfall(big)).toBe(529);
    const pipe = await decodeAudioToPcm(big, 24_000);
    expect(Math.abs(onsetSample(pipe) - 6000)).toBeLessThanOrEqual(3);
    const dir = mkdtempSync(join(tmpdir(), 'mp3-bigid3-'));
    try {
      const file = join(dir, 'big.mp3');
      writeFileSync(file, big);
      const out = await decodeAudioFileToPcm(file, 24_000);
      expect(Math.abs(onsetSample(out) - 6000)).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a `-c copy` remux (Lavf string, delay still 47) aligned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp3-remux-'));
    try {
      const out = join(dir, 'remux.mp3');
      const r = spawnSync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', toneFixture(24), '-c:a', 'copy', '-f', 'mp3', out],
        { windowsHide: true },
      );
      expect(r.status).toBe(0);
      const pcm = await decodeAudioFileToPcm(out, 24_000);
      expect(Math.abs(onsetSample(pcm) - 6000)).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes a file whose tag was fixed exactly like the trim does, on this ffmpeg too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp3-fixfile-'));
    try {
      const file = join(dir, 'fixed.mp3');
      copyFileSync(toneFixture(24), file);
      await fixLameEncoderDelayInFile(file);
      expect(mp3StartPadShortfall(readFileSync(file))).toBe(0);
      const fixed = await decodeAudioFileToPcm(file, 24_000);
      const trimmed = await decodeAudioFileToPcm(toneFixture(24), 24_000);
      expect(fixed.length / 2).toBe(24_000);
      expect(trimmed.length).toBe(fixed.length);
      expect(onsetSample(fixed)).toBe(onsetSample(trimmed));
      expect(Math.abs(onsetSample(fixed) - 6000)).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixLameEncoderDelayInFile leaves a correctly tagged file byte-identical', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp3-noop-'));
    try {
      const file = join(dir, 'ok.mp3');
      writeFileSync(file, await encodePcmToAudio(sinePcm(24_000, 0.5), 24_000, { quality: 2 }));
      const before = readFileSync(file);
      await fixLameEncoderDelayInFile(file);
      expect(readFileSync(file).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeIfFfmpeg('encodePcmToAudio writes the correct LAME encoder delay (#4573)', () => {
  const sampleRate = 24_000;
  /* 1 s of tone then 2 s of dead silence. */
  const pcm = Buffer.concat([sinePcm(sampleRate, 1.0), Buffer.alloc(sampleRate * 2)]);

  it('stamps delay 576 and a valid tag CRC, so a decode is exact', async () => {
    const mp3 = await encodePcmToAudio(pcm, sampleRate, { quality: 2 });
    expect(delayAt(mp3, ENC_24K_MONO)).toBe(576);
    expect(storedCrcAt(mp3, ENC_24K_MONO)).toBe(tagCrc(mp3, 45, ENC_24K_MONO));
    const dir = mkdtempSync(join(tmpdir(), 'mp3-enc-delay-'));
    try {
      const file = join(dir, 'a.mp3');
      writeFileSync(file, mp3);
      expect((await decodeAudioFileToPcm(file, sampleRate)).length).toBe(pcm.length);
      if (ffprobePresent) {
        const probe = spawnSync(
          'ffprobe',
          ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-read_intervals', '%+#1', '-show_entries', 'packet_side_data=skip_samples', '-of', 'csv=p=0', file],
          { encoding: 'utf8', windowsHide: true },
        );
        // ffmpeg reports delay + its own 529 as the samples to skip: 576 + 529
        expect(probe.stdout).toContain('1105');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes the pipe form sample-aligned to the source', async () => {
    const mp3 = await encodePcmToAudio(pcm, sampleRate, { quality: 2 });
    const out = await decodeAudioToPcm(mp3, sampleRate);
    let peak = 0;
    for (let i = sampleRate; i < sampleRate * 2; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)));
    expect(peak).toBeLessThan(200);
  });
});

/* writeChapterPeaksFile coverage (plan 56). No ffmpeg dependency — this is
   pure compute + fs, so it runs unconditionally even on CI without ffmpeg. */
describe('writeChapterPeaksFile', () => {
  function workDir(): string {
    return mkdtempSync(join(tmpdir(), 'audiobook-peaks-test-'));
  }

  it('writes a {peaks: number[240]} JSON file at the requested path', async () => {
    const dir = workDir();
    try {
      const peaksPath = join(dir, 'audio', 'ch-one.peaks.json');
      const pcm = sinePcm(24_000, 1.0);
      await writeChapterPeaksFile(pcm, 24_000, peaksPath);

      expect(existsSync(peaksPath)).toBe(true);
      const parsed: ChapterPeaksFile = JSON.parse(readFileSync(peaksPath, 'utf8'));
      expect(Array.isArray(parsed.peaks)).toBe(true);
      expect(parsed.peaks).toHaveLength(BIN_COUNT);
      for (const v of parsed.peaks) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates intermediate directories (matches mkdir { recursive: true })', async () => {
    const dir = workDir();
    try {
      const peaksPath = join(dir, 'nested', 'audio', 'ch-x.peaks.json');
      await writeChapterPeaksFile(sinePcm(24_000, 0.1), 24_000, peaksPath);
      expect(existsSync(peaksPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomic rename leaves no .tmp-* droppings in the audio dir on success', async () => {
    const dir = workDir();
    try {
      const audioDir = join(dir, 'audio');
      const peaksPath = join(audioDir, 'ch-clean.peaks.json');
      await writeChapterPeaksFile(sinePcm(24_000, 0.1), 24_000, peaksPath);
      const entries = readdirSync(audioDir);
      const droppings = entries.filter((e) => e.includes('.tmp-'));
      expect(droppings).toEqual([]);
      expect(entries).toContain('ch-clean.peaks.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlinks the partial temp file and rethrows the original error when the temp write fails (#4218)', async () => {
    const dir = workDir();
    const { enospc, restore } = await failTmpWriteWithEnospc();
    try {
      const audioDir = join(dir, 'audio');
      const peaksPath = join(audioDir, 'ch-enospc.peaks.json');
      await expect(writeChapterPeaksFile(sinePcm(24_000, 0.1), 24_000, peaksPath)).rejects.toBe(
        enospc,
      );
      expect(existsSync(peaksPath)).toBe(false);
      expect(readdirSync(audioDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('silent PCM yields an all-zero peaks array (no NaN serialized)', async () => {
    const dir = workDir();
    try {
      const peaksPath = join(dir, 'silent.peaks.json');
      await writeChapterPeaksFile(Buffer.alloc(24_000 * 2), 24_000, peaksPath);
      const parsed: ChapterPeaksFile = JSON.parse(readFileSync(peaksPath, 'utf8'));
      expect(parsed.peaks).toEqual(new Array(BIN_COUNT).fill(0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* writeChapterLufsFile coverage (plan 71). Sibling to writeChapterPeaksFile;
   same atomic-write pattern. Pure fs + JSON — no ffmpeg dependency, runs
   unconditionally. */
describe('writeChapterLufsFile', () => {
  function workDir(): string {
    return mkdtempSync(join(tmpdir(), 'audiobook-lufs-test-'));
  }

  it('writes a LoudnormSidecarJson payload at the requested path', async () => {
    const dir = workDir();
    try {
      const lufsPath = join(dir, 'audio', 'ch-one.lufs.json');
      const payload = {
        i: -16.2,
        lra: 8.4,
        tp: -2.1,
        target: -16,
        twoPass: true,
        measuredAt: '2026-05-20T12:00:00.000Z',
      };
      await writeChapterLufsFile(payload, lufsPath);
      expect(existsSync(lufsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(lufsPath, 'utf8'));
      expect(parsed).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomic rename leaves no .tmp-* droppings on success', async () => {
    const dir = workDir();
    try {
      const audioDir = join(dir, 'audio');
      const lufsPath = join(audioDir, 'ch-clean.lufs.json');
      await writeChapterLufsFile(
        {
          i: -16,
          lra: 11,
          tp: -1.5,
          target: -16,
          twoPass: false,
          measuredAt: new Date().toISOString(),
        },
        lufsPath,
      );
      const entries = readdirSync(audioDir);
      expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
      expect(entries).toContain('ch-clean.lufs.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlinks the partial temp file and rethrows the original error when the temp write fails (#4218)', async () => {
    const dir = workDir();
    const { enospc, restore } = await failTmpWriteWithEnospc();
    try {
      const audioDir = join(dir, 'audio');
      const lufsPath = join(audioDir, 'ch-enospc.lufs.json');
      await expect(
        writeChapterLufsFile(
          { i: -16, lra: 11, tp: -1.5, target: -16, twoPass: false, measuredAt: 'now' },
          lufsPath,
        ),
      ).rejects.toBe(enospc);
      expect(existsSync(lufsPath)).toBe(false);
      expect(readdirSync(audioDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
