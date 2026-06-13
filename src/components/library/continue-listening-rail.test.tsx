import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContinueListeningRail } from './continue-listening-rail';
import type { ContinueItem } from '../../store/continue-listening-slice';

const item = (over: Partial<ContinueItem> = {}): ContinueItem => ({
  bookId: 'b1',
  title: 'The Coalfall Commission',
  chapterId: 3,
  currentSec: 120,
  remainingSec: 3600,
  completionPct: 0.25,
  updatedAt: '2026-06-13T10:00:00.000Z',
  ...over,
});

describe('ContinueListeningRail', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(
      <ContinueListeningRail items={[]} onOpen={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a card per item with title and chapter/time caption', () => {
    const items = [
      item({ bookId: 'b1', title: 'The Coalfall Commission', chapterId: 3, remainingSec: 3600 }),
      item({ bookId: 'b2', title: 'Another Book', chapterId: 1, remainingSec: 300 }),
    ];
    render(<ContinueListeningRail items={items} onOpen={() => {}} />);

    expect(screen.getByText('The Coalfall Commission')).toBeInTheDocument();
    expect(screen.getByText('Another Book')).toBeInTheDocument();

    // Captions: "Ch N · HH:MM:SS left" or "Ch N · MM:SS left"
    expect(screen.getByText(/Ch 3/)).toBeInTheDocument();
    expect(screen.getByText(/Ch 1/)).toBeInTheDocument();
  });

  it('calls onOpen with the correct bookId and chapterId when a card is clicked', () => {
    const onOpen = vi.fn();
    const items = [
      item({ bookId: 'book-alpha', chapterId: 5 }),
      item({ bookId: 'book-beta', chapterId: 2, title: 'Book Beta' }),
    ];
    render(<ContinueListeningRail items={items} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button', { name: /book-alpha|The Coalfall Commission/i }));
    expect(onOpen).toHaveBeenCalledWith('book-alpha', 5);

    fireEvent.click(screen.getByRole('button', { name: /Book Beta/i }));
    expect(onOpen).toHaveBeenCalledWith('book-beta', 2);

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('renders the section heading when items are present', () => {
    render(<ContinueListeningRail items={[item()]} onOpen={() => {}} />);
    expect(screen.getByText(/continue listening/i)).toBeInTheDocument();
  });
});
