import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import { GATE_TRAFFIC_LIGHT_INSET_PX, GateFrame } from './GateFrame';

test('frames its content in the one main, under the Dispatch brand', () => {
  render(
    <GateFrame>
      <p>the gate</p>
    </GateFrame>
  );
  const mains = screen.getAllByRole('main');
  expect(mains).toHaveLength(1);
  expect(mains[0].id).toBe('main');
  expect(mains[0].textContent).toContain('the gate');
  const brand = screen.getByRole('link', { name: 'Dispatch' });
  expect(brand.getAttribute('href')).toBe('#');
  // The skip link points at the main the frame was given.
  expect(
    screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')
  ).toBe('#main');
});

test('takes the brand link and the main id from its props', () => {
  render(
    <GateFrame brandHref="/setup" mainId="gate-main">
      <p>the gate</p>
    </GateFrame>
  );
  expect(screen.getByRole('main').id).toBe('gate-main');
  expect(
    screen.getByRole('link', { name: 'Dispatch' }).getAttribute('href')
  ).toBe('/setup');
});

test('marks the top row as a drag region only when the window asks for one', () => {
  const { container, rerender } = render(
    <GateFrame>
      <p>the gate</p>
    </GateFrame>
  );
  expect(container.querySelector('[data-tauri-drag-region]')).toBeNull();

  rerender(
    <GateFrame windowChrome={{ dragRegion: true, trafficLightInset: false }}>
      <p>the gate</p>
    </GateFrame>
  );
  const dragged = container.querySelectorAll('[data-tauri-drag-region]');
  expect(dragged).toHaveLength(1);
  expect(dragged[0].tagName).toBe('HEADER');

  rerender(
    <GateFrame windowChrome={{ dragRegion: false, trafficLightInset: true }}>
      <p>the gate</p>
    </GateFrame>
  );
  expect(container.querySelector('[data-tauri-drag-region]')).toBeNull();
});

test('sets the brand in from the traffic lights only when the window has them', () => {
  const { rerender } = render(
    <GateFrame>
      <p>the gate</p>
    </GateFrame>
  );
  const frame = () => screen.getByTestId('gate-frame');
  expect(frame().style.getPropertyValue('--shell-brand-inset')).toBe('');

  rerender(
    <GateFrame windowChrome={{ dragRegion: true, trafficLightInset: false }}>
      <p>the gate</p>
    </GateFrame>
  );
  expect(frame().style.getPropertyValue('--shell-brand-inset')).toBe('');

  rerender(
    <GateFrame windowChrome={{ dragRegion: true, trafficLightInset: true }}>
      <p>the gate</p>
    </GateFrame>
  );
  expect(frame().style.getPropertyValue('--shell-brand-inset')).toBe(
    `${GATE_TRAFFIC_LIGHT_INSET_PX}px`
  );
});

// A child that throws while rendering, as a bad setup report or a terminal canvas might.
function Broken(): never {
  throw new Error('bad setup report');
}

test('a gate that throws shows the error card inside the one main', () => {
  // React and the boundary both log the caught error; keep the run quiet.
  const quiet = mock(() => {});
  const original = console.error;
  console.error = quiet;
  try {
    render(
      <GateFrame errorLabel="the setup">
        <Broken />
      </GateFrame>
    );
  } finally {
    console.error = original;
  }
  const main = screen.getByRole('main');
  const alert = screen.getByRole('alert');
  expect(main.contains(alert)).toBe(true);
  expect(alert.textContent).toContain("Dispatch couldn't display the setup.");
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  // The frame's brand row is still there around the card.
  expect(screen.getByRole('link', { name: 'Dispatch' })).toBeTruthy();
});

test('puts actions in the top row, outside the main', () => {
  render(
    <GateFrame actions={<button type="button">Settings</button>}>
      <p>the gate</p>
    </GateFrame>
  );
  const settings = screen.getByRole('button', { name: 'Settings' });
  expect(settings.closest('header')).not.toBeNull();
  expect(screen.getByRole('main').contains(settings)).toBe(false);
});

test('puts the theme toggle in the top row, stored under the app key', () => {
  const root = document.documentElement;
  root.dataset.theme = 'dark';
  try {
    render(
      <GateFrame>
        <p>the gate</p>
      </GateFrame>
    );
    const toggle = screen.getByRole('button', {
      name: 'Switch between light and dark',
    });
    expect(toggle.closest('header')).not.toBeNull();
    expect(screen.getByRole('main').contains(toggle)).toBe(false);
    fireEvent.click(toggle);
    expect(root.dataset.theme).toBe('light');
    expect(localStorage.getItem('dispatch:theme')).toBe('light');
  } finally {
    delete root.dataset.theme;
    localStorage.removeItem('dispatch:theme');
  }
});

afterEach(() => {
  window.location.hash = '';
});

test('the brand and skip links never rewrite the address hash', () => {
  window.location.hash = '#/task/T-1';
  render(
    <GateFrame>
      <p>the gate</p>
    </GateFrame>
  );
  fireEvent.click(screen.getByRole('link', { name: 'Dispatch' }));
  expect(window.location.hash).toBe('#/task/T-1');
  // The skip link moves focus to the main instead of following '#main'.
  fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
  expect(window.location.hash).toBe('#/task/T-1');
  expect(document.activeElement).toBe(screen.getByRole('main'));
});

// A field whose value lives in component state, like GitStep's "Your name".
function NameField() {
  const [name, setName] = useState('');
  return (
    <label>
      Your name
      <input value={name} onChange={(event) => setName(event.target.value)} />
    </label>
  );
}

// The app over a hidden gate: Settings with a field of its own, unmounted on close.
function Host({ settings }: { settings: boolean }) {
  return (
    <>
      <GateFrame hidden={settings}>
        <NameField />
      </GateFrame>
      {settings && (
        <div role="region" aria-label="Settings">
          <input aria-label="Search settings" />
        </div>
      )}
    </>
  );
}

test('hidden keeps the gate mounted, and showing it again puts focus back', async () => {
  const { rerender } = render(<Host settings={false} />);
  const name = screen.getByLabelText<HTMLInputElement>('Your name');
  name.focus();
  fireEvent.change(name, { target: { value: 'Ada' } });

  // Settings over the gate: the gate is hidden, not unmounted.
  await act(async () => {
    rerender(<Host settings />);
    await Promise.resolve();
  });
  screen.getByLabelText('Search settings').focus();
  expect(screen.getByTestId('gate-frame').style.display).toBe('none');
  expect(screen.queryByRole('main')).toBeNull();

  // Settings closes with focus inside it: the value and the focus are back.
  await act(async () => {
    rerender(<Host settings={false} />);
    await Promise.resolve();
  });
  const back = screen.getByLabelText<HTMLInputElement>('Your name');
  expect(back).toBe(name);
  expect(back.value).toBe('Ada');
  expect(document.activeElement).toBe(back);
});

test('with nothing focused in the gate before, focus goes to its main', async () => {
  const { rerender } = render(<Host settings />);
  screen.getByLabelText('Search settings').focus();
  await act(async () => {
    rerender(<Host settings={false} />);
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(screen.getByRole('main'));
});
