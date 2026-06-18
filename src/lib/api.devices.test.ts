import { it, expect } from 'vitest';
import { ApiError } from './api';

it('ApiError carries a numeric status', () => {
  const e = new ApiError('nope', 401);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(401);
});
