'use client';

import type { ReactNode } from 'react';
import { encode } from 'uqr';

import { dataAttributes } from '../lib/data-attributes';
import styles from './qr-code.module.css';
import type { QrCodeProps } from './types';

/* A QR code for a phone's camera to scan (the iPhone app's pairing link):
   dark modules on a light tile in both themes, since a camera reads an
   inverted code poorly, with the quiet zone the spec asks for. One SVG
   path, so it scales sharp at any size. It is an image named by `label`;
   the value itself is not announced, so pair it with a way to copy it. */
export function QrCode(props: QrCodeProps): ReactNode {
  const { value, label, size = 192 } = props;
  const { data } = encode(value, { ecc: 'M', border: 0 });
  const modules = data.length;
  let d = '';
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <div
      className={styles.tile}
      style={{ width: size, height: size }}
      {...dataAttributes(props)}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${modules} ${modules}`}
        shapeRendering="crispEdges"
        className={styles.code}
      >
        <path d={d} />
      </svg>
    </div>
  );
}
