import type { VerificationResult } from '@dispatch/client';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { VerificationSection } from './VerificationSection';

function result(overrides: Partial<VerificationResult>): VerificationResult {
  return {
    runId: 'r-1',
    taskId: 't-1',
    pass: false,
    checks: [],
    artifacts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('renders nothing when never exercised and nothing ran', () => {
  const { container } = render(
    <VerificationSection exercised={false} result={null} error={null} />
  );
  expect(container.firstElementChild).toBeNull();
});

// Each check says Passed or Failed in words (the glyph is decorative); a
// failure shows expected and actual, the actual in the danger tone.
test('lists checks with their pass or fail words and a failure detail', () => {
  const { container } = render(
    <VerificationSection
      exercised
      error={null}
      result={result({
        checks: [
          { check: 'Build', expected: '', actual: '', pass: true },
          { check: 'Login', expected: '200', actual: '500', pass: false },
        ],
      })}
    />
  );
  expect(screen.getByRole('heading', { name: 'Verification' })).toBeDefined();
  const exercised = screen.getByText('Exercised');
  expect(exercised.getAttribute('data-tone')).toBe('success');
  expect(screen.getByText('· 1/2 checks passed')).toBeDefined();
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="verification-check"]')
  );
  expect(rows.map((r) => r.dataset.pass ?? 'false')).toEqual(['true', 'false']);
  expect(rows[0]?.textContent).toContain('Passed');
  expect(rows[1]?.textContent).toContain('Failed');
  const actual = screen.getByText('500');
  expect(actual.classList.contains('toneText')).toBe(true);
  expect(actual.getAttribute('data-tone')).toBe('danger');
});

test('says Not exercised without a tone, and a load error in the danger tone', () => {
  render(
    <VerificationSection
      exercised={false}
      result={null}
      error="checks are unavailable"
    />
  );
  expect(screen.getByText('Not exercised').hasAttribute('data-tone')).toBe(
    false
  );
  const error = screen.getByText('checks are unavailable');
  expect(error.getAttribute('data-tone')).toBe('danger');
});

// An absolute artifact path is a chip button (it reveals the file); anything
// else is a plain chip. Both set the path in mono.
test('renders artifacts as chips, revealable ones as buttons', () => {
  render(
    <VerificationSection
      exercised
      error={null}
      result={result({ artifacts: ['/tmp/shot.png', 'report.html'] })}
    />
  );
  const reveal = screen.getByRole('button', { name: '/tmp/shot.png' });
  expect(reveal.getAttribute('title')).toBe('/tmp/shot.png');
  const plain = screen.getByText('report.html');
  expect(plain.classList.contains('mono')).toBe(true);
  expect(plain.closest('button')).toBeNull();
});
