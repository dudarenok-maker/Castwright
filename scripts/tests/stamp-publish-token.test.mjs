// Tests for the stamper — the half of the publish-token design that makes
// "nothing hand-maintained is trusted" true. Two of the eight designs that
// preceded the token failed because a human maintained part of it by hand and
// the value went stale, which fails in the GREEN direction. If this script is
// wrong, the comparator's guarantees rest on nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedToken, mintNonce } from '../stamp-publish-token.mjs';
import { parsePublishToken, bumpToken } from '../publish-token.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_VIEW = resolve(REPO_ROOT, 'docs/testing/onbox-acceptance-register-live-view.html');

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
