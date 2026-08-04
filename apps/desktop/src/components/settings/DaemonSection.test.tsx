import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { DaemonSection } from './DaemonSection';
import { dataWith, testProject as project } from './fixtures.test-helper';

const data = dataWith();

// The old copy said only "this view is read-only" — the reason matters, because
// a status is stored by name in every task file on disk.
test('the read-only statuses list gives the real reason', () => {
  render(<DaemonSection activeProject={project} data={data} />);
  expect(screen.getByText(/every task file/i)).toBeDefined();
});

test('a failed daemon start shows the captured detail', () => {
  render(
    <DaemonSection
      activeProject={project}
      data={{ ...data, portError: true, portErrorDetail: 'port 7777 in use' }}
    />
  );
  expect(screen.getByText(/port 7777 in use/)).toBeDefined();
});
