import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';

import {
  Button,
  Checklist,
  Chip,
  ChipButton,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Notice,
  Popover,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
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

  // The passthrough a host needs to drop its own button: a ref for focus
  // and anchoring, key and pointer handlers, a description, form wiring.
  test('passes the ref, handlers, description and form wiring to the element', () => {
    const ref: { current: HTMLButtonElement | null } = { current: null };
    const onKeyDown = mock((_key: string) => {});
    const onPointerDown = mock(() => {});
    const onFocus = mock(() => {});
    const { getByRole } = render(
      <>
        <form id="save-view" />
        <Button
          ref={ref}
          id="save"
          type="submit"
          form="save-view"
          name="intent"
          tabIndex={-1}
          aria-describedby="save-hint"
          aria-haspopup="dialog"
          onKeyDown={(event) => onKeyDown(event.key)}
          onPointerDown={onPointerDown}
          onFocus={onFocus}
        >
          Save view
        </Button>
        <p id="save-hint">Saved views are shared.</p>
      </>
    );
    const button = getByRole('button', { name: 'Save view' });
    expect(ref.current === button).toBe(true);
    expect(button.id).toBe('save');
    expect(button.getAttribute('form')).toBe('save-view');
    expect(button.getAttribute('name')).toBe('intent');
    expect(button.getAttribute('tabindex')).toBe('-1');
    expect(button.getAttribute('aria-describedby')).toBe('save-hint');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    fireEvent.pointerDown(button);
    button.focus();
    expect(onKeyDown).toHaveBeenCalledWith('ArrowDown');
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  // A save in flight says so in words (never a spinner): disabled,
  // aria-busy, and the busy text in place of the label.
  test('busy disables it with aria-busy and swaps the text', () => {
    const onClick = mock(() => {});
    const { getByRole, rerender } = render(
      <Button variant="primary" busy onClick={onClick}>
        Save
      </Button>
    );
    const button = getByRole('button', { name: 'Saving…' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.querySelector('svg')).toBeNull();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(
      <Button variant="primary" busy busyLabel="Deleting…" onClick={onClick}>
        Delete
      </Button>
    );
    expect(getByRole('button', { name: 'Deleting…' })).toBeTruthy();
    rerender(
      <Button variant="primary" onClick={onClick}>
        Save
      </Button>
    );
    const idle = getByRole('button', { name: 'Save' });
    expect(idle.hasAttribute('aria-busy')).toBe(false);
    expect(idle.hasAttribute('disabled')).toBe(false);
  });

  test('the link branch forwards data hooks, the description and keys', () => {
    const onKeyDown = mock((_key: string) => {});
    const { getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <Button
          href="/runs"
          data-testid="tasks-back"
          data-slot="back-link"
          aria-describedby="runs-hint"
          onKeyDown={(event) => onKeyDown(event.key)}
        >
          Runs
        </Button>
      </UiLinkProvider>
    );
    const link = getByRole('link', { name: 'Runs' });
    expect(link.getAttribute('data-testid')).toBe('tasks-back');
    expect(link.getAttribute('data-slot')).toBe('back-link');
    expect(link.getAttribute('aria-describedby')).toBe('runs-hint');
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledWith('Enter');
  });
});

// DataAttributes: a host's data-testid and data-slot hooks reach the
// root element of every primitive that takes them, untouched, and never
// replace the component's own data-* attributes.
describe('host data attributes', () => {
  test('reach the root of Button, as a button and as a link', () => {
    const { getByRole } = render(
      <>
        <Button data-testid="team-start" data-slot="primary-action">
          Start
        </Button>
        <Button href="/docs" data-testid="docs-link" data-slot="nav-link">
          Docs
        </Button>
      </>
    );
    const button = getByRole('button', { name: 'Start' });
    expect(button.getAttribute('data-testid')).toBe('team-start');
    expect(button.getAttribute('data-slot')).toBe('primary-action');
    // The component's own hook stays.
    expect(button.getAttribute('data-variant')).toBe('secondary');
    const link = getByRole('link', { name: 'Docs' });
    expect(link.getAttribute('data-testid')).toBe('docs-link');
    expect(link.getAttribute('data-slot')).toBe('nav-link');
  });

  test('reach the root of Popover, Dialog and ConfirmDialog', () => {
    const { getByRole } = render(
      <>
        <Popover
          open
          onOpenChange={() => {}}
          label="Display options"
          trigger={<button type="button">Display</button>}
          data-testid="display"
          data-slot="display-popover"
        >
          <p>Layout</p>
        </Popover>
        <Dialog
          open
          onClose={() => {}}
          title="New doc"
          data-testid="new-doc"
          data-slot="dialog-content"
        >
          <input aria-label="Title" />
        </Dialog>
      </>
    );
    const popover = getByRole('dialog', { name: 'Display options' });
    expect(popover.getAttribute('data-testid')).toBe('display');
    expect(popover.getAttribute('data-slot')).toBe('display-popover');
    expect(popover.hasAttribute('data-popover')).toBe(true);
    const dialog = getByRole('dialog', { name: 'New doc' });
    expect(dialog.getAttribute('data-testid')).toBe('new-doc');
    expect(dialog.getAttribute('data-slot')).toBe('dialog-content');
    cleanup();
    const confirm = render(
      <ConfirmDialog
        open
        title="Delete this view?"
        confirmLabel="Delete view"
        tone="danger"
        onConfirm={() => {}}
        onCancel={() => {}}
        data-testid="delete-view"
        data-slot="alert-dialog-content"
      >
        Its filters are lost.
      </ConfirmDialog>
    );
    const alert = confirm.getByRole('alertdialog', {
      name: 'Delete this view?',
    });
    expect(alert.getAttribute('data-testid')).toBe('delete-view');
    expect(alert.getAttribute('data-slot')).toBe('alert-dialog-content');
  });

  test('reach the root of Chip, Switch and Notice; their own data-tone wins', () => {
    const { getByRole, getByTestId } = render(
      <>
        <Chip tone="warning" data-testid="landing-badge" data-tone="info">
          Waiting
        </Chip>
        <Switch label="Live" data-testid="jev-status" data-slot="switch" />
        <Notice
          tone="danger"
          role="alert"
          data-testid="sync-failed"
          data-slot="notice"
        >
          Sync failed.
        </Notice>
      </>
    );
    const chip = getByTestId('landing-badge');
    expect(chip.textContent).toBe('Waiting');
    expect(chip.getAttribute('data-tone')).toBe('warning');
    const sw = getByRole('switch', { name: 'Live' });
    expect(sw.getAttribute('data-testid')).toBe('jev-status');
    expect(sw.getAttribute('data-slot')).toBe('switch');
    const alert = getByRole('alert');
    expect(alert.getAttribute('data-testid')).toBe('sync-failed');
    expect(alert.getAttribute('data-slot')).toBe('notice');
    expect(alert.getAttribute('data-tone')).toBe('danger');
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

describe('ChipButton', () => {
  test('a button named by its text, in the chip look; a press calls onClick', () => {
    const onClick = mock(() => {});
    const { getByRole } = render(
      <ChipButton tone="info" onClick={onClick} data-testid="starter">
        Write the spec
      </ChipButton>
    );
    const button = getByRole('button', { name: 'Write the spec' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('data-tone')).toBe('info');
    expect(button.hasAttribute('data-chip-button')).toBe(true);
    expect(button.getAttribute('data-testid')).toBe('starter');
    // A plain action, not a toggle.
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('selected makes a toggle: aria-pressed true or false', () => {
    const { getByRole, rerender } = render(
      <ChipButton selected>Blocked</ChipButton>
    );
    expect(
      getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed')
    ).toBe('true');
    rerender(<ChipButton selected={false}>Blocked</ChipButton>);
    expect(
      getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed')
    ).toBe('false');
  });

  test('disabled: the button cannot be pressed', () => {
    const onClick = mock(() => {});
    const { getByRole } = render(
      <ChipButton disabled onClick={onClick}>
        Retry
      </ChipButton>
    );
    const button = getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test('href renders the host link (no aria-pressed); disabled turns it into text', () => {
    const { getByRole, queryByRole, getByText, rerender } = render(
      <UiLinkProvider link={HostLink}>
        <ChipButton href="/tasks/42" selected data-testid="ref">
          #42 Fix login
        </ChipButton>
      </UiLinkProvider>
    );
    const link = getByRole('link', { name: '#42 Fix login' });
    expect(link.getAttribute('href')).toBe('/tasks/42');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    expect(link.getAttribute('data-testid')).toBe('ref');
    expect(link.hasAttribute('aria-pressed')).toBe(false);
    rerender(
      <UiLinkProvider link={HostLink}>
        <ChipButton href="/tasks/42" disabled>
          #42 Fix login
        </ChipButton>
      </UiLinkProvider>
    );
    expect(queryByRole('link')).toBeNull();
    expect(
      getByText('#42 Fix login').parentElement?.getAttribute('aria-disabled')
    ).toBe('true');
  });

  test('the module draws the focus ring, a hover fill and the selection tint', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'tasks', 'chip.module.css'),
      'utf8'
    ).replace(/\s+/g, ' ');
    expect(css).toContain(
      '.button:focus-visible { outline: 2px solid var(--focus-ring);'
    );
    expect(css).toContain(
      ".button[aria-pressed='true'] { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-ink); }"
    );
    const hover = css.slice(css.indexOf('@media (hover: hover)'));
    expect(hover).toContain('background: var(--surface-3);');
  });

  test('renders on the server as a button or a link', () => {
    const html = renderToString(
      <>
        <ChipButton selected>Blocked</ChipButton>
        <ChipButton href="/runs">Runs</ChipButton>
      </>
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('href="/runs"');
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

  // The count is visible beside the label, and the radio's name keeps the
  // two apart ("Months, 3", not "Months3").
  test('an option with a count is named label, count', () => {
    const { getByRole } = render(
      <SegmentedControl label="Zoom" options={options} defaultValue="weeks" />
    );
    expect(getByRole('radio', { name: 'Months, 3' })).toBeTruthy();
    expect(getByRole('radio', { name: 'Weeks' })).toBeTruthy();
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

  // A settings row whose title names the switch draws just the track:
  // the label stays for assistive tech, and aria-labelledby still wins.
  test('hideLabel keeps the label for assistive tech only', () => {
    const { getByRole, getByText } = render(
      <>
        <Switch label="Auto-merge" hideLabel />
        <p id="notify-title">Notify on finish</p>
        <Switch label="Notify" hideLabel aria-labelledby="notify-title" />
      </>
    );
    expect(getByRole('switch', { name: 'Auto-merge' })).toBeTruthy();
    expect(getByText('Auto-merge').classList.contains('srOnly')).toBe(true);
    expect(getByRole('switch', { name: 'Notify on finish' })).toBeTruthy();
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

  test('Notice role="note": an aside that qualifies the page', () => {
    const { getByRole } = render(
      <Notice tone="default" role="note" label="Read only">
        You can view these settings, but only someone with decide access can
        change them.
      </Notice>
    );
    const note = getByRole('note');
    expect(note.textContent).toContain('Read only');
    expect(note.getAttribute('data-tone')).toBe('default');
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

// L35: a Register's root, rows and cells carry the host's hooks (e2e
// counts `needs-you-row`), and a button row can be a toggle (a filter).
describe('Register passthrough', () => {
  test('host hooks reach the register, row and cell roots', () => {
    const { getByTestId, getByRole } = render(
      <Register
        columns="1fr auto"
        label="Needs you"
        data-testid="needs-you"
        data-slot="register"
      >
        <RegisterRow
          rowLabel="Open the plan question"
          onActivate={() => {}}
          data-testid="needs-you-row"
          data-tone="info"
        >
          <RegisterCell variant="name" data-roster-title="">
            Plan question
          </RegisterCell>
          <RegisterCell tone="warning" data-testid="row-state">
            Waiting
          </RegisterCell>
        </RegisterRow>
        <RegisterRow href="/runs/7" rowLabel="Run 7" data-slot="link-row">
          <RegisterCell>Run 7</RegisterCell>
        </RegisterRow>
        <RegisterRow data-slot="plain-row">
          <RegisterCell>Plain</RegisterCell>
        </RegisterRow>
      </Register>
    );
    const register = getByTestId('needs-you');
    expect(register.getAttribute('data-slot')).toBe('register');
    // The register's own hook stays.
    expect(register.getAttribute('data-stack')).toBe('viewport-900');
    expect(register.contains(getByRole('list', { name: 'Needs you' }))).toBe(
      true
    );
    const row = getByTestId('needs-you-row');
    expect(row.tagName).toBe('LI');
    // The row's own data-tone wins over a host's.
    expect(row.getAttribute('data-tone')).toBe('default');
    const title = row.querySelector('[data-roster-title]');
    expect(title?.textContent).toBe('Plan question');
    expect(getByTestId('row-state').getAttribute('data-tone')).toBe('warning');
    expect(
      getByRole('link', { name: 'Run 7' }).closest('[data-slot="link-row"]')
    ).not.toBeNull();
    expect(
      register.querySelector('li[data-slot="plain-row"]')?.textContent
    ).toBe('Plain');
  });

  test('pressed sets aria-pressed on a button row only', () => {
    const { getByRole, getAllByRole } = render(
      <Register columns="1fr" label="Projects">
        <RegisterRow rowLabel="Filter by Atlas" onActivate={() => {}} pressed>
          <RegisterCell>Atlas</RegisterCell>
        </RegisterRow>
        <RegisterRow
          rowLabel="Filter by Beacon"
          onActivate={() => {}}
          pressed={false}
        >
          <RegisterCell>Beacon</RegisterCell>
        </RegisterRow>
        <RegisterRow rowLabel="Open Garnet" onActivate={() => {}}>
          <RegisterCell>Garnet</RegisterCell>
        </RegisterRow>
        <RegisterRow href="/p/delta" rowLabel="Delta">
          <RegisterCell>Delta</RegisterCell>
        </RegisterRow>
      </Register>
    );
    expect(
      getByRole('button', { name: 'Filter by Atlas' }).getAttribute(
        'aria-pressed'
      )
    ).toBe('true');
    expect(
      getByRole('button', { name: 'Filter by Beacon' }).getAttribute(
        'aria-pressed'
      )
    ).toBe('false');
    expect(
      getByRole('button', { name: 'Open Garnet' }).hasAttribute('aria-pressed')
    ).toBe(false);
    expect(
      getByRole('link', { name: 'Delta' }).hasAttribute('aria-pressed')
    ).toBe(false);
    // Only the stretched buttons, never the rows, carry it.
    for (const item of getAllByRole('listitem')) {
      expect(item.hasAttribute('aria-pressed')).toBe(false);
    }
  });

  test('renders on the server with the hooks and the pressed state', () => {
    const html = renderToString(
      <Register columns="1fr" label="Spend" data-testid="spend">
        <RegisterRow
          rowLabel="Filter by Atlas"
          onActivate={() => {}}
          pressed
          data-testid="spend-row"
        >
          <RegisterCell data-slot="cost">$4</RegisterCell>
        </RegisterRow>
      </Register>
    );
    expect(html).toContain('data-testid="spend"');
    expect(html).toContain('data-testid="spend-row"');
    expect(html).toContain('data-slot="cost"');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe('server render of the passthrough primitives', () => {
  test('Chip, Switch with hideLabel and a note Notice render with no state', () => {
    const html = renderToString(
      <>
        <Chip tone="danger" filled data-testid="failed-chip">
          Failed
        </Chip>
        <Switch label="Live" hideLabel data-testid="live" />
        <Notice role="note" tone="default" data-testid="read-only">
          Read only.
        </Notice>
      </>
    );
    expect(html).toContain('data-testid="failed-chip"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('class="srOnly"');
    expect(html).toContain('role="note"');
    expect(html).toContain('data-testid="read-only"');
  });
});
