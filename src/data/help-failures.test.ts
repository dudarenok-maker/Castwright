import { describe, expect, it } from 'vitest';
import { HELP_FAILURE_ENTRIES } from './help-failures';
import { HELP_TOPICS } from './help-topics';

describe('help content (fe-29)', () => {
  it('has one troubleshooting entry per FailureCode, each with title/userMessage/remediation', () => {
    for (const e of HELP_FAILURE_ENTRIES) {
      expect(e.code.length).toBeGreaterThan(0);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.userMessage.length).toBeGreaterThan(0);
      expect(e.remediation.length).toBeGreaterThan(0);
    }
    expect(HELP_FAILURE_ENTRIES.length).toBe(18);
  });
  it('curated topics each have a title and body', () => {
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(5);
    for (const t of HELP_TOPICS) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });
});
