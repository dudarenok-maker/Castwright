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

  it('names every path text can leave the machine: Gemini analysis, a remote endpoint, a fallback target when it takes over, cloud escalation, persona generation and Gemini voices (#3084 P30)', () => {
    const privacy = byId('is-my-data-private')!.body;
    expect(privacy).toMatch(/Gemini API/);
    expect(privacy).toMatch(/OpenAI-compatible endpoint/);
    expect(privacy).toMatch(/OpenRouter/);
    expect(privacy).toMatch(/fallback target .* when it takes over/);
    expect(privacy).toMatch(/attribution escalation set to cloud/);
    expect(privacy).toMatch(/persona generation, whose engine defaults to Gemini/);
    expect(privacy).toMatch(/Gemini voice/);
    expect(privacy).toMatch(/Advanced Settings → Analyzer fallback/);
    expect(privacy).not.toMatch(/The one thing that can leave your machine is/);
    const offline = byId('does-it-work-offline')!.body;
    expect(offline).toMatch(/remote OpenAI-compatible endpoint/);
    expect(offline).toMatch(/attribution escalation set to cloud/);
    expect(offline).toMatch(/persona generation on Gemini/);
    expect(offline).toMatch(/Gemini voices/);
    expect(offline).toContain(
      'Voice design has its own Persona generation engine in Advanced settings, which defaults to Gemini; set it to Local and a no-key, fully-offline setup can still design a full cast from scratch.',
    );
    expect(offline).not.toMatch(/Voice design follows the same analyzer engine/);
    expect(offline).not.toMatch(/nothing is sent anywhere while Castwright synthesises/);
    expect(offline).not.toMatch(/is the one part that wants a connection/);
  });

  it('the Local-ran-on-Gemini topic points at Advanced Settings → Analyzer fallback, not the removed switch (#3084 P30)', () => {
    const body = byId('picked-local-but-ran-on-gemini')!.body;
    expect(body).toMatch(/Advanced Settings → Analyzer fallback/);
    expect(body).not.toMatch(/Cloud fallback/);
  });
});
