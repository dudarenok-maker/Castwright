import { describe, it, expect } from 'vitest';
import * as gemini from '../gemini.js';
import * as parse from './parse.js';
import * as prompt from './prompt.js';

describe('helpers moved out of gemini.ts (#3084 wave 1)', () => {
  it('gemini.js re-exports the moved parse helpers as the same function objects', () => {
    for (const name of [
      'parseAndValidate',
      'stripCodeFences',
      'repairUnescapedQuotes',
      'trimTrailingProse',
      'repairStructuralPunctuation',
      'buildRetryMessage',
      'summariseDetail',
      'persistResponse',
    ] as const) {
      expect(gemini[name], name).toBe(parse[name]);
    }
  });

  it('gemini.js re-exports the moved prompt helpers as the same function objects', () => {
    for (const name of ['loadSkill', 'buildSystemInstruction', 'languagePreamble'] as const) {
      expect(gemini[name], name).toBe(prompt[name]);
    }
  });

  it('loadSkill still resolves on-disk skills from the new directory depth', async () => {
    /* whole_book_stage1 and non_story_classification are NOT prompt-registry
       backed (absent from SKILL_TO_PROMPT_ID), so they read SKILLS_DIR
       directly — the one path whose relative depth changed with the move. */
    expect((await prompt.loadSkill('whole_book_stage1')).length).toBeGreaterThan(100);
    expect((await prompt.loadSkill('non_story_classification')).length).toBeGreaterThan(100);
  });
});
