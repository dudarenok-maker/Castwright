import { describe, it, expect } from 'vitest';
import { writeInbox, stage2HandoffKey, inboxPath, outboxPath } from './protocol.js';

describe('writeInbox', () => {
  it('rejects a traversal manuscriptId before writing', async () => {
    await expect(writeInbox('../../evil', '1', 'payload')).rejects.toThrow();
  });
});

/* #2324 — a chunked chapter used to write every section under one `2-ch{n}`
   key, and writeInbox rm's the previous outbox before each write, so only the
   last section's forensics survived. */
describe('stage2HandoffKey', () => {
  it('keeps the historical bare key for the single-call path', () => {
    expect(stage2HandoffKey(7)).toBe('2-ch7');
    expect(stage2HandoffKey(7, undefined)).toBe('2-ch7');
  });

  it('numbers each sectioned call so they cannot collide', () => {
    expect(stage2HandoffKey(7, 1)).toBe('2-ch7-c1');
    expect(stage2HandoffKey(7, 4)).toBe('2-ch7-c4');
  });

  it('gives every call of a 4-section chapter its OWN inbox AND outbox path', () => {
    const seqs = [1, 2, 3, 4];
    const inboxes = new Set(seqs.map((s) => inboxPath('mns_x', stage2HandoffKey(7, s))));
    const outboxes = new Set(seqs.map((s) => outboxPath('mns_x', stage2HandoffKey(7, s))));
    expect(inboxes.size).toBe(4);
    expect(outboxes.size).toBe(4);
    /* The defect this pins: with the old bare key every section resolved to the
       SAME pair of paths, so section 4 overwrote 1-3. */
    const bare = new Set(seqs.map(() => inboxPath('mns_x', stage2HandoffKey(7))));
    expect(bare.size).toBe(1);
  });

  it('does not collide across chapters', () => {
    expect(stage2HandoffKey(1, 2)).not.toBe(stage2HandoffKey(2, 1));
  });
});
