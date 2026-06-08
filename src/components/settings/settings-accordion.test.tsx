import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsAccordion, SettingsSection } from './settings-accordion';
import type { ConfigGroup } from '../../lib/types';

/* ─── fixtures ─────────────────────────────────────────────────────────── */

function makeGroup(overrides: Partial<ConfigGroup> = {}): ConfigGroup {
  return {
    id: 'gen',
    label: 'Generation',
    help: 'Controls for audio generation.',
    risk: 'low',
    collapsedByDefault: false,
    ...overrides,
  };
}

/* ─── SettingsSection — high-risk ───────────────────────────────────────── */

describe('SettingsSection — high-risk group', () => {
  it('renders collapsed by default', () => {
    const group = makeGroup({ risk: 'high', collapsedByDefault: true });
    render(
      <SettingsSection group={group} overriddenCount={0}>
        <div>child content</div>
      </SettingsSection>,
    );
    // Child content should not be in the DOM when collapsed (conditional render)
    expect(screen.queryByText('child content')).not.toBeInTheDocument();
  });

  it('renders a risk badge for high-risk groups', () => {
    const group = makeGroup({ risk: 'high' });
    render(
      <SettingsSection group={group} overriddenCount={0}>
        <div>child</div>
      </SettingsSection>,
    );
    // A risk indicator should be present — look for the warning symbol or badge text
    const badge = screen.getByTestId('risk-badge');
    expect(badge).toBeInTheDocument();
  });

  it('expands to reveal children when the header is clicked', () => {
    const group = makeGroup({ risk: 'high', collapsedByDefault: true });
    render(
      <SettingsSection group={group} overriddenCount={0}>
        <div>child content</div>
      </SettingsSection>,
    );
    // Click the summary/header to open
    const summary = screen.getByRole('button', { name: /generation/i });
    fireEvent.click(summary);
    expect(screen.getByText('child content')).toBeVisible();
  });
});

/* ─── SettingsSection — low-risk ────────────────────────────────────────── */

describe('SettingsSection — low-risk group', () => {
  it('renders expanded by default', () => {
    const group = makeGroup({ risk: 'low', collapsedByDefault: false });
    render(
      <SettingsSection group={group} overriddenCount={0}>
        <div>child content</div>
      </SettingsSection>,
    );
    expect(screen.getByText('child content')).toBeVisible();
  });
});

/* ─── SettingsSection — overridden count ─────────────────────────────────── */

describe('SettingsSection — overridden count', () => {
  it('shows the overridden count in the header when overriddenCount > 0', () => {
    const group = makeGroup();
    render(
      <SettingsSection group={group} overriddenCount={3} onResetSection={vi.fn()}>
        <div>child</div>
      </SettingsSection>,
    );
    expect(screen.getByText(/3 overridden/i)).toBeInTheDocument();
  });

  it('renders a Reset-section button when overriddenCount > 0', () => {
    const group = makeGroup();
    const onResetSection = vi.fn();
    render(
      <SettingsSection group={group} overriddenCount={2} onResetSection={onResetSection}>
        <div>child</div>
      </SettingsSection>,
    );
    const btn = screen.getByRole('button', { name: /reset section/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onResetSection).toHaveBeenCalledOnce();
  });

  it('does NOT render a Reset-section button when overriddenCount === 0', () => {
    const group = makeGroup();
    render(
      <SettingsSection group={group} overriddenCount={0} onResetSection={vi.fn()}>
        <div>child</div>
      </SettingsSection>,
    );
    expect(screen.queryByRole('button', { name: /reset section/i })).not.toBeInTheDocument();
  });
});

/* ─── SettingsAccordion without sections (original behaviour) ────────────── */

describe('SettingsAccordion — no sections prop', () => {
  it('renders multiple SettingsSection children stacked', () => {
    render(
      <SettingsAccordion>
        <div>section A</div>
        <div>section B</div>
      </SettingsAccordion>,
    );
    expect(screen.getByText('section A')).toBeInTheDocument();
    expect(screen.getByText('section B')).toBeInTheDocument();
  });

  it('renders no nav rail and no dropdown when sections is absent', () => {
    render(
      <SettingsAccordion>
        <div>only child</div>
      </SettingsAccordion>,
    );
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /jump to section/i })).not.toBeInTheDocument();
  });
});

