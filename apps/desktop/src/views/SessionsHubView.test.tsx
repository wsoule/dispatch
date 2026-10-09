import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { SessionsHubView } from './SessionsHubView';

afterEach(cleanup);

test('outside the desktop app, Usage says where to find it instead of loading forever', () => {
  render(<SessionsHubView />);
  expect(screen.getByText('Usage lives in the desktop app')).toBeDefined();
});
