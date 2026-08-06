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
import {
  CastVoiceConsentError,
  preserveClonedSlotsOnCastWrite,
  preserveDesignedVoicesOnCastWrite,
  preserveNotLinkedToOnCastWrite,
  rejectForeignCloneKeys,
} from './preserve-cast-voices.js';

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

/* [GATE 2 C-B1] — the erase/replace half of #1899's threat model. The guard
   above only inspects what a write ADDS; `preserveDesignedVoicesOnCastWrite`
   only restores a WHOLLY absent map. A present map that drops (or overwrites)
   a stored cloned slot passed both and was persisted with a 2xx — the clone
   marker gone from disk with no refusal, so the next render read a real
   person's lines in a catalogue voice.

   Each fixture below stores a CLONED coqui slot and varies only what the
   incoming map does with it, so nothing here can pass by accident: the
   omit case must come back carrying the stored slot, and the replace cases
   must throw. */
describe('preserveClonedSlotsOnCastWrite', () => {
  const clonedSlot = { name: 'xtts-real-person', libraryUuid: 'lib-123', provenance: 'cloned' };
  const storedCloned: C[] = [
    { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: { ...clonedSlot } } },
  ];

  it('[C-B1] restores a stored cloned slot the incoming map omits (present map, missing slot)', () => {
    const incoming = [{ id: 'wren', name: 'Wren', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } }];
    const out = preserveClonedSlotsOnCastWrite(storedCloned, incoming);
    expect(out[0].overrideTtsVoices).toEqual({
      qwen: { name: 'qwen-wren' },
      coqui: clonedSlot,
    });
  });

  it('[C-B1] refuses a catalogue name written over a stored cloned slot', () => {
    const incoming = [
      { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: { name: 'Ana Florence' } } },
    ];
    expect(() => preserveClonedSlotsOnCastWrite(storedCloned, incoming)).toThrow(
      CastVoiceConsentError,
    );
    expect(() => preserveClonedSlotsOnCastWrite(storedCloned, incoming)).toThrow(
      /consented cloned voice/,
    );
  });

  it('[C-B1] refuses a slot that keeps the name but strips the cloned provenance/libraryUuid', () => {
    /* The subtlest erase shape: the storage key still looks right, so a
       name-only comparison would wave it through — but with `provenance`
       gone the slot is no longer a clone marker to any downstream guard. */
    const incoming = [
      { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: { name: 'xtts-real-person' } } },
    ];
    expect(() => preserveClonedSlotsOnCastWrite(storedCloned, incoming)).toThrow(
      /consented cloned voice/,
    );
  });

  it('[C-B1] refuses a case-varied storage key rather than normalising it through', () => {
    /* NTFS/APFS resolve `XTTS-lib-123.pt` to the real artifact, so this
       renders — but it hashes to an audition cache scope and a sidecar
       latents key that revoke can never compute. Refuse, don't fold. */
    const incoming = [
      {
        id: 'wren',
        name: 'Wren',
        overrideTtsVoices: { coqui: { ...clonedSlot, name: 'XTTS-real-person' } },
      },
    ];
    expect(() => preserveClonedSlotsOnCastWrite(storedCloned, incoming)).toThrow(
      /consented cloned voice/,
    );
  });

  it('[C-B1] accepts an unchanged round-trip of the same cloned slot', () => {
    const incoming = [
      { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: { ...clonedSlot } } },
    ];
    const out = preserveClonedSlotsOnCastWrite(storedCloned, incoming);
    expect(out[0].overrideTtsVoices).toEqual({ coqui: clonedSlot });
  });

  it('[C-B1] protects a MALFORMED cloned slot too (fail-safe: provenance only, no uuid validation)', () => {
    /* The discriminating case between the fail-safe predicate this guard
       must use and the uuid-validating resolution predicates: with
       `clonedSlotForEngine` here, a cloned slot carrying no usable
       libraryUuid would read as "not cloned" and be silently erased. */
    const malformed: C[] = [
      { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: { name: 'xtts-x', provenance: 'cloned' } } },
    ];
    const incoming = [
      { id: 'wren', name: 'Wren', overrideTtsVoices: { coqui: { name: 'Ana Florence' } } },
    ];
    expect(() => preserveClonedSlotsOnCastWrite(malformed, incoming)).toThrow(
      /consented cloned voice/,
    );
  });

  it('[C-B1] leaves a DESIGNED slot on the existing incoming-wins contract', () => {
    const designed: C[] = [
      {
        id: 'wren',
        overrideTtsVoices: { coqui: { name: 'xtts-designed', libraryUuid: 'd-1', provenance: 'designed' } },
      },
    ];
    const incoming = [{ id: 'wren', overrideTtsVoices: { coqui: { name: 'Ana Florence' } } }];
    const out = preserveClonedSlotsOnCastWrite(designed, incoming);
    expect(out[0].overrideTtsVoices).toEqual({ coqui: { name: 'Ana Florence' } });
  });

  it('[C-B1] leaves a wholly-absent map to preserveDesignedVoicesOnCastWrite', () => {
    const incoming: C[] = [{ id: 'wren', name: 'Wren' }];
    const out = preserveClonedSlotsOnCastWrite(storedCloned, incoming);
    expect(out[0].overrideTtsVoices).toBeUndefined();
    /* …which then restores the whole map, cloned slot included. */
    expect(preserveDesignedVoicesOnCastWrite(storedCloned, out)[0].overrideTtsVoices).toEqual({
      coqui: clonedSlot,
    });
  });

  it('[C-B1] leaves a character that has no on-disk record untouched', () => {
    const incoming = [{ id: 'brand-new', overrideTtsVoices: { coqui: { name: 'Ana Florence' } } }];
    expect(() => preserveClonedSlotsOnCastWrite(storedCloned, incoming)).not.toThrow();
  });
});