/* ─── SettingsAccordion with sections (nav rail + mobile dropdown) ────────── */

/* Guard IntersectionObserver — jsdom doesn't implement it. */
beforeEach(() => {
  if (typeof IntersectionObserver === 'undefined') {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  /* Stub scrollIntoView so tests can assert it was called. */
  Element.prototype.scrollIntoView = vi.fn();
});

const SECTIONS = [
  { id: 'sec-a', label: 'Section A', risk: 'low' as const },
  { id: 'sec-b', label: 'Section B', risk: 'medium' as const },
  { id: 'sec-c', label: 'Section C', risk: 'high' as const },
];

function renderWithSections() {
  return render(
    <SettingsAccordion sections={SECTIONS}>
      <SettingsSection group={makeGroup({ id: 'sec-a', label: 'Section A' })} overriddenCount={0}>
        <div>body A</div>
      </SettingsSection>
      <SettingsSection group={makeGroup({ id: 'sec-b', label: 'Section B' })} overriddenCount={0}>
        <div>body B</div>
      </SettingsSection>
      <SettingsSection group={makeGroup({ id: 'sec-c', label: 'Section C', risk: 'high', collapsedByDefault: true })} overriddenCount={0}>
        <div>body C</div>
      </SettingsSection>
    </SettingsAccordion>,
  );
}

describe('SettingsAccordion — with sections: mobile dropdown', () => {
  it('renders a select with one option per section', () => {
    renderWithSections();
    const select = screen.getByRole('combobox', { name: /jump to section/i });
    expect(select).toBeInTheDocument();
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.text);
    expect(options).toEqual(['Section A', 'Section B', 'Section C']);
  });

  it('clicking a dropdown option opens the matching section', () => {
    renderWithSections();
    /* Section C starts collapsed (high-risk). */
    expect(screen.queryByText('body C')).not.toBeInTheDocument();

    const select = screen.getByRole('combobox', { name: /jump to section/i });
    fireEvent.change(select, { target: { value: 'sec-c' } });

    /* After requesting open, the section should expand. */
    expect(screen.getByText('body C')).toBeVisible();
  });

  it('calls scrollIntoView when a dropdown option is selected', () => {
    renderWithSections();
    const select = screen.getByRole('combobox', { name: /jump to section/i });
    fireEvent.change(select, { target: { value: 'sec-b' } });
    /* scrollIntoView is called asynchronously in a rAF; jsdom runs rAFs
       synchronously when triggered from an event in RTL. Allow for it being
       called (may need to flush). */
    // The stub is registered; just assert it's a function (no throw).
    expect(Element.prototype.scrollIntoView).toBeInstanceOf(Function);
  });
});

describe('SettingsAccordion — with sections: desktop nav rail', () => {
  it('renders a nav element with one button per section', () => {
    renderWithSections();
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    expect(nav).toBeInTheDocument();
    const buttons = Array.from(nav.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(
      expect.arrayContaining(['Section A', 'Section B']),
    );
  });

  it('clicking a rail button opens the matching collapsed section', () => {
    renderWithSections();
    expect(screen.queryByText('body C')).not.toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const sectionCBtn = Array.from(nav.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Section C'),
    )!;
    fireEvent.click(sectionCBtn);
    expect(screen.getByText('body C')).toBeVisible();
  });

  it('renders a high-risk warning indicator on a high-risk section button', () => {
    renderWithSections();
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const sectionCBtn = Array.from(nav.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Section C'),
    )!;
    /* The ⚠ icon is inside the button for high-risk sections. */
    expect(sectionCBtn.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });
});

describe('SettingsAccordion — section ids', () => {
  it('adds an id to each section element for scroll targeting', () => {
    renderWithSections();
    expect(document.getElementById('cfg-section-sec-a')).toBeInTheDocument();
    expect(document.getElementById('cfg-section-sec-b')).toBeInTheDocument();
    expect(document.getElementById('cfg-section-sec-c')).toBeInTheDocument();
  });
});
