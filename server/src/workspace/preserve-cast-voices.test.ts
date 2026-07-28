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
import { preserveDesignedVoicesOnCastWrite, rejectForeignCloneKeys } from './preserve-cast-voices.js';

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
    const existing: C[] = [{ id: 'wisp', voiceId: 'wisp', matchedFrom: { bookId: 'u' }, voiceState: 'reused' }];
    const incoming: C[] = [{ id: 'wisp' }]; // user unlinked → cleared
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

  /* [#1899] — voiceUuid (srv-43) is an immutable per-voice identity minted
     server-side only. Unlike PRESERVED_DESIGN_FIELDS' fill-the-gap fields
     above, the existing on-disk value must win even when incoming EXPLICITLY
     supplies a different one — that's the discriminating case: an ordinary
     "incoming omits the field" fixture can't tell this guard apart from the
     old fill-gap-only behaviour, since both would have left voiceUuid
     undefined either way (voiceUuid was never in PRESERVED_DESIGN_FIELDS to
     begin with). Only an explicit, differing incoming value proves the fix. */
  it('[#1899] always keeps the existing voiceUuid — a client cannot restamp an immutable identity', () => {
    const existing: C[] = [{ id: 'x', voiceUuid: 'real-uuid-owned-by-x' }];
    const incoming: C[] = [{ id: 'x', voiceUuid: 'attacker-supplied-uuid' }];
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out[0].voiceUuid).toBe('real-uuid-owned-by-x');
  });

  it('[#1899] fills voiceUuid from disk when incoming omits it too (not just a restamp guard)', () => {
    const existing: C[] = [{ id: 'x', voiceUuid: 'real-uuid-owned-by-x' }];
    const incoming: C[] = [{ id: 'x' }];
    const out = preserveDesignedVoicesOnCastWrite(existing, incoming);
    expect(out[0].voiceUuid).toBe('real-uuid-owned-by-x');
  });
});

describe('rejectForeignCloneKeys', () => {
  it('[#1899] throws when a character with no existing clone gets a foreign coqui libraryUuid planted', () => {
    const existing: C[] = [{ id: 'x', name: 'X' }]; // no clone at all today
    const incoming = [
      {
        id: 'x',
        name: 'X',
        overrideTtsVoices: {
          coqui: { name: 'xtts-victim-uuid', libraryUuid: 'victim-uuid', provenance: 'cloned' },
        },
      },
    ];
    expect(() => rejectForeignCloneKeys(existing, incoming)).toThrow(/doesn't match/);
  });

  it('[#1899] throws when a bare (no libraryUuid) coqui name is shaped like a foreign storage key', () => {
    /* Discriminating fixture: no libraryUuid at all — proves the guard also
       covers the direct name-as-storage-key path (voice-mapping.ts's
       slotName fallback), not just the libraryUuid-driven one. */
    const existing: C[] = [{ id: 'x', name: 'X' }];
    const incoming = [{ id: 'x', name: 'X', overrideTtsVoices: { coqui: { name: 'xtts-victim-uuid' } } }];
    expect(() => rejectForeignCloneKeys(existing, incoming)).toThrow(/doesn't match/);
  });

  it('[#1899] throws case-insensitively (NTFS/APFS lookups are case-insensitive)', () => {
    const existing: C[] = [{ id: 'x', name: 'X' }];
    const incoming = [{ id: 'x', name: 'X', overrideTtsVoices: { coqui: { name: 'XTTS-victim-uuid' } } }];
    expect(() => rejectForeignCloneKeys(existing, incoming)).toThrow(/doesn't match/);
  });

  it('[#1899] allows a coqui libraryUuid that matches the character\'s own existing one (unchanged round-trip)', () => {
    const existing: C[] = [
      { id: 'x', overrideTtsVoices: { coqui: { name: 'xtts-own-uuid', libraryUuid: 'own-uuid', provenance: 'cloned' } } },
    ];
    const incoming = [
      {
        id: 'x',
        overrideTtsVoices: { coqui: { name: 'xtts-own-uuid', libraryUuid: 'own-uuid', provenance: 'cloned' } },
      },
    ];
    expect(() => rejectForeignCloneKeys(existing, incoming)).not.toThrow();
  });

  it('[#1899] allows an ordinary catalog display name (no reserved prefix, no libraryUuid)', () => {
    const existing: C[] = [{ id: 'x' }];
    const incoming = [{ id: 'x', overrideTtsVoices: { coqui: { name: "Ana Florence" } } }];
    expect(() => rejectForeignCloneKeys(existing, incoming)).not.toThrow();
  });

  it('exempts a bare (no libraryUuid) qwen name — resolution never uses it, only voiceUuid does', () => {
    /* Preserves the existing "deliberate re-design, incoming wins" contract
       for qwen (see preserveDesignedVoicesOnCastWrite's sibling test) —
       pickVoiceForEngine's qwen branch always re-derives the storage key
       from the character's own (now voiceUuid-guarded) identity, never the
       name string, so a bare qwen name is not a live attack surface. */
    const existing: C[] = [{ id: 'x', overrideTtsVoices: { qwen: { name: 'qwen-berrin' } } }];
    const incoming = [{ id: 'x', overrideTtsVoices: { qwen: { name: 'qwen-berrin-v2' } } }];
    expect(() => rejectForeignCloneKeys(existing, incoming)).not.toThrow();
  });

  it('throws when a qwen libraryUuid IS present and differs from the character\'s own', () => {
    /* Unlike the bare-name case, a qwen libraryUuid DOES drive resolution
       directly (pickVoiceForEngine checks it before the name/uuid fallback),
       so it gets the same protection as coqui's. */
    const existing: C[] = [{ id: 'x', overrideTtsVoices: { qwen: { name: 'qwen-own', libraryUuid: 'own-uuid', provenance: 'cloned' } } }];
    const incoming = [
      {
        id: 'x',
        overrideTtsVoices: { qwen: { name: 'qwen-victim', libraryUuid: 'victim-uuid', provenance: 'cloned' } },
      },
    ];
    expect(() => rejectForeignCloneKeys(existing, incoming)).toThrow(/doesn't match/);
  });

  it('does not throw when overrideTtsVoices is absent or empty', () => {
    const existing: C[] = [{ id: 'x' }];
    expect(() => rejectForeignCloneKeys(existing, [{ id: 'x' }])).not.toThrow();
    expect(() => rejectForeignCloneKeys(existing, [{ id: 'x', overrideTtsVoices: {} }])).not.toThrow();
  });
});
