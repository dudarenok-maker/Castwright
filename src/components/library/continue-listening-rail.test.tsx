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

const noop = () => {};

describe('ContinueListeningRail', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(
      <ContinueListeningRail items={[]} onOpen={noop} onFinish={noop} onHide={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a card per item with title and chapter/time caption', () => {
    const items = [
      item({ bookId: 'b1', title: 'The Coalfall Commission', chapterId: 3, remainingSec: 3600 }),
      item({ bookId: 'b2', title: 'Another Book', chapterId: 1, remainingSec: 300 }),
    ];
    render(<ContinueListeningRail items={items} onOpen={noop} onFinish={noop} onHide={noop} />);

    expect(screen.getByText('The Coalfall Commission')).toBeInTheDocument();
    expect(screen.getByText('Another Book')).toBeInTheDocument();
    expect(screen.getByText(/Ch 3/)).toBeInTheDocument();
    expect(screen.getByText(/Ch 1/)).toBeInTheDocument();
  });

  it('calls onOpen with the correct bookId and chapterId when a card is clicked', () => {
    const onOpen = vi.fn();
    const items = [
      item({ bookId: 'book-alpha', chapterId: 5 }),
      item({ bookId: 'book-beta', chapterId: 2, title: 'Book Beta' }),
    ];
    render(<ContinueListeningRail items={items} onOpen={onOpen} onFinish={noop} onHide={noop} />);

    // The card's accessible name is "Continue listening to {title}"; the ⋯
    // button's title-free label keeps these queries unambiguous.
    fireEvent.click(screen.getByRole('button', { name: /Continue listening to The Coalfall Commission/i }));
    expect(onOpen).toHaveBeenCalledWith('book-alpha', 5);

    fireEvent.click(screen.getByRole('button', { name: /Continue listening to Book Beta/i }));
    expect(onOpen).toHaveBeenCalledWith('book-beta', 2);

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('renders the section heading when items are present', () => {
    render(<ContinueListeningRail items={[item()]} onOpen={noop} onFinish={noop} onHide={noop} />);
    expect(screen.getByText(/continue listening/i)).toBeInTheDocument();
  });

  it('applies the theme-aware thin scrollbar to the scroll strip', () => {
    const { container } = render(
      <ContinueListeningRail items={[item()]} onOpen={noop} onFinish={noop} onHide={noop} />,
    );
    expect(container.querySelector('.scrollbar-thin')).not.toBeNull();
  });
});

describe('ContinueListeningRail — covers', () => {
  it('renders the cover image when a URL is supplied', () => {
    const { container } = render(
      <ContinueListeningRail
        items={[item({ bookId: 'b1' })]}
        covers={{ b1: '/api/books/b1/cover' }}
        onOpen={noop}
        onFinish={noop}
        onHide={noop}
      />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/api/books/b1/cover');
  });

  it('falls back to the gradient placeholder when no cover URL is supplied', () => {
    const { container } = render(
      <ContinueListeningRail items={[item({ bookId: 'b1' })]} onOpen={noop} onFinish={noop} onHide={noop} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the gradient when the cover image errors', () => {
    const { container } = render(
      <ContinueListeningRail
        items={[item({ bookId: 'b1' })]}
        covers={{ b1: '/api/books/b1/cover' }}
        onOpen={noop}
        onFinish={noop}
        onHide={noop}
      />,
    );
    const img = container.querySelector('img')!;
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('ContinueListeningRail — finish / hide menu', () => {
  it('opens the ⋯ menu and fires onFinish with the bookId', () => {
    const onFinish = vi.fn();
    render(
      <ContinueListeningRail
        items={[item({ bookId: 'book-x' })]}
        onOpen={noop}
        onFinish={onFinish}
        onHide={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue-listening options/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Mark as finished/i }));
    expect(onFinish).toHaveBeenCalledWith('book-x');
  });

  it('fires onHide with the bookId from the menu', () => {
    const onHide = vi.fn();
    render(
      <ContinueListeningRail
        items={[item({ bookId: 'book-y' })]}
        onOpen={noop}
        onFinish={noop}
        onHide={onHide}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue-listening options/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Hide from shelf/i }));
    expect(onHide).toHaveBeenCalledWith('book-y');
  });

  it('closes the menu on Escape', () => {
    render(
      <ContinueListeningRail items={[item({ bookId: 'b1' })]} onOpen={noop} onFinish={noop} onHide={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue-listening options/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
