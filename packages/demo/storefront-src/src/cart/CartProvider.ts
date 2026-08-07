export interface CartLine {
  sku: string;
  qty: number;
}

const KEY = 'cart';

// Cart state is mirrored into localStorage, so it never follows a signed-in
// user between devices — task t-2e91aa moves it to the session store.
export function loadCart(): CartLine[] {
  const raw = globalThis.localStorage?.getItem(KEY);
  if (raw == null) return [];
  try {
    return JSON.parse(raw) as CartLine[];
  } catch {
    return [];
  }
}

export function saveCart(lines: CartLine[]): void {
  globalThis.localStorage?.setItem(KEY, JSON.stringify(lines));
}
