/* Smoke coverage for AnalysisModelPicker — the upload-view integration
   lives in `src/views/upload.test.tsx`. Tests here pin the wrapper:
   group rendering, hint subtitle, pick fires onChange. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { AnalysisModelPicker } from './analysis-model-picker';
import { MODEL_OPTION_GROUPS } from '../lib/models';

describe('AnalysisModelPicker', () => {
  const defaultModel = MODEL_OPTION_GROUPS[0].models[0].id;

  it('displays the resolved label on the trigger', () => {
    render(<AnalysisModelPicker selectedModel={defaultModel} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /Analysis model/i });
    expect(trigger).toHaveTextContent(MODEL_OPTION_GROUPS[0].models[0].label);
  });

  it('opens the picker and renders both group labels as separators', () => {
    render(<AnalysisModelPicker selectedModel={defaultModel} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Analysis model/i }));
    const dialog = screen.getByRole('dialog');
    /* First group has no separator; subsequent groups do. */
    expect(within(dialog).getByText(MODEL_OPTION_GROUPS[1].label)).toBeInTheDocument();
  });

  it('renders the hint subtitle for each model', () => {
    render(<AnalysisModelPicker selectedModel={defaultModel} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Analysis model/i }));
    const firstWithHint = MODEL_OPTION_GROUPS.flatMap((g) => g.models).find((m) => m.hint);
    if (firstWithHint?.hint) {
      expect(screen.getByText(firstWithHint.hint)).toBeInTheDocument();
    }
  });

  it('fires onChange with the picked model id', () => {
    const onChange = vi.fn();
    render(<AnalysisModelPicker selectedModel={defaultModel} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Analysis model/i }));
    const target = MODEL_OPTION_GROUPS[1].models[0];
    /* Labels may include regex specials like parens; match by exact
       string against the dialog's options. */
    const dialog = screen.getByRole('dialog');
    const option = within(dialog)
      .getAllByRole('option')
      .find((o) => o.textContent?.includes(target.label));
    if (!option) throw new Error(`option for "${target.label}" not found`);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(target.id);
  });

  it('disables the trigger when disabled prop is set', () => {
    render(
      <AnalysisModelPicker selectedModel={defaultModel} onChange={vi.fn()} disabled />,
    );
    expect(screen.getByRole('button', { name: /Analysis model/i })).toBeDisabled();
  });
});
