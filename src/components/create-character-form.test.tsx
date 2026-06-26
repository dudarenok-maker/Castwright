import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateCharacterForm } from './create-character-form';

it('pre-fills from initial proposed values', () => {
  render(<CreateCharacterForm initial={{ name: 'Ferra', gender: 'female' }} rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
  expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Ferra');
});

it('disables submit on an empty name', () => {
  render(<CreateCharacterForm rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: '  ' } });
  expect(screen.getByTestId('create-character-submit')).toBeDisabled();
});

it('routes a roster-name match to onReattributeExisting and never onSubmit', () => {
  const onSubmit = vi.fn();
  const onReattributeExisting = vi.fn();
  render(
    <CreateCharacterForm
      initial={{ name: 'Halloran' }}
      rosterByName={new Map([['halloran', { id: 'halloran', name: 'Halloran' }]])}
      onSubmit={onSubmit}
      onReattributeExisting={onReattributeExisting}
      onCancel={() => {}}
    />,
  );
  const submit = screen.getByTestId('create-character-submit');
  expect(submit).toHaveTextContent(/Reattribute to «Halloran»/);
  fireEvent.click(submit);
  expect(onReattributeExisting).toHaveBeenCalledWith('halloran');
  expect(onSubmit).not.toHaveBeenCalled();
});

it('routes a novel name to onSubmit and never onReattributeExisting', () => {
  const onSubmit = vi.fn();
  const onReattributeExisting = vi.fn();
  render(
    <CreateCharacterForm
      rosterByName={new Map([['halloran', { id: 'halloran', name: 'Halloran' }]])}
      onSubmit={onSubmit}
      onReattributeExisting={onReattributeExisting}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ferra' } });
  const submit = screen.getByTestId('create-character-submit');
  expect(submit).toHaveTextContent('Create character');
  fireEvent.click(submit);
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Ferra', gender: undefined, ageRange: undefined });
  expect(onReattributeExisting).not.toHaveBeenCalled();
});

it('gives both action buttons an explicit type="button"', () => {
  render(<CreateCharacterForm rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
  expect(screen.getByTestId('create-character-submit')).toHaveAttribute('type', 'button');
  expect(screen.getByRole('button', { name: /cancel/i })).toHaveAttribute('type', 'button');
});

describe('gender and ageRange selects', () => {
  it('renders gender select with all options and empty default', () => {
    render(<CreateCharacterForm rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
    const genderSelect = screen.getByLabelText(/gender/i) as HTMLSelectElement;
    expect(genderSelect).toBeInTheDocument();
    const options = Array.from(genderSelect.options).map((o) => o.value);
    expect(options).toContain('');
    expect(options).toContain('male');
    expect(options).toContain('female');
    expect(options).toContain('neutral');
    expect(genderSelect.value).toBe('');
  });

  it('renders ageRange select with all options and empty default', () => {
    render(<CreateCharacterForm rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
    const ageSelect = screen.getByLabelText(/age range/i) as HTMLSelectElement;
    expect(ageSelect).toBeInTheDocument();
    const options = Array.from(ageSelect.options).map((o) => o.value);
    expect(options).toContain('');
    expect(options).toContain('child');
    expect(options).toContain('teen');
    expect(options).toContain('adult');
    expect(options).toContain('elderly');
    expect(ageSelect.value).toBe('');
  });

  it('pre-fills gender from initial', () => {
    render(<CreateCharacterForm initial={{ name: 'Ferra', gender: 'female' }} rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
    const genderSelect = screen.getByLabelText(/gender/i) as HTMLSelectElement;
    expect(genderSelect.value).toBe('female');
  });

  it('pre-fills ageRange from initial', () => {
    render(<CreateCharacterForm initial={{ name: 'Ferra', ageRange: 'adult' }} rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
    const ageSelect = screen.getByLabelText(/age range/i) as HTMLSelectElement;
    expect(ageSelect.value).toBe('adult');
  });
});
