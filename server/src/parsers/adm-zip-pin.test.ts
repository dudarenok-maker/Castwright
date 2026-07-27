// Guards the `overrides: { "adm-zip": ">=0.6.0" }` block in server/package.json.
//
// adm-zip is the ZIP reader behind every EPUB upload, reached transitively
// through epub2 -> epub2/zipfile.js (which prefers an optional native `zipfile`
// package and falls back to adm-zip when it is absent, as it is here).
//
// epub2@3.0.2 is the latest release and declares `adm-zip: ^0.5.10`, so the
// patched 0.6.0 is OUT of that range and arrives ONLY via the override. That
// makes the override a load-bearing security fix delivered entirely by config:
// delete it and npm happily reinstalls 0.5.17, satisfying epub2's declared
// range, with no error and no warning.
//
// Nothing else would notice. The 27 cases in epub.test.ts produce byte-identical
// results on 0.5.17 and 0.6.0, so the parser suite cannot detect the regression
// — hence this explicit floor assertion.
//
// 0.6.0 fixes GHSA-xcpc-8h2w-3j85 (crafted ZIP triggers a ~4 GB allocation) and,
// separately, removes a data-descriptor CRC path in which 0.5.17 threw from
// inside a zlib 'end' handler with no surrounding try/catch — an uncaught throw
// that a malformed uploaded EPUB could use to take down the server process.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** Compare dotted numeric versions: -1 | 0 | 1. Avoids taking on a semver dep. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

describe('adm-zip override', () => {
  it('resolves adm-zip at or above the patched 0.6.0', () => {
    const { version } = require('adm-zip/package.json') as { version: string };
    expect(compareVersions(version, '0.6.0')).toBeGreaterThanOrEqual(0);
  });

  it('keeps the override declared, since epub2 alone would pull a vulnerable 0.5.x', () => {
    const pkg = require('../../package.json') as {
      overrides?: Record<string, string>;
    };
    // `>=0.6.0`, deliberately NOT `^0.6.0`: adm-zip has only ever published 0.x
    // releases, so a caret would cap at <0.7.0 and silently hold the tree back
    // when the next fix lands as 0.7.0.
    expect(pkg.overrides?.['adm-zip']).toBe('>=0.6.0');
  });

  it('still reaches adm-zip through epub2 (the fallback path, not the native `zipfile`)', () => {
    // If `zipfile` ever gets installed, epub2 prefers it and adm-zip stops being
    // the live path — at which point the reasoning above needs revisiting.
    expect(() => require.resolve('zipfile')).toThrow();
  });
});
