import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../lib/run-command.mjs';

test('runCommand returns stdout on success', () => {
  const out = runCommand('test', process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(out, 'hi');
});

test('runCommand throws with stderr when the process exits non-zero', () => {
  assert.throws(
    () =>
      runCommand('test', process.execPath, [
        '-e',
        'process.stderr.write("boom"); process.exit(1)',
      ]),
    /test: .* failed: boom/,
  );
});

test('runCommand surfaces the real spawn error instead of swallowing it as undefined', () => {
  assert.throws(
    () => runCommand('test', 'this-binary-does-not-exist-anywhere', []),
    /test: this-binary-does-not-exist-anywhere.*failed to spawn:/,
  );
});

// #2184 Finding 2 — runCommand's callers (sync-wiki.mjs's six git commands,
// including `git push`) pin an explicit `cwd` but never scrubbed env, so an
// inherited GIT_DIR — which overrides git's cwd-based repo discovery
// outright — could silently redirect them at the wrong repository. Asserts
// the scrub actually reaches the spawned child, not just that scrubGitEnv()
// is imported.
test('runCommand scrubs an inherited GIT_DIR from the spawned child env', () => {
  const out = runCommand(
    'test',
    process.execPath,
    ['-e', 'process.stdout.write(String(process.env.GIT_DIR))'],
    { env: { ...process.env, GIT_DIR: '/decoy/.git' } },
  );
  assert.equal(out, 'undefined');
});
