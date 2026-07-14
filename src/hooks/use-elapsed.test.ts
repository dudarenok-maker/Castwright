import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElapsed } from './use-elapsed';

afterEach(() => vi.useRealTimers());

describe('useElapsed', () => {
  it('returns 0 for undefined and ticks up from `since`', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { result, rerender } = renderHook(({ s }) => useElapsed(s), { initialProps: { s: undefined as number | undefined } });
    expect(result.current).toBe(0);
    rerender({ s: 10_000 });
    act(() => { vi.setSystemTime(13_000); vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(4);
  });
});
