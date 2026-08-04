import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  dataWith,
  testProject,
} from '../components/settings/fixtures.test-helper';
import { SettingsView } from './SettingsView';

const project = testProject;
const data = dataWith();

// Radix's TabsTrigger switches tabs on mousedown, not click, so a plain
// fireEvent.click would silently no-op.
function selectTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

test('with no project selected it explains what to do', () => {
  render(<SettingsView activeProject={null} data={data} />);
  expect(screen.getByText(/Select a project/)).toBeDefined();
});

test('it opens on General and switches to Integrations', () => {
  render(<SettingsView activeProject={project} data={data} />);
  expect(
    screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')
  ).toBe('true');
  selectTab('Integrations');
  expect(screen.getByText('Linear')).toBeDefined();
});

// Saving used to be invisible outside one section, so a models dropdown gave no
// feedback at all.
test('a save reports through the shared indicator', async () => {
  render(<SettingsView activeProject={project} data={data} />);
  selectTab('Agents');
  fireEvent.click(
    screen.getByLabelText('Let it edit files, ask before anything else')
  );
  expect(await screen.findByText(/Saved/)).toBeDefined();
});

// Unlike AgentsSection, LinearPanel has no local "Saved" text of its own, so
// this only passes if the shell's shared wrapper is actually wired in.
test('an Integrations config save reports through the shared indicator too', async () => {
  const connectedData = dataWith({ connected: true });
  render(<SettingsView activeProject={project} data={connectedData} />);
  selectTab('Integrations');
  const interval = screen.getByLabelText('Poll interval');
  fireEvent.change(interval, { target: { value: '120' } });
  fireEvent.blur(interval);
  expect(await screen.findByText(/Saved/)).toBeDefined();
});
