import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { encode } from 'uqr';

import { QrCode } from '../src/index';

afterEach(cleanup);

describe('QrCode', () => {
  test('is an image named by its label, sized by the prop', () => {
    render(
      <QrCode
        value="dispatch-remote://pair?c=abc"
        label="Pairing code"
        size={160}
        data-testid="qr"
      />
    );
    const img = screen.getByRole('img', { name: 'Pairing code' });
    const tile = screen.getByTestId('qr');
    expect(tile.style.width).toBe('160px');
    expect(tile.contains(img)).toBe(true);
  });

  test('draws one square per dark module of the encoded value', () => {
    const value = 'dispatch-remote://pair?c=abc';
    const { data } = encode(value, { ecc: 'M', border: 0 });
    const dark = data.flat().filter(Boolean).length;
    const { container } = render(<QrCode value={value} label="Code" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe(
      `0 0 ${data.length} ${data.length}`
    );
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d.match(/M/g)?.length).toBe(dark);
  });
});
