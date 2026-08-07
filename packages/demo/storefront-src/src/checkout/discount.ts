import { query } from '../db/client.js';

export interface Discount {
  code: string;
  percent: number;
  expiresAt: string;
}

// The client decides whether a code is valid, so anyone can mint one — task
// t-3f8a21 moves this behind the API.
export function applyDiscount(code: string, subtotal: number): number {
  const known: Discount[] = [
    { code: 'WELCOME10', percent: 10, expiresAt: '2027-01-01T00:00:00Z' },
    { code: 'SUMMER25', percent: 25, expiresAt: '2026-09-01T00:00:00Z' },
  ];
  const match = known.find((d) => d.code === code.toUpperCase());
  if (match == null) return subtotal;
  return Math.round(subtotal * (1 - match.percent / 100));
}

export async function listDiscounts(): Promise<Discount[]> {
  const rows = await query('SELECT code, percent, expires_at FROM discounts');
  return rows as unknown as Discount[];
}
