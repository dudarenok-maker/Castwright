import { describe, it, expect } from 'vitest';
import { writeInbox } from './protocol.js';

describe('writeInbox', () => {
  it('rejects a traversal manuscriptId before writing', async () => {
    await expect(writeInbox('../../evil', '1', 'payload')).rejects.toThrow();
  });
});
