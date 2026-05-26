import { describe, it, expect } from 'vitest';
import { importGenerationView, importUploadView } from './prefetch';

/* The prefetch warms a route's chunk before navigation. These guard that the
   shared import specifiers still resolve the right module — a path typo here
   would silently no-op the prefetch (and, because the same thunk backs the
   React.lazy in routes/index.tsx, also break the route), with no behavioural
   test catching it since the view would still lazy-load. */
describe('importGenerationView', () => {
  it('resolves the module exposing GenerationView so the prefetch warms the right chunk', async () => {
    const mod = await importGenerationView();
    expect(typeof mod.GenerationView).toBe('function');
  });
});

describe('importUploadView', () => {
  it('resolves the module exposing UploadView so the prefetch warms the right chunk', async () => {
    const mod = await importUploadView();
    expect(typeof mod.UploadView).toBe('function');
  });
});
