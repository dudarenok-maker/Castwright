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
  it('the endpoint-missing entry is titled "cannot be used" and no longer says "yet" now that endpoints are selectable (#3084 PR 3b review pass 2, #3710 F2)', () => {
    const e = HELP_FAILURE_ENTRIES.find((x) => x.code === 'analyzer-endpoint-missing')!;
    for (const text of [e.title, e.userMessage, e.remediation]) {
      expect(text).not.toMatch(/ yet/);
    }
    expect(e.title).toMatch(/cannot be used/i);
  });
  it('the endpoint-missing entry covers every cause the code fires for (#3710 review pass 2 F)', () => {
    const e = HELP_FAILURE_ENTRIES.find((x) => x.code === 'analyzer-endpoint-missing')!;
    expect(e.userMessage).toMatch(/not configured/); // not saved / deleted
    expect(e.userMessage).toMatch(/engine is not set to OpenAI-compatible/); // saved endpoint, wrong engine
    expect(e.userMessage).toMatch(/not an endpoint model/); // OpenAI-compatible engine, a non-endpoint model
    expect(e.remediation).toMatch(/OpenAI-compatible/);
    expect(e.remediation).toMatch(/default analysis model/);
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
