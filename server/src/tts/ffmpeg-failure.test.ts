/* #4233 -- the path scrub in `ffmpegFailure` drops anything from a path root to
   the end of the (last) stderr line, rather than enumerating path syntax. Each
   case is a realistic ffmpeg last line plus a fragment that must not survive. */

import { describe, expect, it } from 'vitest';
import { ffmpegFailure, scrubChildOutput } from './ffmpeg-failure.js';

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

  it("keeps ffmpeg 8.1.1's own \"Error closing file\" wording intact", () => {
    const err = ffmpegFailure('ffmpeg', 1, 'Error closing file: Invalid argument');
    expect(err.message).toBe('ffmpeg exited with code 1: Error closing file: Invalid argument');
  });

  it.each(['=', ']', ',', '{', '<'])('scrubs a posix path that follows %s', (lead) => {
    const err = ffmpegFailure('ffmpeg', 1, `banner\nError opening output url${lead}/home/bob/Secret Book/ch1.mp3: denied`);
    expect(err.message).not.toContain('Secret');
    expect(err.message).not.toContain('/home');
  });

  it.each(['I/O error', 'Input/output error', 'out#0/mp3', '1/2', '/', 'http://127.0.0.1:9000/x', 'pipe:0'])(
    'leaves %s intact',
    (line) => {
      const err = ffmpegFailure('ffmpeg', 1, line);
      expect(err.message).toBe(`ffmpeg exited with code 1: ${line}`);
    },
  );

  it('does not mistake non-path slashes for a path root', () => {
    const err = ffmpegFailure('ffmpeg', 1, '[out#0/mp3 @ 0x1] I/O error, and/or N/A');
    expect(err.message).toContain('I/O error, and/or N/A');
    expect(err.message).toContain('out#0/mp3');
  });
});

/* #3702 -- `scrubPaths` is a ONE-LINE scrubber (a path drops everything to the end of
   its line). Child output with several lines (mkcert's install hints, a node stack)
   goes through `scrubChildOutput`, which keeps every line and drops only the paths. */
describe('scrubChildOutput (#3702)', () => {
  it("keeps every line of setup-lan-certs.mjs's Linux-branch text and drops only the path", () => {
    const text = [
      '[setup-lan-certs] [FAIL] mkcert is not on PATH. Install it once with one of:',
      '  Debian/Ubuntu: sudo apt install libnss3-tools && curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64" && chmod +x mkcert-* && sudo mv mkcert-* /usr/local/bin/mkcert',
      '  Fedora:        sudo dnf install nss-tools mkcert',
      '  Arch:          sudo pacman -S mkcert',
      'Then re-run this script (or restart the app).',
    ].join('\n');
    const out = scrubChildOutput(text);
    expect(out).not.toContain('/usr/local');
    expect(out).toContain('Fedora:        sudo dnf install nss-tools mkcert');
    expect(out).toContain('Arch:          sudo pacman -S mkcert');
    expect(out).toContain('Then re-run this script (or restart the app).');
    expect(out.split('\n')).toHaveLength(5);
  });

  it('preserves CRLF line endings, and leaves path-free text untouched', () => {
    expect(scrubChildOutput('a C:\\Users\\bob\\file\r\nsecond line\r\n')).toBe('a <path>\r\nsecond line\r\n');
    expect(scrubChildOutput('plain\nlines')).toBe('plain\nlines');
  });
});
