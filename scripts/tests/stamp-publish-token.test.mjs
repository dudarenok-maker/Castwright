// Tests for the stamper — the half of the publish-token design that makes
// "nothing hand-maintained is trusted" true. Two of the eight designs that
// preceded the token failed because a human maintained part of it by hand and
// the value went stale, which fails in the GREEN direction. If this script is
// wrong, the comparator's guarantees rest on nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { seedToken, mintNonce, parseArgs, DEFAULT_FILE } from '../stamp-publish-token.mjs';
import { parsePublishToken, bumpToken } from '../publish-token.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Imported rather than re-typed: a copy here would let the test keep passing
// while the script targeted a different file.
const LIVE_VIEW_REL = DEFAULT_FILE;
const LIVE_VIEW = resolve(REPO_ROOT, LIVE_VIEW_REL);

test('the tracked live view carries exactly one well-formed publish token', () => {
  // The bootstrap invariant. `comparePublishTokens` returns a hard error when
  // origin/main carries no token, so if this ever regresses, every
  // --against-published run fails with a message blaming a revert.
  const parsed = parsePublishToken(readFileSync(LIVE_VIEW, 'utf8'));
  assert.notEqual(parsed, null, 'the live view must carry a publish token');
  assert.equal(parsed.malformed, undefined, `token is malformed: ${parsed.malformed}`);
  assert.ok(Number.isInteger(parsed.n) && parsed.n >= 1);
});

test('the token sits on a real element, NOT inside an HTML comment', () => {
  // checkLiveView's first action is stripHtmlComments, so a comment-carried
  // token is invisible to the one function that must read it.
  const html = readFileSync(LIVE_VIEW, 'utf8');
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.notEqual(
    parsePublishToken(stripped),
    null,
    'the token must survive comment stripping, or checkLiveView cannot see it',
  );
});

test('mintNonce produces a value the parser accepts, every time', () => {
  // A stamper that writes a token its own reader rejects wedges the check
  // permanently — the file cannot be fixed by stamping it again.
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const n = mintNonce();
    assert.match(n, /^[A-Za-z0-9_-]{6,64}$/, `minted ${JSON.stringify(n)} is not parseable`);
    seen.add(n);
  }
  assert.ok(seen.size > 490, `nonces must not repeat: only ${seen.size}/500 distinct`);
});

test('mintNonce is distinguishable from an abbreviated commit SHA', () => {
  // The live view quotes short SHAs in its own changelog prose. The history
  // lookup is anchored, so a collision is not a correctness bug — but keeping
  // the shapes distinct keeps the logs readable, and the length is the tell.
  assert.notEqual(mintNonce().length, 7, 'must not look like a short SHA');
  assert.notEqual(mintNonce().length, 8);
});

test('seedToken creates a token where there is none', () => {
  const { html, n, nonce } = seedToken('<h1>Title</h1>\n<p>body</p>', () => 'seed01');
  assert.equal(n, 1, 'a seeded counter starts at 1');
  assert.equal(nonce, 'seed01');
  assert.deepEqual(parsePublishToken(html), { n: 1, nonce: 'seed01' });
  assert.ok(html.includes('<p>body</p>'), 'the rest of the document must survive');
});

test('seedToken REFUSES a file that already has a token', () => {
  // Seeding over an existing token would reset the counter to 1 and orphan the
  // nonce chain — every later comparison is anchored to that history.
  const once = seedToken('<h1>T</h1>', () => 'seed01').html;
  assert.throws(() => seedToken(once, () => 'seed02'), /already has a token/);
});

test('seedToken refuses a file with no anchor rather than guessing', () => {
  assert.throws(() => seedToken('<p>no heading</p>', () => 'seed01'), /no <h1>/);
});

test('seed then bump produces a strictly increasing counter and a fresh id', () => {
  let html = seedToken('<h1>T</h1>', () => 'aaaaaa').html;
  const ids = new Set(['aaaaaa']);
  let prev = 1;
  for (const id of ['bbbbbb', 'cccccc', 'dddddd']) {
    const out = bumpToken(html, () => id);
    assert.equal(out.n, prev + 1, 'the counter must advance by exactly one');
    assert.ok(!ids.has(out.nonce), 'each stamp must mint an unused id');
    ids.add(out.nonce);
    prev = out.n;
    html = out.html;
  }
  assert.deepEqual(parsePublishToken(html), { n: 4, nonce: 'dddddd' });
});

// --- The CLI. Previously untested end-to-end, which is exactly why a typo'd
// flag silently performed the WRITE: `--chek` stamped the live view and exited
// 0, and `--file=x` stamped the DEFAULT file. This script's default action is a
// write to a tracked file, so its argument parser is a safety boundary.
const SCRIPT = resolve(REPO_ROOT, 'scripts/stamp-publish-token.mjs');

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('parseArgs REFUSES anything it does not recognise', () => {
  for (const argv of [['--chek'], ['--Check'], ['-c'], ['stamp'], ['--file'], ['--file=']]) {
    const out = parseArgs(argv);
    assert.ok(out.error, `${JSON.stringify(argv)} must be refused, got ${JSON.stringify(out)}`);
  }
});

