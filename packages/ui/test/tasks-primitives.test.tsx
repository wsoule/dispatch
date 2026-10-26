import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  Button,
  Checklist,
  Chip,
  EmptyState,
  Notice,
  ProgressRule,
  SegmentedControl,
  Switch,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';

afterEach(cleanup);

// A host link that marks what it rendered, to prove routing goes through
// the provider rather than a bare <a>.
function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

describe('Button', () => {
  test('is a type=button by default and honours disabled', () => {
    const onClick = mock(() => {});
    const { getByRole } = render(
      <Button onClick={onClick} disabled>
        Run now
      </Button>
    );
    const button = getByRole('button', { name: 'Run now' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  // CSS modules are empty objects under Bun, so the size is pinned in the
  // sheet: lg is Gr8r's 36px button, block stretches it across a card.
  test('comes in a large, full-width size', () => {
    const { getByRole } = render(
      <Button variant="primary" size="lg" block>
        Sign in with Linear
      </Button>
    );
    expect(getByRole('button', { name: 'Sign in with Linear' })).toBeTruthy();
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'tasks', 'button.module.css'),
      'utf8'
    );
    expect(css).toMatch(/\.lg \{[^}]*min-height: var\(--h-lg\);/);
    expect(css).toMatch(/\.block \{[^}]*width: 100%;/);
  });

  test('with href renders through the host link', () => {
    const { getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <Button href="/runs">Run log</Button>
      </UiLinkProvider>
    );
    const link = getByRole('link', { name: 'Run log' });
    expect(link.getAttribute('href')).toBe('/runs');
    expect(link.hasAttribute('data-host-link')).toBe(true);
  });

  test('external links open a new tab and say so', () => {
    const { getByRole } = render(
      <Button href="https://linear.app/x" external>
        Open in Linear
      </Button>
    );
    const link = getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('(opens in a new tab)');
  });

  test('an icon-only button keeps its accessible name', () => {
    const { getByRole } = render(
      <Button icon={<svg />} aria-label="Copy link" />
    );
    expect(getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });
});

describe('Chip', () => {
  test('exposes its tone and an accessible status mark', () => {
    const { getByRole, getByText, container } = render(
      <Chip tone="accent" status="overdue" statusLabel="Overdue">
        Overdue · 2 days
      </Chip>
    );
    expect(getByRole('img', { name: 'Overdue' })).toBeTruthy();
    expect(getByText('Overdue · 2 days')).toBeTruthy();
    expect(container.querySelector('[data-tone="accent"]')).not.toBeNull();
  });
});

describe('SegmentedControl', () => {
  const options = [
    { id: 'weeks', label: 'Weeks' },
    { id: 'off', label: 'Off', disabled: true },
    { id: 'months', label: 'Months', count: 3 },
  ];

  test('is a labelled radio group with one tab stop', () => {
    const { getByRole, getAllByRole } = render(
      <SegmentedControl label="Zoom" options={options} defaultValue="weeks" />
    );
    expect(getByRole('radiogroup', { name: 'Zoom' })).toBeTruthy();
    const radios = getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  test('arrows select the next enabled option and move focus', () => {
    const onChange = mock((_id: string) => {});
    const { getAllByRole } = render(
      <SegmentedControl
        label="Zoom"
        options={options}
        defaultValue="weeks"
        onChange={onChange}
      />
    );
    const radios = getAllByRole('radio');
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('months');
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2].getAttribute('aria-checked')).toBe('true');
    expect(radios[2].tabIndex).toBe(0);
    fireEvent.keyDown(radios[2], { key: 'Home' });
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
  });

  test('controlled: the parent owns the value', () => {
    const onChange = mock((_id: string) => {});
    const { getAllByRole } = render(
      <SegmentedControl
        label="Zoom"
        options={options}
        value="weeks"
        onChange={onChange}
      />
    );
    fireEvent.click(getAllByRole('radio')[2]);
    expect(onChange).toHaveBeenCalledWith('months');
    expect(getAllByRole('radio')[0].getAttribute('aria-checked')).toBe('true');
  });
});

describe('Switch', () => {
  test('is a switch whose aria-checked follows clicks', () => {
    const onChange = mock((_v: boolean) => {});
    const { getByRole } = render(
      <Switch label="Dependencies" onChange={onChange} />
    );
    const sw = getByRole('switch', { name: 'Dependencies' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('controlled and disabled switches do not flip on their own', () => {
    const { getAllByRole } = render(
      <>
        <Switch label="Live" checked={false} />
        <Switch label="Locked" disabled defaultChecked />
      </>
    );
    const [live, locked] = getAllByRole('switch');
    fireEvent.click(live);
    expect(live.getAttribute('aria-checked')).toBe('false');
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(locked.getAttribute('aria-checked')).toBe('true');
  });

  // Two "Live" switches in one settings list must not share a name: the
  // host names each by its row, keeping the visible word inside.
  test('takes an accessible name from aria-label or aria-labelledby', () => {
    const { getByRole } = render(
      <>
        <Switch label="Live" aria-label="Allocation live" />
        <p id="warnings-title">Warnings</p>
        <Switch label="Live" aria-labelledby="warnings-title" />
      </>
    );
    expect(getByRole('switch', { name: 'Allocation live' })).toBeTruthy();
    expect(getByRole('switch', { name: 'Warnings' })).toBeTruthy();
  });
});

describe('ProgressRule', () => {
  test('reports done/total as a progressbar and prints the receipt', () => {
    const { getByRole, getByText } = render(
      <ProgressRule done={3} total={7} aria-label="Beta progress" />
    );
    const bar = getByRole('progressbar', { name: 'Beta progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('7');
    expect(bar.getAttribute('aria-valuetext')).toBe('3 of 7 done');
    expect(getByText('3/7')).toBeTruthy();
  });

  test('clamps out-of-range input and can hide the label', () => {
    const { getByRole, container } = render(
      <ProgressRule done={9} total={4} tone="accent" label={null} />
    );
    expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('4');
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-tone="accent"]')).not.toBeNull();
  });
});

describe('Checklist', () => {
  test('states met and missing in words, not only marks', () => {
    const { getByRole, getAllByRole } = render(
      <Checklist
        label="Rubric"
        items={[
          { label: 'Target date', met: true },
          { label: 'Done means…', met: false, note: 'Add it in Linear' },
        ]}
      />
    );
    expect(getByRole('list', { name: 'Rubric' })).toBeTruthy();
    const items = getAllByRole('listitem');
    expect(items[0].textContent).toContain('Met');
    expect(items[1].textContent).toContain('Missing');
    expect(items[1].textContent).toContain('Add it in Linear');
    expect(items[1].getAttribute('data-met')).toBe('false');
  });
});

describe('Notice and EmptyState', () => {
  test('Notice carries its key, role and action', () => {
    const { getByRole } = render(
      <Notice label="Blocked" role="alert" action={<button>Fix</button>}>
        Delta has no lead.
      </Notice>
    );
    const alert = getByRole('alert');
    expect(alert.textContent).toContain('Blocked');
    expect(alert.textContent).toContain('Delta has no lead.');
    expect(getByRole('button', { name: 'Fix' })).toBeTruthy();
  });

  test('EmptyState renders its copy on the .empty primitive', () => {
    const { getByText, container } = render(
      <EmptyState hatched>Nothing due</EmptyState>
    );
    expect(getByText('Nothing due')).toBeTruthy();
    const box = container.firstElementChild;
    expect(box?.classList.contains('empty')).toBe(true);
    expect(box?.classList.contains('hatched')).toBe(true);
  });

  test('EmptyState puts an optional title above the sentence', () => {
    const { getByText } = render(
      <EmptyState label="No runs">
        No allocation runs yet. Runs appear here after the daily run.
      </EmptyState>
    );
    const key = getByText('No runs');
    // Not the global .label (12px grey): it has the module's specificity
    // and, loaded later, beat the title's own 14.5px semibold.
    expect(key.classList.contains('label')).toBe(false);
    // Gr8r's order: the icon, the title, then the sentence.
    expect(key.parentElement?.textContent).toBe(
      'No runsNo allocation runs yet. Runs appear here after the daily run.'
    );
    const icon = key.parentElement?.firstElementChild;
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('svg')).not.toBeNull();
  });

  test('EmptyState takes its own icon, or none', () => {
    const own = render(
      <EmptyState label="No edits" icon={<svg data-testid="own" />}>
        Nothing edited yet.
      </EmptyState>
    );
    expect(own.getByTestId('own')).toBeTruthy();
    own.unmount();
    const bare = render(<EmptyState icon={null}>Nothing yet.</EmptyState>);
    expect(bare.container.querySelector('svg')).toBeNull();
  });
});
