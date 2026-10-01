/* Pairs with #3084 F7 — the "How to fix" deep link.

   `fixHref` is the ONE place a fix's `settingKey` becomes a URL, so this is
   where the scheme is pinned: a setting-key fix links into Advanced Settings,
   and a label-only fix (e.g. "Switch to a different analyzer model") is NOT a
   link. The second case is the one that matters — `stageToHash` treats a
   missing `focusKey` as "no query string" and returns a perfectly valid
   `'#/advanced'` rather than throwing, so a mutant that drops the
   `if (fix.settingKey)` guard produces a wrong href, not a crash. */

import { describe, it, expect } from 'vitest';
import { fixHref } from './failure-fixes';

describe('fixHref (#3084 wave 2b, F7)', () => {
  it('a settingKey fix links to the focused Advanced Settings row', () => {
    expect(
      fixHref({
        label: 'Lower Gemini max input tokens per request',
        settingKey: 'analyzer.gemini.maxInputTokensPerRequest',
      }),
    ).toBe('#/advanced?focus=analyzer.gemini.maxInputTokensPerRequest');
  });

  it('a label-only fix (e.g. "switch model") returns null', () => {
    expect(fixHref({ label: 'Switch to a different analyzer model' })).toBeNull();
  });
});
