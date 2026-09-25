import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { OPERATOR_ONLY } from './fields';
import { testConfig as config } from './fixtures.test-helper';
import { GeneralSection } from './GeneralSection';

// Every group is a 13px/600 sentence-case heading over its card; no uppercase labels.
test('the section headings are 13px semibold sentence case', () => {
  render(
    <GeneralSection
      config={config}
      onSave={() => Promise.resolve()}
      canOperate
    />
  );
  const headings = screen.getAllByRole('heading', { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual([
    'Board columns',
    'Pull requests',
  ]);
  for (const heading of headings) {
    expect(heading.className).toContain('text-[13px]');
    expect(heading.className).toContain('font-semibold');
    expect(heading.className).not.toContain('uppercase');
  }
});

test('an edited checkout folder saves on blur, and emptying it sends null', () => {
  const saved: unknown[] = [];
  const { rerender } = render(
    <GeneralSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
      canOperate
    />
  );
  const input = screen.getByLabelText('Checkout folder');
  fireEvent.change(input, { target: { value: '../pr' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ prWorktreeDir: '../pr' }]);

  rerender(
    <GeneralSection
      config={{ ...config, prWorktreeDir: '../pr' }}
      onSave={(p) => Promise.resolve(void saved.push(p))}
      canOperate
    />
  );
  fireEvent.change(input, { target: { value: '  ' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ prWorktreeDir: '../pr' }, { prWorktreeDir: null }]);
});

// The checkout folder decides where commands run, so it is the operator's call.
test('below the operator tier the checkout folder is read-only behind a lock', () => {
  render(
    <GeneralSection
      config={config}
      onSave={() => Promise.resolve()}
      canOperate={false}
    />
  );
  expect(screen.queryByRole('textbox', { name: 'Checkout folder' })).toBeNull();
  expect(screen.getAllByLabelText(OPERATOR_ONLY).length).toBeGreaterThan(0);
  expect(screen.queryByText(OPERATOR_ONLY)).toBeNull();
});
