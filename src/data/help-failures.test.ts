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
    expect(HELP_FAILURE_ENTRIES.length).toBe(28);
  });
  it('the endpoint-missing entry is titled and worded as "cannot be used", never "not configured" (#3084 PR 3b review pass 2)', () => {
    const e = HELP_FAILURE_ENTRIES.find((x) => x.code === 'analyzer-endpoint-missing')!;
    for (const text of [e.title, e.userMessage, e.remediation]) {
      expect(text).not.toMatch(/not configured/i);
    }
    expect(e.title).toMatch(/cannot be used/i);
  });
  it('the auth entry is source-neutral: it is no longer a Gemini-TTS-only entry (#3084 PR 3b review pass 2)', () => {
    const e = HELP_FAILURE_ENTRIES.find((x) => x.code === 'auth')!;
    expect(e.title).not.toMatch(/Gemini/);
    expect(e.userMessage).not.toMatch(/Gemini TTS/);
    expect(e.remediation).toMatch(/Ollama/);
    expect(e.remediation).toMatch(/endpoint/i);
    expect(e.remediation).toMatch(/Settings/);
  });
  it('curated topics each have a title and body', () => {
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(5);
    for (const t of HELP_TOPICS) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });
});
