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
