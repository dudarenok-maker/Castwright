// server/src/test-utils/quarantine.test.ts
import { describe, it, expect } from 'vitest';
import { RUN_QUARANTINE } from './quarantine.js';

describe('quarantine helper', () => {
  it('RUN_QUARANTINE reflects the env flag', () => {
    expect(RUN_QUARANTINE).toBe(process.env.RUN_QUARANTINE === '1');
  });
});
