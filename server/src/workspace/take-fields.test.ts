import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAPTER_AUDIO_EXTS,
  TAKE_SIDECAR_SUFFIXES,
  TAKE_STATE_FIELDS,
  chapterAudioExists,
  deriveTakeFields,
  findChapterAudio,
  findPreviousAudio,
  healTakeFields,
  isTakeId,
  liveAudioFiles,
  liveAudioPath,
  liveTakeParts,
  livePartPath,
  mintTakeId,
  previousAudioPath,
  previousPartPath,
  type TakeSidecarPart,
} from './take-fields.js';
import { formatDuration } from '../audio/format-duration.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'take-fields-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const touch = (name: string) => writeFileSync(join(root, name), 'x');

describe('T1 TAKE_STATE_FIELDS', () => {
  it('is exactly the six members, in order (mutation: add/remove/reorder a member)', () => {
    expect([...TAKE_STATE_FIELDS]).toEqual([
      'duration',
      'audioModelKey',
      'audioEngines',
      'audioRenderedAt',
      'audioQa',
      'audioTakeId',
    ]);
  });
});

describe('T2 take ids', () => {
  it('mints 1000 distinct ids of 16 base32 chars (mutation: non-random or wrong alphabet)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = mintTakeId();
      expect(id).toMatch(/^[a-z2-7]{16}$/);
      expect(isTakeId(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });

  it('isTakeId rejects empty, uppercase, 15- and 17-char ids (mutation: loosen the regex)', () => {
    expect(isTakeId('')).toBe(false);
    expect(isTakeId('ABC')).toBe(false);
    expect(isTakeId('a'.repeat(15))).toBe(false);
    expect(isTakeId('a'.repeat(17))).toBe(false);
    expect(isTakeId('a'.repeat(16))).toBe(true);
    expect(isTakeId('a1' + 'a'.repeat(14))).toBe(false);
    expect(isTakeId(undefined)).toBe(false);
  });
});

describe('T3 path builders equal the join they replace, with no sanitising', () => {
  for (const slug of ['ch-01-intro', 'a..b/../c']) {
    it(`slug ${JSON.stringify(slug)} (mutation: sanitise or change a suffix)`, () => {
      for (const ext of CHAPTER_AUDIO_EXTS) {
        expect(liveAudioPath(root, slug, ext)).toBe(join(root, `${slug}.${ext}`));
        expect(previousAudioPath(root, slug, ext)).toBe(join(root, `${slug}.previous.${ext}`));
      }
      for (const part of Object.keys(TAKE_SIDECAR_SUFFIXES) as TakeSidecarPart[]) {
        const suffix = TAKE_SIDECAR_SUFFIXES[part];
        expect(livePartPath(root, slug, part)).toBe(join(root, `${slug}.${suffix}`));
        expect(previousPartPath(root, slug, part)).toBe(join(root, `${slug}.previous.${suffix}`));
      }
    });
  }

  it('the suffix table is the six sidecar names', () => {
    expect(TAKE_SIDECAR_SUFFIXES).toEqual({
      segments: 'segments.json',
      peaks: 'peaks.json',
      lufs: 'lufs.json',
      embeddings: 'embeddings.json',
      verdicts: 'render-integrity.json',
      attempted: 'render-integrity-attempted.json',
    });
  });
});

describe('T4 findChapterAudio / chapterAudioExists', () => {
  it('mp3 wins over m4a (mutation: reorder the probe)', () => {
    touch('s.mp3');
    touch('s.m4a');
    const f = findChapterAudio(root, 's');
    expect(f?.ext).toBe('mp3');
    expect(f?.mime).toBe('audio/mpeg');
    expect(f?.urlSuffix).toBe('audio.mp3');
    expect(f?.path).toBe(join(root, 's.mp3'));
  });

  it('m4a alone', () => {
    touch('s.m4a');
    expect(findChapterAudio(root, 's')).toMatchObject({ ext: 'm4a', mime: 'audio/mp4' });
    expect(chapterAudioExists(root, 's')).toBe(true);
  });

  it('ogg alone', () => {
    touch('s.ogg');
    expect(findChapterAudio(root, 's')).toMatchObject({ ext: 'ogg', mime: 'audio/ogg' });
  });

  it('none', () => {
    expect(findChapterAudio(root, 's')).toBeNull();
    expect(chapterAudioExists(root, 's')).toBe(false);
  });

  it('a ../x slug resolves inside the root (mutation: drop sanitizeIdSegment)', () => {
    touch('x.mp3');
    // `../x` must not reach a file outside the root; it sanitises to a name inside it.
    const f = findChapterAudio(root, '../x');
    expect(f).toBeNull();
    writeFileSync(join(dirname(root), 'take-fields-escape.mp3'), 'x');
    try {
      expect(findChapterAudio(root, '../take-fields-escape')).toBeNull();
    } finally {
      rmSync(join(dirname(root), 'take-fields-escape.mp3'), { force: true });
    }
  });

  it('.previous.mp3, .next-abc.mp3 and .mp3.tmp-1-2 alone are NOT live (mutation: widen the probe)', () => {
    touch('s.previous.mp3');
    touch('s.next-abc.mp3');
    touch('s.mp3.tmp-1-2');
    expect(chapterAudioExists(root, 's')).toBe(false);
    expect(findChapterAudio(root, 's')).toBeNull();
    expect(liveAudioFiles(root, 's')).toEqual([]);
  });
});

describe('T5 liveAudioFiles reports every hit', () => {
  it('mp3 + m4a: two entries (mp3 first) while findChapterAudio returns the mp3 (mutation: return after first hit)', () => {
    touch('s.mp3');
    touch('s.m4a');
    const all = liveAudioFiles(root, 's');
    expect(all.map((f) => f.ext)).toEqual(['mp3', 'm4a']);
    expect(findChapterAudio(root, 's')?.ext).toBe('mp3');
  });
});

describe('T6 case-insensitive filesystems', () => {
  it('agrees across the three probes whatever the filesystem does', () => {
    writeFileSync(join(root, 'probe.txt'), 'x');
    const caseInsensitive = existsSync(join(root, 'PROBE.TXT'));
    touch('s.MP3');
    const expected = caseInsensitive;
    expect(chapterAudioExists(root, 's')).toBe(expected);
    expect(findChapterAudio(root, 's') !== null).toBe(expected);
    expect(liveAudioFiles(root, 's').length > 0).toBe(expected);
  });
});

describe('T7 findPreviousAudio', () => {
  for (const [ext, mime] of [
    ['mp3', 'audio/mpeg'],
    ['m4a', 'audio/mp4'],
    ['ogg', 'audio/ogg'],
  ] as const) {
    it(`finds .previous.${ext} (mutation: wrong ext/mime/urlSuffix)`, () => {
      touch(`s.previous.${ext}`);
      expect(findPreviousAudio(root, 's')).toEqual({
        path: join(root, `s.previous.${ext}`),
        ext,
        mime,
        urlSuffix: `audio/previous.${ext}`,
      });
    });
  }

  it('prefers mp3 when two exist', () => {
    touch('s.previous.ogg');
    touch('s.previous.mp3');
    expect(findPreviousAudio(root, 's')?.ext).toBe('mp3');
  });

  it('is null when only a live take exists', () => {
    touch('s.mp3');
    expect(findPreviousAudio(root, 's')).toBeNull();
  });
});

describe('T8 deriveTakeFields', () => {
  it('derives the effective model key and the breakdown, not the raw modelKey (mutation: use raw modelKey)', () => {
    const d = deriveTakeFields({
      durationSec: 10,
      modelKey: 'kokoro-v1',
      characterSnapshots: {
        a: { voiceEngine: 'qwen' },
        b: { voiceEngine: 'qwen' },
      },
    });
    expect(d.audioEngines).toEqual({ qwen: 2 });
    expect(d.audioModelKey).not.toBe('kokoro-v1');
  });

  it('a mixed-engine snapshot set keeps the request key and carries the breakdown', () => {
    const d = deriveTakeFields({
      modelKey: 'kokoro-v1',
      characterSnapshots: {
        a: { voiceEngine: 'qwen' },
        b: { voiceEngine: 'kokoro' },
      },
    });
    expect(d.audioModelKey).toBe('kokoro-v1');
    expect(d.audioEngines).toEqual({ qwen: 1, kokoro: 1 });
  });

  it('formats the duration like formatDuration', () => {
    expect(deriveTakeFields({ durationSec: 75 }).duration).toBe('01:15');
    expect(deriveTakeFields({ durationSec: 75 }).duration).toBe(formatDuration(75));
  });

  it('maps synthesizedAt, qa and takeId across', () => {
    const qa = {
      status: 'ok' as const,
      reasons: [],
      measuredLufs: -19,
      truePeakDb: -2,
      durationSec: 5,
      expectedSec: 5,
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
    const d = deriveTakeFields({
      synthesizedAt: '2026-01-01T00:00:00.000Z',
      qa,
      takeId: 'abcdefghijklmnop',
    });
    expect(d.audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(d.audioQa).toEqual(qa);
    expect(d.audioTakeId).toBe('abcdefghijklmnop');
  });

  it('an empty input gives {}', () => {
    expect(deriveTakeFields({})).toEqual({});
  });
});

describe('T9 healTakeFields', () => {
  const derived = {
    duration: '01:15',
    audioModelKey: 'kokoro-v1',
    audioEngines: { kokoro: 1 },
    audioRenderedAt: '2026-01-01T00:00:00.000Z',
    audioTakeId: 'abcdefghijklmnop',
  };
  const none = new Set<string>();

  it('fills an undefined member and a 00:00 duration', () => {
    const out = healTakeFields({ slug: 's', duration: '00:00' }, derived, none);
    expect(out.duration).toBe('01:15');
    expect(out.audioModelKey).toBe('kokoro-v1');
    expect(out.audioEngines).toEqual({ kokoro: 1 });
    expect(out.audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never overwrites a present member (mutation: overwrite duration)', () => {
    const out = healTakeFields(
      { slug: 's', duration: '09:09', audioModelKey: 'mine' },
      derived,
      none,
    );
    expect(out.duration).toBe('09:09');
    expect(out.audioModelKey).toBe('mine');
  });

  it('never fills audioTakeId, even when derived has one (mutation: fill audioTakeId)', () => {
    const out = healTakeFields({ slug: 's' }, derived, none);
    expect(out.audioTakeId).toBeUndefined();
    expect('audioTakeId' in out).toBe(false);
  });

  it('a slug in journalNamedSlugs gets nothing', () => {
    const out = healTakeFields({ slug: 's' }, derived, new Set(['s']));
    expect(out).toEqual({ slug: 's' });
  });

  it('returns a new object and does not mutate fresh', () => {
    const fresh = { slug: 's', duration: '00:00' };
    const out = healTakeFields(fresh, derived, none);
    expect(out).not.toBe(fresh);
    expect(fresh).toEqual({ slug: 's', duration: '00:00' });
  });
});

describe('leaf closure (R10-2)', () => {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const ALLOWED = new Set([
    'workspace/take-fields.ts',
    'util/safe-path.ts',
    'audio/format-duration.ts',
    'audio/engine-breakdown.ts',
    'tts/model-keys.ts',
  ]);

  const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

  function specifiers(file: string): string[] {
    const text = readFileSync(file, 'utf8');
    const out: string[] = [];
    for (const m of text.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2]);
    return out;
  }

  function closure(entry: string): { files: Set<string>; builtins: string[]; bare: string[] } {
    const files = new Set<string>();
    const builtins: string[] = [];
    const bare: string[] = [];
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop() as string;
      const rel = relative(srcRoot, file).replace(/\\/g, '/');
      if (files.has(rel)) continue;
      files.add(rel);
      for (const spec of specifiers(file)) {
        if (spec.startsWith('node:')) builtins.push(spec);
        else if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
          queue.push(target);
        } else bare.push(spec);
      }
    }
    return { files, builtins, bare };
  }

  it('take-fields.ts reaches only node: builtins and the three allowed files (mutation: import scan.ts)', () => {
    const { files, bare } = closure(join(srcRoot, 'workspace', 'take-fields.ts'));
    const extra = [...files].filter((f) => !ALLOWED.has(f));
    expect(extra).toEqual([]);
    expect(bare).toEqual([]);
    expect(files.has('workspace/take-fields.ts')).toBe(true);
  });
});

describe('T9 liveTakeParts (#4330, F15)', () => {
  it('returns audio then sidecars in suffix-table order, names from the table', () => {
    touch('s.mp3');
    touch('s.peaks.json');
    touch('s.segments.json');
    touch('s.lufs.json');
    const parts = liveTakeParts(root, 's');
    expect(parts.map((p) => [p.part, p.name])).toEqual([
      ['audio', 's.mp3'],
      ['segments', 's.segments.json'],
      ['peaks', 's.peaks.json'],
      ['lufs', 's.lufs.json'],
    ]);
    expect(parts[0].path).toBe(join(root, 's.mp3'));
  });

  it('never lists staged, previous, journal, tmp or orphaned files (mutation: list by prefix)', () => {
    touch('s.mp3');
    touch('s.segments.json');
    touch('s.next-abc.mp3');
    touch('s.next-abc.segments.json');
    touch('s.discard-j1.prev.mp3');
    touch('s.previous.mp3');
    touch('s.previous.segments.json');
    touch('s.take-journal.json');
    touch('s.mp3.tmp-1-2');
    expect(liveTakeParts(root, 's').map((p) => p.name)).toEqual(['s.mp3', 's.segments.json']);
  });

  it('reports only the first live audio when two extensions exist, and nothing for an absent take', () => {
    touch('s.mp3');
    touch('s.m4a');
    expect(liveTakeParts(root, 's').map((p) => p.name)).toEqual(['s.mp3']);
    expect(liveTakeParts(root, 'missing')).toEqual([]);
  });
});
