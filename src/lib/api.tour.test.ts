import { describe, it, expect, beforeEach } from 'vitest';
import { mockGetTourStatus, mockCompleteTour, _resetMockTour } from './api';

describe('tour api (mock fns)', () => {
  beforeEach(() => _resetMockTour());
  it('mockGetTourStatus returns { completedAt: null } initially', async () => {
    expect(await mockGetTourStatus()).toEqual({ completedAt: null });
  });
  it('mockCompleteTour stamps completedAt and the getter reflects it', async () => {
    const { completedAt } = await mockCompleteTour();
    expect(typeof completedAt).toBe('string');
    expect((await mockGetTourStatus()).completedAt).toBe(completedAt);
  });
});
