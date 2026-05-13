/* Pure-function regression for the catalog auditor. The diff is what tells
   us — at server boot, not mid-chapter — when COQUI_PROFILE_VOICES has
   drifted ahead of the model's actual speaker manifest. */

import { describe, it, expect } from 'vitest';
import { diffCatalogAgainstModel } from './coqui-catalog-audit.js';
import { COQUI_PROFILE_VOICES } from './voice-mapping.js';

/** Flatten all catalog speakers into a single set for test setup. */
function allCatalogNames(): Set<string> {
  const out = new Set<string>();
  for (const options of Object.values(COQUI_PROFILE_VOICES)) {
    for (const n of options) out.add(n);
  }
  return out;
}

describe('diffCatalogAgainstModel', () => {
  it('flags every catalog name as invalid when the model has none of them', () => {
    const audit = diffCatalogAgainstModel(['Random Person', 'Another One'], 'http://test/');
    /* Every option in every profile is invalid → all profiles degraded. */
    expect(audit.invalidInCatalog).toHaveLength(allCatalogNames().size);
    expect(audit.validInCatalog).toEqual([]);
    expect(audit.degradedProfiles.length).toBeGreaterThan(0);
    expect(audit.healthyProfiles).toEqual([]);
    /* Both model speakers are unused. */
    expect(audit.unusedInModel.sort()).toEqual(['Another One', 'Random Person']);
  });

  it('reports a clean audit when the model has every catalog name', () => {
    const speakers = [...allCatalogNames()];
    const audit = diffCatalogAgainstModel(speakers, 'http://test/');
    expect(audit.invalidInCatalog).toEqual([]);
    expect(audit.validInCatalog.sort()).toEqual([...allCatalogNames()].sort());
    expect(audit.degradedProfiles).toEqual([]);
    expect(audit.healthyProfiles.sort().length).toBe(Object.keys(COQUI_PROFILE_VOICES).length);
    expect(audit.unusedInModel).toEqual([]);
  });

  it('marks only the profiles whose options include an invalid name as degraded', () => {
    /* Remove exactly one name from the model — say the first option of
       narrator-cool — and confirm only that profile flips to degraded. */
    const dropped = COQUI_PROFILE_VOICES['narrator-cool'][0];
    const speakers = [...allCatalogNames()].filter(n => n !== dropped);
    const audit = diffCatalogAgainstModel(speakers, 'http://test/');

    expect(audit.invalidInCatalog).toEqual([dropped]);
    expect(audit.degradedProfiles).toEqual(['narrator-cool']);
    /* Every other profile is healthy. */
    const allProfiles = Object.keys(COQUI_PROFILE_VOICES);
    const healthyExpected = allProfiles.filter(p => p !== 'narrator-cool').sort();
    expect(audit.healthyProfiles).toEqual(healthyExpected);
  });

  it('surfaces model speakers that exist but are unused by the catalog', () => {
    const speakers = [...allCatalogNames(), 'Bonus Speaker A', 'Bonus Speaker B'];
    const audit = diffCatalogAgainstModel(speakers, 'http://test/');
    expect(audit.unusedInModel.sort()).toEqual(['Bonus Speaker A', 'Bonus Speaker B']);
  });

  it('captures the sidecar url so the cached audit knows where it came from', () => {
    const audit = diffCatalogAgainstModel(['x'], 'http://my-sidecar:9000');
    expect(audit.sidecarUrl).toBe('http://my-sidecar:9000');
    expect(audit.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
