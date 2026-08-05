// Pins ops-21's incidental fix (#2152) to .github/actions/setup/action.yml:
// the node_modules cache key must interpolate `inputs.node-version`, not
// hardcode a literal Node major. A hardcoded major means bumping the
// `node-version` input (default '24', :22-25) still restores a node_modules
// cache built for the OLD major — setup-node installs the new major, the
// cache key still matches, `npm ci` is skipped (:54), and every leg that
// consumes this composite runs against natively-mismatched modules. This is
// its own sibling file rather than an addition to workflow-wiring.test.mjs:
// that file's own header scopes it to verify.yml's derived scope conditions
// specifically, not the setup composite's YAML.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionPath = resolve(repoRoot, '.github', 'actions', 'setup', 'action.yml');
const source = readFileSync(actionPath, 'utf8');

test('setup action node_modules cache key interpolates inputs.node-version, not a literal major', () => {
  const keyLine = source
    .split(/\r?\n/)
    .find((line) => line.includes('key:') && line.includes('runner.os') && line.includes('modules'));
  assert.ok(keyLine, 'expected a node_modules cache `key:` line naming runner.os and modules');
  assert.ok(
    keyLine.includes('${{ inputs.node-version }}'),
    `cache key must interpolate inputs.node-version, got: ${keyLine.trim()}`,
  );
  assert.ok(
    !/-node\d+-modules-/.test(keyLine),
    `cache key must not hardcode a literal Node major, got: ${keyLine.trim()}`,
  );
});
