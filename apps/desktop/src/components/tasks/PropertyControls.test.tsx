import type { Person, TaskDoc } from '@dispatch-foo/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { type ReactElement, useState } from 'react';

import { dayFromNow } from '../../lib/taskDates';
import { PeopleProvider } from '../people/PeopleContext';
import {
  AssigneeControl,
  CycleControl,
  DueDateControl,
  EpicControl,
  EstimateControl,
  LabelsControl,
  PriorityControl,
  StatusControl,
} from './PropertyControls';

const STATUSES = ['draft', 'ready', 'working', 'review', 'landed'];

// A menu positions itself a microtask after mount (floating-ui), so an open picker is
// rendered — and its items clicked — inside an async `act` that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

function renderOpen(ui: ReactElement) {
  return settle(() => {
    render(ui);
  });
}

function epic(id: string, title: string): TaskDoc {
  return { meta: { id, title, kind: 'epic' }, body: '' } as unknown as TaskDoc;
}

/** The label picker's rows, in order, with whether each carries the check. */
function labelOptions(): { label: string; checked: boolean; dot: boolean }[] {
  return screen.getAllByRole('option').map((o) => ({
    label: o.textContent ?? '',
    checked: o.querySelector('svg.lucide-check') !== null,
    dot: o.querySelector('[data-slot=label-dot]') !== null,
  }));
}

