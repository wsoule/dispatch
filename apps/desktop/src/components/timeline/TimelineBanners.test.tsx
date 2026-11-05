import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import type { TimelineBanner } from '../../adapters/timeline';
import { TimelineBanners } from './TimelineBanners';

afterEach(cleanup);

const BANNERS: TimelineBanner[] = [
  {
    id: 'no_lead',
    label: 'No lead',
    tone: 'warning',
    count: 1,
    text: '1 active project has no lead, so its milestones fail the rubric.',
    items: [{ id: 'p-1', label: 'Search', href: '#/task/p-1' }],
  },
  {
    id: 'unplanned',
    label: 'Unplanned',
    tone: 'warning',
    count: 2,
    text: '2 open issues in 1 project have no milestone, so no milestone counts them. Move them into one, or cancel them.',
    items: [
      { id: 't-1', label: 'Search › Rebuild the index', href: '#/task/t-1' },
      { id: 't-2', label: 'Search › Tune the ranker', href: '#/task/t-2' },
    ],
    action: { label: 'Plan in Issues', href: '#/issues' },
  },
];

describe('TimelineBanners', () => {
  test('renders nothing when every banner is empty', () => {
    const { container } = render(<TimelineBanners banners={[]} />);
    expect(container.innerHTML).toBe('');
  });

  test('one row per banner: lead-in, sentence, follow-up link, and a list the Show button expands', () => {
    render(<TimelineBanners banners={BANNERS} />);
    const panel = screen.getByRole('region', { name: 'Missing inputs' });
    const rows = panel.querySelectorAll('[data-banner-id]');
    expect(
      Array.from(rows).map((row) => row.getAttribute('data-banner-id'))
    ).toEqual(['no_lead', 'unplanned']);
    expect(within(panel).getByText('No lead')).toBeTruthy();
    expect(
      within(panel).getByText(/1 active project has no lead/)
    ).toBeTruthy();
    expect(
      within(panel)
        .getByRole('link', { name: 'Plan in Issues' })
        .getAttribute('href')
    ).toBe('#/issues');

    // The lists start closed; Show opens one and names the count.
    expect(within(panel).queryByRole('link', { name: 'Search' })).toBeNull();
    const show = within(panel).getByRole('button', { name: 'Show 2 items' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    expect(show.textContent).toBe('Hide');
    expect(
      within(panel)
        .getByRole('link', { name: 'Search › Tune the ranker' })
        .getAttribute('href')
    ).toBe('#/task/t-2');
    // The other row's list stays closed.
    expect(within(panel).queryByRole('link', { name: 'Search' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 1 item' }));
    expect(within(panel).getByRole('link', { name: 'Search' })).toBeTruthy();
    fireEvent.click(show);
    expect(
      within(panel).queryByRole('link', { name: 'Search › Tune the ranker' })
    ).toBeNull();
  });

  test('every row carries its tone for the data-tone hook', () => {
    render(<TimelineBanners banners={BANNERS} />);
    const strips = screen
      .getByRole('region', { name: 'Missing inputs' })
      .querySelectorAll('[data-tone="warning"]');
    expect(strips.length).toBe(2);
  });
});
