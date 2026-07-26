/* Shared clone-engine vocabulary — pure helpers for working with cloned voices
   across Qwen and Coqui engines. Used by six later tasks to avoid reimplementing
   the same manifest-slot mapping, storage-key prefixing, and cloned-vs-designed
   logic independently. */

import { describe, it, expect } from 'vitest';
import {
  CLONE_CAPABLE_ENGINES,
  isCloneEngine,
  manifestSlotFor,
  cloneStorageKey,
  characterHasClonedSlot,
  clonedSlotForEngine,
} from './clone-engines.js';

describe('clone-engines vocabulary', () => {
  describe('CloneEngine type guards and constants', () => {
    it('CLONE_CAPABLE_ENGINES is a Set containing qwen and coqui', () => {
      expect(CLONE_CAPABLE_ENGINES).toBeInstanceOf(Set);
      expect(CLONE_CAPABLE_ENGINES.size).toBe(2);
      expect(CLONE_CAPABLE_ENGINES.has('qwen')).toBe(true);
      expect(CLONE_CAPABLE_ENGINES.has('coqui')).toBe(true);
    });

    it('isCloneEngine identifies qwen and coqui as clone engines', () => {
      expect(isCloneEngine('qwen')).toBe(true);
      expect(isCloneEngine('coqui')).toBe(true);
    });

    it('isCloneEngine rejects other engines', () => {
      expect(isCloneEngine('kokoro')).toBe(false);
      expect(isCloneEngine('piper')).toBe(false);
      expect(isCloneEngine('gemini')).toBe(false);
    });
  });

  describe('manifestSlotFor maps clone engines to manifest slot keys', () => {
    it('qwen maps to qwen slot', () => {
      expect(manifestSlotFor('qwen')).toBe('qwen');
    });

    it('coqui maps to xtts slot', () => {
      expect(manifestSlotFor('coqui')).toBe('xtts');
    });
  });

  describe('cloneStorageKey produces prefixed storage keys', () => {
    it('qwen produces qwen-<uuid> key', () => {
      const key = cloneStorageKey('qwen', 'abc123');
      expect(key).toBe('qwen-abc123');
    });

    it('coqui produces xtts-<uuid> key', () => {
      const key = cloneStorageKey('coqui', 'def456');
      expect(key).toBe('xtts-def456');
    });

    it('preserves full uuid including dashes', () => {
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect(cloneStorageKey('qwen', uuid)).toBe(`qwen-${uuid}`);
      expect(cloneStorageKey('coqui', uuid)).toBe(`xtts-${uuid}`);
    });
  });

  describe('characterHasClonedSlot detects cloned voices', () => {
    it('returns true for a cloned qwen slot', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-cloned-voice',
            libraryUuid: 'voice-uuid-1',
            provenance: 'cloned' as const,
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(true);
    });

    it('returns true for a cloned coqui slot', () => {
      const character = {
        overrideTtsVoices: {
          coqui: {
            name: 'Cloned Voice',
            libraryUuid: 'voice-uuid-2',
            provenance: 'cloned' as const,
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(true);
    });

    it('returns true when either engine has a cloned slot', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-cloned',
            libraryUuid: 'uuid-1',
            provenance: 'cloned' as const,
          },
          coqui: {
            name: 'Coqui Voice',
            libraryUuid: 'uuid-2',
            provenance: 'designed' as const,
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(true);
    });

    it('returns false for a designed slot with libraryUuid', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-designed-voice',
            libraryUuid: 'library-uuid',
            provenance: 'designed' as const,
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(false);
    });

    it('returns false for an imported slot', () => {
      const character = {
        overrideTtsVoices: {
          coqui: {
            name: 'Imported Voice',
            libraryUuid: 'import-uuid',
            provenance: 'imported' as const,
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(false);
    });

    it('returns false when no overrideTtsVoices field exists', () => {
      const character = {};
      expect(characterHasClonedSlot(character)).toBe(false);
    });

    it('returns false when overrideTtsVoices is null', () => {
      const character = { overrideTtsVoices: null };
      expect(characterHasClonedSlot(character)).toBe(false);
    });

    it('returns false when overrideTtsVoices is empty', () => {
      const character = { overrideTtsVoices: {} };
      expect(characterHasClonedSlot(character)).toBe(false);
    });

    it('returns false when a slot has no provenance field', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'voice',
            libraryUuid: 'uuid',
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(false);
    });

    it('returns false when provenance is undefined', () => {
      const character = {
        overrideTtsVoices: {
          coqui: {
            name: 'voice',
            libraryUuid: 'uuid',
            provenance: undefined,
          },
        },
      };
      expect(characterHasClonedSlot(character)).toBe(false);
    });
  });

  describe('clonedSlotForEngine extracts cloned slot for engine', () => {
    it('returns the cloned slot for qwen when present', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-cloned',
            libraryUuid: 'qwen-uuid-1',
            provenance: 'cloned' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'qwen');
      expect(result).toEqual({ libraryUuid: 'qwen-uuid-1' });
    });

    it('returns the cloned slot for coqui when present', () => {
      const character = {
        overrideTtsVoices: {
          coqui: {
            name: 'Cloned Voice',
            libraryUuid: 'coqui-uuid-2',
            provenance: 'cloned' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'coqui');
      expect(result).toEqual({ libraryUuid: 'coqui-uuid-2' });
    });

    it('returns undefined for a designed slot', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-designed',
            libraryUuid: 'uuid',
            provenance: 'designed' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'qwen');
      expect(result).toBeUndefined();
    });

    it('returns undefined for an imported slot', () => {
      const character = {
        overrideTtsVoices: {
          coqui: {
            name: 'Imported',
            libraryUuid: 'uuid',
            provenance: 'imported' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'coqui');
      expect(result).toBeUndefined();
    });

    it('returns undefined when engine slot is absent', () => {
      const character = {
        overrideTtsVoices: {
          coqui: {
            name: 'Some Voice',
            libraryUuid: 'uuid',
            provenance: 'cloned' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'qwen');
      expect(result).toBeUndefined();
    });

    it('returns undefined when overrideTtsVoices is absent', () => {
      const character = {};
      const result = clonedSlotForEngine(character, 'qwen');
      expect(result).toBeUndefined();
    });

    it('returns undefined when overrideTtsVoices is null', () => {
      const character = { overrideTtsVoices: null };
      const result = clonedSlotForEngine(character, 'coqui');
      expect(result).toBeUndefined();
    });

    it('returns undefined for non-clone engines', () => {
      const character = {
        overrideTtsVoices: {
          kokoro: {
            name: 'Kokoro Voice',
            libraryUuid: 'uuid',
            provenance: 'cloned' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'kokoro');
      expect(result).toBeUndefined();
    });

    it('returns undefined when slot has no libraryUuid', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-voice',
            provenance: 'cloned' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'qwen');
      expect(result).toBeUndefined();
    });

    it('returns undefined when libraryUuid is not a string', () => {
      const character = {
        overrideTtsVoices: {
          qwen: {
            name: 'qwen-voice',
            libraryUuid: 123,
            provenance: 'cloned' as const,
          },
        },
      };
      const result = clonedSlotForEngine(character, 'qwen');
      expect(result).toBeUndefined();
    });
  });
});