/** cmdk selects an item on click after a pointer-down. */
function pick(name: RegExp) {
  return settle(() => {
    const option = screen.getByRole('option', { name });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
}

describe('PropertyControls', () => {
  test('a row control is a 32px ghost row with the human status label', () => {
    render(
      <StatusControl
        value="working"
        statuses={STATUSES}
        onChange={() => {}}
        variant="row"
      />
    );
    const trigger = screen.getByRole('button', {
      name: 'Change status',
      description: 'Working',
    });
    expect(trigger.dataset['variant']).toBe('row');
    expect(trigger.className).toContain('h-8');
    expect(trigger.className).toContain('rounded-control');
    expect(trigger.textContent).toBe('Working');
    expect(trigger.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Status: working'
    );
  });

  test('an inline control is the glyph alone in a 20px hit area', () => {
    render(<PriorityControl value="high" onChange={() => {}} />);
    const trigger = screen.getByRole('button', {
      name: 'Change priority',
      description: 'High',
    });
    expect(trigger.dataset['variant']).toBe('inline');
    expect(trigger.className).toContain('size-5');
    // The value is there for a screen reader only.
    expect(trigger.querySelector('.sr-only')?.textContent).toBe('High');
    expect(trigger.querySelector('.truncate')).toBeNull();
    expect(trigger.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'High'
    );
  });

  test('an unset priority reads as the action that sets it, muted', () => {
    render(<PriorityControl value="none" onChange={() => {}} variant="row" />);
    const trigger = screen.getByRole('button', {
      name: 'Change priority',
      description: 'Set priority',
    });
    expect(trigger.textContent).toBe('Set priority');
    expect(trigger.dataset['unset']).toBe('true');
    expect(trigger.className).toContain('text-muted-foreground');
    // The `···` glyph still leads the row.
    expect(trigger.querySelector('svg')?.dataset['priority']).toBe('none');
  });

  test('an unassigned row says Assign; an unparented row says Add to epic', () => {
    render(
      <>
        <AssigneeControl value="none" onChange={() => {}} variant="row" />
        <EpicControl value={null} epics={[]} onChange={() => {}} />
      </>
    );
    expect(
      screen.getByRole('button', { name: 'Change assignee' }).textContent
    ).toBe('Assign');
    expect(
      screen.getByRole('button', { name: 'Change epic' }).textContent
    ).toBe('Add to epic');
  });

  test('a set row is not muted and names the assignee', () => {
    render(
      <AssigneeControl value="human:wyat" onChange={() => {}} variant="row" />
    );
    const trigger = screen.getByRole('button', { name: 'Change assignee' });
    expect(trigger.querySelector('.truncate')?.textContent).toBe('wyat');
    expect(
      trigger.querySelector('[data-slot=initials-avatar]')?.textContent
    ).toBe('WY');
    expect(trigger.dataset['unset']).toBeUndefined();
  });

  test('a controlled open renders the menu with human labels, glyphs and the S keycap', async () => {
    await renderOpen(
      <StatusControl
        value="ready"
        statuses={STATUSES}
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />
    );
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Draft',
      'Ready',
      'Working',
      'Review',
      'Landed',
    ]);
    for (const item of items) {
      expect(item.querySelector('svg[aria-label^="Status:"]')).not.toBeNull();
    }
    expect(menu.querySelector('kbd')?.textContent).toBe('S');
    expect(items[1]?.dataset['selected']).toBe('true');
    expect(items[0]?.dataset['selected']).toBeUndefined();
  });

  test('the priority menu lists No priority … Urgent under a P keycap', async () => {
    await renderOpen(
      <PriorityControl
        value="none"
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />
    );
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Urgent',
      'High',
      'Medium',
      'Low',
      'No priority',
    ]);
    expect(screen.getByRole('menu').querySelector('kbd')?.textContent).toBe(
      'P'
    );
  });

  test('picking an item reports the raw value and asks to close', async () => {
    const picked: string[] = [];
    const opens: boolean[] = [];
    await renderOpen(
      <StatusControl
        value="ready"
        statuses={STATUSES}
        onChange={(s) => picked.push(s)}
        open
        onOpenChange={(o) => opens.push(o)}
      />
    );
    await settle(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Working/ }));
    });
    expect(picked).toEqual(['working']);
    expect(opens).toEqual([false]);
  });

  test('a closed controlled picker renders no menu until its owner opens it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            press p
          </button>
          <PriorityControl
            value="low"
            onChange={() => {}}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByRole('menu')).toBeNull();
    await settle(() => {
      fireEvent.click(screen.getByText('press p'));
    });
    expect(screen.getByRole('menu')).not.toBeNull();
  });

  test('the epic menu lists No epic then every epic by title', async () => {
    await renderOpen(
      <EpicControl
        value="e-2"
        epics={[epic('e-1', 'Payments'), epic('e-2', 'Search')]}
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />
    );
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'No epic',
      'Payments',
      'Search',
    ]);
    expect(items[2]?.dataset['selected']).toBe('true');
  });

  test('the labels row face is the Add label ghost row', () => {
    render(
      <LabelsControl
        value={['ui']}
        candidates={['ui', 'api']}
        onChange={() => {}}
      />
    );
    const trigger = screen.getByRole('button', { name: 'Add label' });
    expect(trigger.className).toContain('h-8');
    expect(trigger.className).toContain('rounded-control');
    expect(trigger.textContent).toBe('Add label');
    expect(screen.queryByRole('option')).toBeNull();
  });

  test('an inline labels control is a 20px Tag glyph unless given a face', () => {
    render(
      <>
        <LabelsControl
          value={[]}
          candidates={[]}
          onChange={() => {}}
          variant="inline"
        />
        <LabelsControl
          value={['ui']}
          candidates={[]}
          onChange={() => {}}
          variant="inline"
        >
          <span data-slot="face">ui</span>
        </LabelsControl>
      </>
    );
    const [glyph, faced] = screen.getAllByRole('button', {
      name: 'Change labels',
    });
    expect(glyph?.className).toContain('size-5');
    expect(glyph?.querySelector('svg.lucide-tag')).not.toBeNull();
    expect(faced?.querySelector('[data-slot=face]')?.textContent).toBe('ui');
    expect(faced?.querySelector('svg.lucide-tag')).toBeNull();
  });

  test('a controlled open lists every label with its dot and a check on the applied ones', async () => {
    await renderOpen(
      <LabelsControl
        value={['ui', 'local-only']}
        candidates={['ui', 'api', 'infra']}
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />
    );
    expect(screen.getByPlaceholderText('Label…')).not.toBeNull();
    // The sorted union of the vocabulary and the task's own labels.
    expect(labelOptions()).toEqual([
      { label: 'api', checked: false, dot: true },
      { label: 'infra', checked: false, dot: true },
      { label: 'local-only', checked: true, dot: true },
      { label: 'ui', checked: true, dot: true },
    ]);
  });

  test('picking toggles membership, reports the whole list and keeps the popover open', async () => {
    const changes: string[][] = [];
    const opens: boolean[] = [];
    await renderOpen(
      <LabelsControl
        value={['ui', 'ui']}
        candidates={['ui', 'api']}
        onChange={(next) => changes.push(next)}
        open
        onOpenChange={(o) => opens.push(o)}
      />
    );
    await pick(/^api$/);
    await pick(/^ui$/);
    expect(changes).toEqual([['ui', 'api'], []]);
    expect(opens).toEqual([]);
    expect(screen.getByPlaceholderText('Label…')).not.toBeNull();
  });

  test('typing an unknown name offers Create and appends it', async () => {
    const changes: string[][] = [];
    await renderOpen(
      <LabelsControl
        value={['ui']}
        candidates={['ui', 'api']}
        onChange={(next) => changes.push(next)}
        open
        onOpenChange={() => {}}
      />
    );
    await settle(() => {
      fireEvent.change(screen.getByPlaceholderText('Label…'), {
        target: { value: 'docs' },
      });
    });
    expect(screen.queryByText('Type a new label.')).toBeNull();
    await pick(/Create “docs”/);
    expect(changes).toEqual([['ui', 'docs']]);
    // The search resets for the next pick instead of the popover closing.
    expect(screen.getByPlaceholderText<HTMLInputElement>('Label…').value).toBe(
      ''
    );
  });

  test('a case-variant of an existing label is not offered for creation', async () => {
    await renderOpen(
      <LabelsControl
        value={[]}
        candidates={['ui']}
        onChange={() => {}}
        open
        onOpenChange={() => {}}
      />
    );
    await settle(() => {
      fireEvent.change(screen.getByPlaceholderText('Label…'), {
        target: { value: 'UI' },
      });
    });
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    expect(labelOptions().map((o) => o.label)).toEqual(['ui']);
  });
});

