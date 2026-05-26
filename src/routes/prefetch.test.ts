import { describe, it, expect } from 'vitest';
import { importGenerationView } from './prefetch';

/* The prefetch warms the Generate view's chunk before navigation. This guards
   that the shared import specifier still resolves the GenerationView module —
   a path typo here would silently no-op the prefetch (and, because the same
   thunk backs the React.lazy in routes/index.tsx, also break the route), with
   no behavioural test catching it since the view would still lazy-load. */
describe('importGenerationView', () => {
  it('resolves the module exposing GenerationView so the prefetch warms the right chunk', async () => {
    const mod = await importGenerationView();
    expect(typeof mod.GenerationView).toBe('function');
  });
});
