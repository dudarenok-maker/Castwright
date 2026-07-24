import { describe, expect, it } from 'vitest';
import { HELP_TOPICS } from './help-topics';

/* Privacy / offline Help topics mirror the marketing-site FAQ (Castwright-Website
   #126) after the v1.14 local-first analysis flip. They must state the honest
   claim — analysis is local BY DEFAULT, and the cloud fallback is opt-out and
   can be switched off — and must NOT overclaim that the cloud is opt-in only or
   never used. These guards keep the app copy from drifting back. See issue #1793. */
describe('privacy & offline Help topics (local-first mirror, #1793)', () => {
  const byId = (id: string) => HELP_TOPICS.find((t) => t.id === id);

  it('has an "Is my data private?" topic filed under files', () => {
    const t = byId('is-my-data-private');
    expect(t).toBeDefined();
    expect(t!.category).toBe('files');
    expect(t!.title).toMatch(/private/i);
    expect(t!.body).toMatch(/local model by default|reads your chapter text on a local model/i);
  });

  it('has a "Does it work offline?" topic filed under analysis', () => {
    const t = byId('does-it-work-offline');
    expect(t).toBeDefined();
    expect(t!.category).toBe('analysis');
    expect(t!.title).toMatch(/offline/i);
    expect(t!.body).toMatch(/local Ollama model by default|by default/i);
  });

  it('neither topic overclaims that the cloud is opt-in-only or never used', () => {
    for (const id of ['is-my-data-private', 'does-it-work-offline']) {
      const body = byId(id)!.body.toLowerCase();
      expect(body).not.toContain('never touches the cloud');
      expect(body).not.toContain('never leaves your machine');
      // the fallback is opt-out (on by default), never framed as opt-in only
      expect(body).not.toContain('only if you choose');
    }
  });

  it('states the cloud fallback is on by default and can be switched off', () => {
    const privacy = byId('is-my-data-private')!.body.toLowerCase();
    expect(privacy).toContain('on by default');
    expect(privacy).toMatch(/turns it off|switch it off|switched off/i);
  });
});
