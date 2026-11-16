/* #4233 -- the path scrub in `ffmpegFailure` drops anything from a path root to
   the end of the (last) stderr line, rather than enumerating path syntax. Each
   case is a realistic ffmpeg last line plus a fragment that must not survive. */

import { describe, expect, it } from 'vitest';
import { ffmpegFailure } from './ffmpeg-failure.js';

const longDrive = 'Error opening input file C:\\Users\\bob\\' + 'verylongfolder\\'.repeat(15) + 'ch1.mp3.';
const longPosix = 'Error opening input file /home/bob/' + 'a'.repeat(120) + ' b/ch1.mp3.';

// [label, stderr last line, fragment that must not appear in `message`]
const CASES: Array<[string, string, string]> = [
  ['drive plain', 'C:\\Users\\bob\\AppData\\Local\\Temp\\x.mp3: No such file or directory', 'bob'],
  ['drive space user', 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\x.mp3: No such file or directory', 'Doe'],
  ['drive apostrophe user', "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\x.mp3: No such file or directory", 'Brien'],
  ['drive apostrophe quoted', "Output #0, mp3, to 'C:\\Users\\O'Brien\\AppData\\Local\\Temp\\x.mp3':", 'Brien'],
  ['drive dquote', 'Error opening input file "C:\\Users\\bob\\My "Books"\\x.mp3".', 'Books'],
  ['drive fwd slash', 'C:/Users/bob/AppData/Local/Temp/x.mp3: Permission denied', 'bob'],
  ['8.3 short', 'C:\\Users\\JOHNDO~1\\AppData\\Local\\Temp\\x.mp3: No such file or directory', 'JOHNDO'],
  ['UNC plain', '\\\\nas\\share\\Castwright\\books\\Author\\Title\\audio\\ch1.mp3: Invalid data found', 'Author'],
  ['UNC space', '\\\\nas\\Audio Books\\Castwright\\books\\Author\\Title\\audio\\ch1.mp3: Invalid data found', 'Author'],
  ['long path', '\\\\?\\C:\\Users\\bob\\Castwright\\books\\Author\\Title\\ch1.mp3: No such file or directory', 'Author'],
  ['long path space', '\\\\?\\C:\\Users\\John Doe\\Castwright\\books\\Author\\Title\\ch1.mp3: No such file', 'Author'],
  ['long UNC', '\\\\?\\UNC\\nas\\share\\books\\Author\\ch1.mp3: No such file or directory', 'Author'],
  ['posix plain', '/home/bob/castwright/books/Author/Title/ch1.mp3: No such file or directory', 'bob'],
  ['posix space', '/Users/bob/My Books/castwright/books/Author/Title/ch1.mp3: No such file', 'Author'],
  ['posix parens', '/home/bob/books (old)/Author/Title/ch1.mp3: No such file or directory', 'Author'],
  ['posix one segment', '/castwright: No such file or directory', 'castwright'],
  ['posix after colon', 'Error opening input:/home/bob/castwright/books/ch1.mp3', 'bob'],
  ['file url drive', 'file:///C:/Users/bob/x.mp3: No such file or directory', 'bob'],
  ['file url posix', 'file:///home/bob/castwright/x.mp3: No such file or directory', 'bob'],
  ['file url single slash', 'file:/home/bob/castwright/x.mp3: No such file or directory', 'bob'],
  ['tilde home', '~/castwright/books/Author/ch1.mp3: No such file or directory', 'Author'],
  ['posix colon in name', '/home/bob/Book: A Tale/ch1.mp3: No such file or directory', 'Tale'],
  [
    'ffmpeg 8 open-output line',
    '[out#0/mp3 @ 000001d2] Error opening output C:\\Users\\John Doe\\AppData\\Local\\Temp\\audiobook-encode-1-2-3.mp3: No such file',
    'Doe',
  ],
  [
    'ffmpeg context prefix, posix',
    '[out#0/mp3 @ 0x55d1]Error opening output /tmp/audiobook-encode-1.mp3: No such file or directory',
    'audiobook-encode',
  ],
  ['long drive path over the cap', longDrive, 'verylongfolder'],
  ['long posix path over the cap', longPosix, 'ch1'],
];

describe('ffmpegFailure path scrub (#4233)', () => {
  it.each(CASES)('%s', (_label, line, secret) => {
    const err = ffmpegFailure('ffmpeg (decode file)', 1, `ffmpeg version 8\n${line}`);
    expect(err.message).not.toContain(secret);
    expect(err.message).toMatch(/^ffmpeg \(decode file\) exited with code 1/);
    expect(err.ffmpegStderr).toContain(line);
  });

  it('keeps the "no space left" phrase when the path-bearing line carried it', () => {
    const err = ffmpegFailure(
      'ffmpeg',
      1,
      'Error opening output C:\\Users\\John Doe\\x.mp3: No space left on device',
    );
    expect(err.message).toMatch(/no space left/i);
    expect(err.message).not.toContain('Doe');
  });

  it('leaves a path-free last line verbatim', () => {
    const err = ffmpegFailure('ffmpeg', 1, 'banner\nInvalid data found when processing input');
    expect(err.message).toBe('ffmpeg exited with code 1: Invalid data found when processing input');
  });

  it('does not mistake non-path slashes for a path root', () => {
    const err = ffmpegFailure('ffmpeg', 1, '[out#0/mp3 @ 0x1] I/O error, and/or N/A');
    expect(err.message).toContain('I/O error, and/or N/A');
    expect(err.message).toContain('out#0/mp3');
  });
});
