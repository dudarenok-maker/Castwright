// Pairs with the pre-generation "Choose voice model" prompt (P3).

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StartGenerationModal } from './start-generation';

describe('StartGenerationModal — 1.7B gated on installed weights (#1841)', () => {
  it('disables the 1.7B tier when its weights are not installed', () => {
    render(
      <StartGenerationModal
        defaultTier="qwen3-tts-0.6b"
        qwen17bInstalled={false}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    const tier = screen.getByRole('button', { name: /1\.7B/i }) as HTMLButtonElement;
    expect(tier.disabled).toBe(true);
    expect(screen.getByText(/not downloaded/i)).toBeTruthy();
  });

  it('falls back to 0.6B when the cast is pinned to an uninstalled 1.7B', () => {
    /* Guard rail: layout passes defaultTier='qwen3-tts-1.7b' whenever any cast
       member is pinned there, which can outlive the weights being removed. */
    const onConfirm = vi.fn();
    render(
      <StartGenerationModal
        defaultTier="qwen3-tts-1.7b"
        qwen17bInstalled={false}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(onConfirm).toHaveBeenCalledWith('qwen3-tts-0.6b');
  });

  /* Forward-regression test, not proof the gate works: this passed before the
     gate was added (tier button had no disabled attribute at all), so its
     enabled state is not evidence. The real proof is the sibling disabled and
     guard-rail tests. This test's value is forward-only: it stops a future
     change from disabling 1.7B when the weights are in fact present. */
  it('leaves 1.7B selectable when the weights are present', () => {
    render(
      <StartGenerationModal
        defaultTier="qwen3-tts-0.6b"
        qwen17bInstalled
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(
      (screen.getByRole('button', { name: /1\.7B/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