/* #2166 — `notLinkedTo` is identity state written only by the dedicated
   reject / not-linked-to routes. The whole-roster cast PUT has no business
   carrying it: redux's merge prefers its own array over the server's, so a
   stale client would otherwise re-PUT edges the reconciliation just repaired. */
describe('preserveNotLinkedToOnCastWrite', () => {
  it('[P1] takes notLinkedTo from disk, discarding what the client sent', () => {
    const existing = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'x' }] }];
    const incoming = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'STALE' }] }];

    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[0].notLinkedTo).toEqual([
      { bookId: 'b1', characterId: 'x' },
    ]);
  });

  it('[P2] restores notLinkedTo the client dropped entirely', () => {
    const existing = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'x' }] }];
    const incoming: Array<{ id: string; notLinkedTo?: Array<{ bookId: string; characterId: string }> }> = [
      { id: 'a' },
    ];

    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[0].notLinkedTo).toEqual([
      { bookId: 'b1', characterId: 'x' },
    ]);
  });

  it('[P3] clears a client-invented notLinkedTo when disk has none', () => {
    const existing = [{ id: 'a' }];
    const incoming = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'invented' }] }];

    /* Absent on disk means absent after the write — otherwise the PUT is
       still a writer of this field, just a quieter one. */
    const out = preserveNotLinkedToOnCastWrite(existing, incoming);
    expect(out[0].notLinkedTo).toBeUndefined();
    /* Not merely undefined — the key must be GONE. `toBeUndefined()` alone
       passes for `{ notLinkedTo: undefined }`, and JSON.stringify drops both
       shapes identically, so no round-trip assertion can tell them apart
       either. This is the only place the distinction is observable. */
    expect(Object.prototype.hasOwnProperty.call(out[0], 'notLinkedTo')).toBe(false);
  });

  it('[P4] leaves a brand-new character alone', () => {
    const existing = [{ id: 'a' }];
    const incoming = [{ id: 'a' }, { id: 'b', notLinkedTo: [{ bookId: 'b1', characterId: 'y' }] }];

    /* No on-disk row to be authoritative, so nothing to restore or clear —
       same scope every sibling pass in this module uses. */
    expect(preserveNotLinkedToOnCastWrite(existing, incoming)[1].notLinkedTo).toEqual([
      { bookId: 'b1', characterId: 'y' },
    ]);
  });

  it('[P5] touches no other field', () => {
    const existing = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'x' }] }];
    const incoming = [{ id: 'a', name: 'Renamed', ttsEngine: 'qwen' }];
    const out = preserveNotLinkedToOnCastWrite(existing, incoming);

    expect(out[0].name).toBe('Renamed');
    expect(out[0].ttsEngine).toBe('qwen');
  });

  it('[P6] returns incoming untouched when there is no existing cast', () => {
    const incoming = [{ id: 'a', notLinkedTo: [{ bookId: 'b1', characterId: 'y' }] }];
    expect(preserveNotLinkedToOnCastWrite([], incoming)).toEqual(incoming);
  });
});
