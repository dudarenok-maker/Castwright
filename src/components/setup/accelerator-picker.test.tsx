import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AcceleratorPicker } from './accelerator-picker';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { putConfig: vi.fn(async () => ({ ok: true, applied: ['tts.accelerator'], values: {} })) },
}));

const putConfig = api.putConfig as unknown as ReturnType<typeof vi.fn>;

describe('AcceleratorPicker', () => {
  beforeEach(() => putConfig.mockClear());

  it('offers auto/nvidia/amd/cpu and defaults to auto', () => {
    render(<AcceleratorPicker />);
    const select = screen.getByLabelText('GPU accelerator') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'nvidia', 'amd', 'cpu']);
  });

  it('persists the chosen profile to the tts.accelerator override', async () => {
    render(<AcceleratorPicker />);
    fireEvent.change(screen.getByLabelText('GPU accelerator'), { target: { value: 'amd' } });
    await waitFor(() => expect(putConfig).toHaveBeenCalledWith({ 'tts.accelerator': 'amd' }));
  });

  it('surfaces a save error without crashing', async () => {
    putConfig.mockRejectedValueOnce(new Error('boom'));
    render(<AcceleratorPicker />);
    fireEvent.change(screen.getByLabelText('GPU accelerator'), { target: { value: 'cpu' } });
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });
});
