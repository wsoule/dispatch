import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createRef } from 'react';

import { ToolbarBadge, ViewToolbar } from '../src/index';

afterEach(cleanup);

// ViewToolbar: Gr8r's list toolbar. Layout only; the search reports each
// keystroke and, separately, when it is final; busy marks the region and
// draws the progress rule.

function renderToolbar(
  overrides: Partial<Parameters<typeof ViewToolbar>[0]> = {}
) {
  const onChange = mock((_value: string) => {});
  const onCommit = mock((_value: string) => {});
  const view = render(
    <ViewToolbar
      search={{
        value: 'billing',
        onChange,
        onCommit,
        placeholder: 'Search issues',
        label: 'Search issues',
      }}
      controls={
        <>
          <button type="button">
            Filter <ToolbarBadge count={2} />
          </button>
          <button type="button">Sort: Weight</button>
        </>
      }
      end={<button type="button">Copy link</button>}
      {...overrides}
    />
  );
  return { view, onChange, onCommit };
}

describe('ViewToolbar', () => {
  test('a named group: search, the host controls, then the end actions', () => {
    const { view } = renderToolbar();
    const bar = view.getByRole('group', { name: 'View options' });
    const search = view.getByRole('searchbox', { name: 'Search issues' });
    expect((search as HTMLInputElement).value).toBe('billing');
    expect(search.getAttribute('placeholder')).toBe('Search issues');
    const names = [...bar.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['Filter 2', 'Sort: Weight', 'Copy link']);
    // The badge is decoration beside the trigger's own name.
    expect(bar.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  test('typing reports each change; Enter and leaving the field commit', () => {
    const { view, onChange, onCommit } = renderToolbar();
    const search = view.getByRole('searchbox', { name: 'Search issues' });
    fireEvent.change(search, { target: { value: 'billing m' } });
    expect(onChange).toHaveBeenCalledWith('billing m');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.blur(search);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  test('busy marks the region and draws the progress rule', () => {
    const { view } = renderToolbar();
    const bar = view.getByRole('group', { name: 'View options' });
    expect(bar.hasAttribute('aria-busy')).toBe(false);
    expect(bar.querySelectorAll(':scope > span').length).toBe(0);
    view.rerender(
      <ViewToolbar
        busy
        label="Issue list options"
        search={{
          value: '',
          onChange: () => undefined,
          placeholder: 'Search issues',
          label: 'Search issues',
        }}
        controls={null}
      />
    );
    const busy = view.getByRole('group', { name: 'Issue list options' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(
      busy.querySelectorAll(':scope > span[aria-hidden="true"]').length
    ).toBe(1);
  });

  test('inputRef hands the field to a host shortcut', () => {
    const ref = createRef<HTMLInputElement>();
    const { view } = renderToolbar({
      search: {
        value: '',
        onChange: () => undefined,
        placeholder: 'Search issues',
        label: 'Search issues',
        inputRef: ref,
      },
    });
    ref.current?.focus();
    expect(document.activeElement).toBe(
      view.getByRole('searchbox', { name: 'Search issues' })
    );
  });
});
