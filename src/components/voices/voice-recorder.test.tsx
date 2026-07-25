import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceRecorder } from './voice-recorder';

class FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'inactive';
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) }); this.onstop?.(); }
}

beforeEach(() => {
  (globalThis as any).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
});

it('records then emits a blob on stop', async () => {
  const onRecorded = vi.fn();
  render(<VoiceRecorder onRecorded={onRecorded} />);
  fireEvent.click(screen.getByRole('button', { name: /record/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /stop/i }));
  await waitFor(() => expect(onRecorded).toHaveBeenCalledWith(expect.any(Blob)));
});

it('shows a permission-denied fallback', async () => {
  (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(new Error('denied'));
  render(<VoiceRecorder onRecorded={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /record/i }));
  await waitFor(() => expect(screen.getByText(/mic/i)).toBeInTheDocument());
});