test('parseArgs accepts the documented forms, including --file=', () => {
  assert.deepEqual(parseArgs([]), { check: false, file: LIVE_VIEW_REL });
  assert.deepEqual(parseArgs(['--check']), { check: true, file: LIVE_VIEW_REL });
  assert.deepEqual(parseArgs(['--file', 'a.html']), { check: false, file: 'a.html' });
  // `--file=x` used to be swallowed as unknown, leaving the DEFAULT file targeted.
  assert.deepEqual(parseArgs(['--file=a.html']), { check: false, file: 'a.html' });
  assert.deepEqual(parseArgs(['--check', '--file=a.html']), { check: true, file: 'a.html' });
});

test('CLI: a typo\'d flag exits non-zero and writes NOTHING', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cli-'));
  try {
    const target = join(dir, 'page.html');
    const before = '<h1>T</h1>\n<div hidden data-published-as="7" data-publish-id="abc123"></div>';
    writeFileSync(target, before);
    const r = runCli(['--chek', '--file', target], dir);
    assert.notEqual(r.code, 0, 'a typo must not exit 0');
    assert.match(r.stderr, /unknown argument/);
    assert.equal(readFileSync(target, 'utf8'), before, 'a refused invocation must not write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --check reports without writing; a bare run stamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cli-'));
  try {
    const target = join(dir, 'page.html');
    const before = '<h1>T</h1>\n<div hidden data-published-as="7" data-publish-id="abc123"></div>';
    writeFileSync(target, before);

    const checked = runCli(['--check', '--file', target], dir);
    assert.equal(checked.code, 0);
    assert.match(checked.stdout, /is at 7/);
    assert.equal(readFileSync(target, 'utf8'), before, '--check must never write');

    const stamped = runCli(['--file', target], dir);
    assert.equal(stamped.code, 0, stamped.stderr);
    const after = parsePublishToken(readFileSync(target, 'utf8'));
    assert.equal(after.n, 8);
    assert.notEqual(after.nonce, 'abc123', 'a stamp must mint a new id, not only bump');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: an unreadable file is an error, not a silent seed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cli-'));
  try {
    const r = runCli(['--file', join(dir, 'does-not-exist.html')], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bumpToken refuses to exceed the parser\'s 15-digit counter cap', () => {
  const atCap = `<div data-published-as="999999999999999" data-publish-id="abc123"></div>`;
  assert.equal(parsePublishToken(atCap).n, 999999999999999, 'precondition: the cap parses');
  assert.throws(() => bumpToken(atCap, () => 'abc124'), /15-digit counter cap/);
});

test('seedToken distinguishes MALFORMED from absent (the F7 mirror)', () => {
  // `parsePublishToken` has three outcomes and `{ malformed } !== null`, so a
  // binary `!== null` test reported "this file already has a token" for a file
  // with none — the same misattribution the comparator fix closes, mirrored at
  // the parser's only other caller.
  const noToken = Buffer.from('<h1>Register</h1>\n<p>no token at all</p>\n');
  assert.throws(() => seedToken(noToken, () => 'abc123'), (err) => {
    assert.ok(!/already has a token/.test(err.message), `misattributed: ${err.message}`);
    assert.match(err.message, /Buffer|encoding/);
    return true;
  });
  // A real, already-tokened string still gets the right refusal.
  const seeded = seedToken('<h1>T</h1>', () => 'seed01').html;
  assert.throws(() => seedToken(seeded, () => 'seed02'), /already has a token/);
});

test('CLI --check reports a MALFORMED token as an error, not as a value', () => {
  // Without this the malformed branch could be deleted and --check would exit 0
  // printing "is at undefined (id undefined)" — reporting a broken token as a
  // healthy one, in the mode whose entire job is to tell you the token's state.
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cli-'));
  try {
    const target = join(dir, 'page.html');
    writeFileSync(target, '<h1>T</h1>\n<div data-published-as="abc" data-publish-id="zzzxxx"></div>');
    const r = runCli(['--check', '--file', target], dir);
    assert.notEqual(r.code, 0, '--check must not exit 0 on a malformed token');
    assert.match(r.stderr, /malformed/);
    assert.ok(!/is at undefined/.test(r.stdout), `must not report a value: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --check reports a TOKENLESS file as needing seeding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-cli-'));
  try {
    const target = join(dir, 'page.html');
    writeFileSync(target, '<h1>T</h1>\n<p>no token</p>');
    const r = runCli(['--check', '--file', target], dir);
    assert.notEqual(r.code, 0, 'a tokenless file is not a passing --check');
    assert.match(r.stdout, /NO publish token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedToken REFUSES a mint its own parser would reject (the bumpToken twin)', () => {
  // bumpToken's identical guard is pinned by 18l; this one was not. Removed, it
  // writes data-publish-id="ab" — a token the module's own parser rejects, and
  // one that cannot be repaired by stamping, because stamping needs a parseable
  // token to bump. That is the unrecoverable state the guard exists to prevent.
  for (const bad of ['ab', '', 'a b', '-Sx', 'has"q', null, 42]) {
    assert.throws(
      () => seedToken('<h1>T</h1>', () => bad),
      /minted nonce/,
      `seed mint -> ${JSON.stringify(bad)} must be refused`,
    );
  }
  // and a good mint still round-trips through the parser
  const { html } = seedToken('<h1>T</h1>', () => 'abc123');
  assert.deepEqual(parsePublishToken(html), { n: 1, nonce: 'abc123' });
});
