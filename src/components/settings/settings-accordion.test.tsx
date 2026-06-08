import { describe, it, expect, vi } from 'vitest';
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

/* ─── SettingsAccordion wrapper ──────────────────────────────────────────── */

describe('SettingsAccordion', () => {
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
});
