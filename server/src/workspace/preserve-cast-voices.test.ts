/* Durable guard: a cast write (PUT /api/books/:id/state slice:'cast') must never
   strip a designed voice. Every frontend cast write funnels through that one
   handler — the persistence middleware (auto-save on cast actions), manual cast
   edits, and the cast-confirm/rebaseline screen. The 2026-06-05 incident: the
   book routed to the analysing→cast-confirm flow, which persisted a voiceless
   in-memory cast and overwrote the designed Qwen voices on disk.

   `preserveDesignedVoicesOnCastWrite` fills each incoming character's missing
   voice-DESIGN fields (`overrideTtsVoices`, `ttsEngine`, `voiceStyle`) from the
   existing on-disk character — INCOMING WINS when present (so a deliberate
   re-design still writes), existing fills only the gap. Reuse-link fields
   (voiceId / matchedFrom / voiceState) are NOT touched: those have legitimate
   clear flows (unlink) and are already hydrated by denormaliseCastReusedVoices. */

import { describe, it, expect } from 'vitest';
import { preserveDesignedVoicesOnCastWrite } from './preserve-cast-voices.js';

type C = Record<string, unknown> & { id: string };

describe('preserveDesignedVoicesOnCastWrite', () => {
  it('fills a dropped overrideTtsVoices from the existing cast (the strip fix)', () => {
    const existing: C[] = [
      { id: 'berrin', name: 'Berrin', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'qwen-berrin' } } },
    ];
    const incoming: C[] = [{ id: 'berrin', name: 'Berrin', voiceState: 'generated' }]; // voiceless
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin' } });
  });

  it('lets a deliberate re-design win (incoming overrideTtsVoices present)', () => {
    const existing: C[] = [{ id: 'berrin', overrideTtsVoices: { qwen: { name: 'qwen-berrin' } } }];
    const incoming: C[] = [{ id: 'berrin', overrideTtsVoices: { qwen: { name: 'qwen-berrin-v2' } } }];
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-berrin-v2' } });
  });

  it('preserves ttsEngine and voiceStyle the same way', () => {
    const existing: C[] = [{ id: 'x', ttsEngine: 'qwen', voiceStyle: 'a warm voice' }];
    const incoming: C[] = [{ id: 'x' }];
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out[0].ttsEngine).toBe('qwen');
    expect(out[0].voiceStyle).toBe('a warm voice');
  });

  it('does NOT touch reuse-link fields (voiceId / matchedFrom / voiceState) — unlink must work', () => {
    const existing: C[] = [{ id: 'flori', voiceId: 'flori', matchedFrom: { bookId: 'u' }, voiceState: 'reused' }];
    const incoming: C[] = [{ id: 'flori' }]; // user unlinked → cleared
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out[0].voiceId).toBeUndefined();
    expect(out[0].matchedFrom).toBeUndefined();
    expect(out[0].voiceState).toBeUndefined();
  });

  it('keeps a new character (not in existing) untouched and carries fresh fields through', () => {
    const existing: C[] = [{ id: 'a', overrideTtsVoices: { qwen: { name: 'qwen-a' } } }];
    const incoming: C[] = [{ id: 'a', name: 'A', description: 'updated' }, { id: 'b', name: 'B' }];
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-a' } });
    expect(out[0].description).toBe('updated'); // fresh fields flow
    expect(out[1].overrideTtsVoices).toBeUndefined();
  });

  it('returns the incoming unchanged when there is no existing cast', () => {
    const incoming: C[] = [{ id: 'a' }];
    expect(preserveDesignedVoicesOnCastWrite([], incoming)).toEqual(incoming);
  });
});
