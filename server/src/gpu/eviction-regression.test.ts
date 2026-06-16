import { it, expect, vi, beforeEach } from 'vitest';

const events: string[] = [];
const busy = { value: false };

vi.mock('./vram-state.js', () => ({
  getLastKnownVram: () => ({ accelerator: 'cuda', totalMb: 8188 }),
}));
vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: () => busy.value }));
vi.mock('./residency.js', () => ({
  shouldEvictBeforeSidecarLoad: (v: { totalMb: number | null }) =>
    v.totalMb != null && v.totalMb < 11000,
}));
vi.mock('../routes/ollama-health.js', () => ({
  unloadResidentOllama: vi.fn(async () => {
    events.push('evict');
    return ['qwen3.5:9b'];
  }),
  verifyOllamaEvicted: vi.fn(async () => {
    events.push('verify');
    return true;
  }),
}));

beforeEach(() => {
  events.length = 0;
  busy.value = false;
});

it('on 8 GB idle: evict → verify → load, in order', async () => {
  const { withGpuLoad } = await import('./gpu-load.js');
  await withGpuLoad(async () => {
    events.push('load');
  });
  expect(events).toEqual(['evict', 'verify', 'load']);
});

it('on 8 GB with analysis busy: REFUSES (GpuBusyError), never evicts or loads', async () => {
  busy.value = true;
  const { withGpuLoad, GpuBusyError } = await import('./gpu-load.js');
  await expect(
    withGpuLoad(async () => {
      events.push('load');
    }),
  ).rejects.toBeInstanceOf(GpuBusyError);
  expect(events).toEqual([]); // no evict, no load
});
