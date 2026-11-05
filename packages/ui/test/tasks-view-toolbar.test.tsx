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

  // A toolbar of controls only (Runs, Usage): no field of any kind, the
  // host controls and the end actions in order, the group still named.
  test('without search there is no field: the controls and end render alone', () => {
    const view = render(
      <ViewToolbar
        controls={
          <div role="radiogroup" aria-label="State">
            <button type="button" role="radio" aria-checked="true">
              All
            </button>
            <button type="button" role="radio" aria-checked="false">
              Live
            </button>
          </div>
        }
        end={<button type="button">Show archived (2)</button>}
      />
    );
    const bar = view.getByRole('group', { name: 'View options' });
    expect(view.queryByRole('searchbox')).toBeNull();
    expect(view.queryByRole('textbox')).toBeNull();
    expect(bar.querySelector('input')).toBeNull();
    expect(view.getByRole('radiogroup', { name: 'State' })).not.toBeNull();
    const names = [...bar.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['All', 'Live', 'Show archived (2)']);
    // The controls are the bar's first child: nothing stands before them.
    expect(bar.firstElementChild?.contains(view.getByText('All'))).toBe(true);
    expect(bar.hasAttribute('aria-busy')).toBe(false);
    // The end actions are the bar's own second cell, outside the controls'
    // sideways scroller, so on a phone they take a row of their own instead
    // of sitting off-screen in a scroller that draws no scrollbar.
    const end = view.getByRole('button', { name: 'Show archived (2)' });
    expect(bar.children).toHaveLength(2);
    expect(bar.children[1]?.contains(end)).toBe(true);
    expect(bar.firstElementChild?.contains(end)).toBe(false);
  });

  // With a search the end actions stay inside the controls cell, scrolling
  // sideways with them on a phone, as before.
  test('with search the end actions sit inside the controls cell', () => {
    const { view } = renderToolbar();
    const bar = view.getByRole('group', { name: 'View options' });
    const end = view.getByRole('button', { name: 'Copy link' });
    const controls = view.getByRole('button', {
      name: 'Sort: Weight',
    }).parentElement;
    expect(controls?.contains(end)).toBe(true);
    expect(bar.children).toHaveLength(2);
  });

  test('without search the label and busy rule still apply', () => {
    const view = render(
      <ViewToolbar
        busy
        label="Run filters"
        controls={<button type="button">All</button>}
      />
    );
    const bar = view.getByRole('group', { name: 'Run filters' });
    expect(bar.getAttribute('aria-busy')).toBe('true');
    expect(
      bar.querySelectorAll(':scope > span[aria-hidden="true"]').length
    ).toBe(1);
    expect(bar.querySelector('input')).toBeNull();
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