// A long list mounts rows every scroll frame, so a picker at rest is a plain button and the
// Base UI menu only mounts on intent. These pin that the swap never costs an interaction.
describe('pickers mount their menu on first intent', () => {
  test('an idle control mounts no menu machinery', () => {
    render(
      <StatusControl value="ready" statuses={STATUSES} onChange={() => {}} />
    );
    const trigger = screen.getByRole('button', { name: 'Change status' });
    // Base UI's trigger carries its own slot; the resting face does not.
    expect(
      document.querySelector('[data-slot=dropdown-menu-trigger]')
    ).toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('a click on a cold control opens its menu in one go', async () => {
    render(<PriorityControl value="none" onChange={() => {}} variant="row" />);
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change priority' }));
    });
    expect(screen.getByRole('menuitem', { name: /Urgent/ })).not.toBeNull();
  });

  test('a cold controlled picker asks its owner to open', () => {
    const asked: boolean[] = [];
    render(
      <AssigneeControl
        value="none"
        onChange={() => {}}
        open={false}
        onOpenChange={(next) => asked.push(next)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change assignee' }));
    expect(asked).toEqual([true]);
  });

  test('keyboard focus survives the swap to the real trigger', async () => {
    render(
      <StatusControl value="ready" statuses={STATUSES} onChange={() => {}} />
    );
    const cold = screen.getByRole('button', { name: 'Change status' });
    await settle(() => {
      cold.focus();
    });
    const live = screen.getByRole('button', { name: 'Change status' });
    expect(live).not.toBe(cold);
    expect(document.activeElement).toBe(live);
  });

  test('a cold labels picker opens on click too', async () => {
    render(
      <LabelsControl
        value={[]}
        candidates={['ui']}
        onChange={() => {}}
        variant="inline"
      />
    );
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change labels' }));
    });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'ui',
    ]);
  });
});

