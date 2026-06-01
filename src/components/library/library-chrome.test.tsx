/* LibraryChrome — search input + tag-chip filter row coverage for
   plan 73. The orchestrator owns the state; this test exercises the
   purely-presentational wiring against passed-in callbacks. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LibraryChrome } from './library-chrome';

function renderChrome(
  overrides: Partial<Parameters<typeof LibraryChrome>[0]> = {},
) {
  const defaults: Parameters<typeof LibraryChrome>[0] = {
    firstName: 'Mike',
    workspace: null,
    totals: { books: 4, runtime: 0, voices: 12, inProgress: 2 },
    filter: 'all',
    setFilter: vi.fn(),
    filters: [
      { id: 'all', label: 'All (4)' },
      { id: 'in_progress', label: 'In progress (2)' },
      { id: 'complete', label: 'Complete (1)' },
    ],
    viewMode: 'card',
    setViewMode: vi.fn(),
    onStartNew: vi.fn(),
    search: '',
    setSearch: vi.fn(),
    allTags: ['draft', 'favourite', 'series-1'],
    activeTags: [],
    toggleTag: vi.fn(),
    presentLanguages: ['en'],
    activeLanguages: [],
    toggleLanguage: vi.fn(),
    clearFilters: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  return { props, ...render(<LibraryChrome {...props} />) };
}

describe('LibraryChrome — search input (plan 73)', () => {
  it('renders the search input with the controlled value', () => {
    renderChrome({ search: 'northern' });
    const input = screen.getByTestId('library-search-input') as HTMLInputElement;
    expect(input.value).toBe('northern');
  });

  it('fires setSearch on every keystroke (debounce is the orchestrator\'s job)', () => {
    const setSearch = vi.fn();
    renderChrome({ setSearch });
    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: 'star' } });
    expect(setSearch).toHaveBeenCalledWith('star');
  });
});

describe('LibraryChrome — tag-chip row (plan 73)', () => {
  it('renders one chip per tag in allTags', () => {
    renderChrome();
    expect(screen.getByTestId('library-tag-chip-row')).toBeInTheDocument();
    expect(screen.getByTestId('tag-filter-chip-draft')).toBeInTheDocument();
    expect(screen.getByTestId('tag-filter-chip-favourite')).toBeInTheDocument();
    expect(screen.getByTestId('tag-filter-chip-series-1')).toBeInTheDocument();
  });

  it('omits the row entirely when allTags is empty', () => {
    renderChrome({ allTags: [] });
    expect(screen.queryByTestId('library-tag-chip-row')).not.toBeInTheDocument();
  });

  it('marks active chips with aria-pressed=true', () => {
    renderChrome({ activeTags: ['favourite'] });
    expect(screen.getByTestId('tag-filter-chip-favourite')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tag-filter-chip-draft')).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires toggleTag when a chip is clicked', () => {
    const toggleTag = vi.fn();
    renderChrome({ toggleTag });
    fireEvent.click(screen.getByTestId('tag-filter-chip-favourite'));
    expect(toggleTag).toHaveBeenCalledWith('favourite');
  });
});

describe('LibraryChrome — language-chip row (fe-16)', () => {
  it('omits the row when only one language is present', () => {
    renderChrome({ presentLanguages: ['en'] });
    expect(screen.queryByTestId('library-language-chip-row')).not.toBeInTheDocument();
  });

  it('renders one pill per language with human labels when >1 language is present', () => {
    renderChrome({ presentLanguages: ['en', 'ru'] });
    expect(screen.getByTestId('library-language-chip-row')).toBeInTheDocument();
    expect(screen.getByTestId('language-filter-chip-en')).toHaveTextContent('English');
    expect(screen.getByTestId('language-filter-chip-ru')).toHaveTextContent('Русский');
  });

  it('marks the active language pill with aria-pressed=true', () => {
    renderChrome({ presentLanguages: ['en', 'ru'], activeLanguages: ['ru'] });
    expect(screen.getByTestId('language-filter-chip-ru')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('language-filter-chip-en')).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires toggleLanguage when a pill is clicked', () => {
    const toggleLanguage = vi.fn();
    renderChrome({ presentLanguages: ['en', 'ru'], toggleLanguage });
    fireEvent.click(screen.getByTestId('language-filter-chip-ru'));
    expect(toggleLanguage).toHaveBeenCalledWith('ru');
  });

  it('shows the clear-filters affordance when a language is active', () => {
    renderChrome({ presentLanguages: ['en', 'ru'], activeLanguages: ['ru'] });
    expect(screen.getByTestId('library-clear-filters')).toBeInTheDocument();
  });
});

describe('LibraryChrome — clear-filters affordance (plan 73)', () => {
  it('is hidden when no search or tags are active', () => {
    renderChrome();
    expect(screen.queryByTestId('library-clear-filters')).not.toBeInTheDocument();
  });
  it('appears when search is non-empty', () => {
    renderChrome({ search: 'x' });
    expect(screen.getByTestId('library-clear-filters')).toBeInTheDocument();
  });
  it('appears when at least one tag is active', () => {
    renderChrome({ activeTags: ['favourite'] });
    expect(screen.getByTestId('library-clear-filters')).toBeInTheDocument();
  });
  it('fires clearFilters on click', () => {
    const clearFilters = vi.fn();
    renderChrome({ activeTags: ['favourite'], clearFilters });
    fireEvent.click(screen.getByTestId('library-clear-filters'));
    expect(clearFilters).toHaveBeenCalled();
  });
});
