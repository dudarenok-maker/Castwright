import { describe, it, expectTypeOf } from 'vitest';
import type { paths, components } from './api-types';

describe('openapi: POST /voice-library/clone', () => {
  it('exposes the cloneVoice path returning a VoiceLibraryEntry', () => {
    type Op = paths['/voice-library/clone']['post'];
    type Body = Op['requestBody']['content']['application/json'];
    type Ok = Op['responses']['200']['content']['application/json'];
    expectTypeOf<Body>().toEqualTypeOf<components['schemas']['CloneVoiceRequest']>();
    expectTypeOf<Ok>().toEqualTypeOf<components['schemas']['VoiceLibraryEntry']>();
    expectTypeOf<components['schemas']['CloneVoiceRequest']['candidateId']>().toEqualTypeOf<string>();
  });
});