describe('the assignee picker lists people and agents', () => {
  const people = [
    { ref: 'human:maya', name: 'Maya Chen' },
    { ref: 'human:wyat', name: 'Wyat Soule' },
  ];

  test('you first, then the team, then the agent pool and nobody', async () => {
    const picked: string[] = [];
    render(
      <PeopleProvider people={people} me="human:wyat">
        <AssigneeControl value="none" onChange={(a) => picked.push(a)} />
      </PeopleProvider>
    );
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change assignee' }));
    });
    // Each item's label, without its avatar's initials.
    expect(
      screen
        .getAllByRole('menuitem')
        .map((item) => item.querySelector('.truncate')?.textContent)
    ).toEqual(['Wyat Soule', 'Maya Chen', 'Agent', 'Unassigned']);
    await settle(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Maya Chen/ }));
    });
    expect(picked).toEqual(['human:maya']);
  });

  test('the legacy bare human reads as me', () => {
    render(
      <PeopleProvider people={people} me="human:wyat">
        <AssigneeControl value="human" onChange={() => {}} variant="row" />
      </PeopleProvider>
    );
    expect(
      screen.getByRole('button', { name: 'Change assignee' }).textContent
    ).toContain('Wyat Soule');
  });

  // Listed by GET /api/people while a Linear issue's assignee has no name yet.
  const placeholder = {
    ref: 'human:linear-user',
    name: 'Unknown Linear user',
    placeholder: true,
  };

  // The open menu's labels for an unassigned task.
  async function offered(
    listed: readonly Person[]
  ): Promise<(string | null)[]> {
    const view = render(
      <PeopleProvider people={listed} me="human:wyat">
        <AssigneeControl value="none" onChange={() => {}} />
      </PeopleProvider>
    );
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Change assignee' }));
    });
    const labels = screen
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.truncate')?.textContent ?? null);
    view.unmount();
    return labels;
  }

  test('never offers the unknown-Linear-user placeholder', async () => {
    expect(await offered([...people, placeholder])).toEqual([
      'Wyat Soule',
      'Maya Chen',
      'Agent',
      'Unassigned',
    ]);
    // Alone it is no registry: the fixed kinds stay, yourself included.
    expect(await offered([placeholder])).toEqual([
      'Agent',
      'Human',
      'Unassigned',
    ]);
  });

  test('a task the placeholder holds still names it', () => {
    render(
      <PeopleProvider people={[...people, placeholder]} me="human:wyat">
        <AssigneeControl
          value="human:linear-user"
          onChange={() => {}}
          variant="row"
        />
      </PeopleProvider>
    );
    expect(
      screen.getByRole('button', { name: 'Change assignee' }).textContent
    ).toContain('Unknown Linear user');
  });
});

describe('estimate, due date and cycle', () => {
  test('an estimate is picked from the scale', async () => {
    const picks: (number | null)[] = [];
    await renderOpen(
      <EstimateControl value={null} onChange={(n) => picks.push(n)} open />
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: '5 points' }))
    );
    expect(picks).toEqual([5]);
  });

  test('No estimate clears one', async () => {
    const picks: (number | null)[] = [];
    await renderOpen(
      <EstimateControl value={5} onChange={(n) => picks.push(n)} open />
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'No estimate' }))
    );
    expect(picks).toEqual([null]);
  });

  test('an off-scale estimate still lists, and reads on the row', () => {
    render(<EstimateControl value={4} onChange={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Change estimate' }).textContent
    ).toBe('4 points');
  });

  test('a cycle is picked by id and handed back whole', async () => {
    const cycle = {
      id: 'c-42',
      number: 42,
      name: null,
      startsAt: '2026-09-17T00:00:00Z',
      endsAt: '2026-10-01T00:00:00Z',
    };
    const picks: unknown[] = [];
    await renderOpen(
      <CycleControl
        value={null}
        cycles={[cycle]}
        onChange={(c) => picks.push(c)}
        open
      />
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cycle 42' }))
    );
    expect(picks).toEqual([cycle]);
  });

  test('a due date comes from a quick pick, and clears', async () => {
    const picks: (string | null)[] = [];
    await renderOpen(
      <DueDateControl value="2026-09-30" onChange={(d) => picks.push(d)} open />
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    );
    await settle(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Clear due date' }))
    );
    expect(picks).toEqual([dayFromNow(1), null]);
  });
});
