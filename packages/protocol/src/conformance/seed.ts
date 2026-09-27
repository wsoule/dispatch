// A deterministic byte source (mulberry32) for the ULID factory, so a vector's
// ids repeat run to run; vectors still compare ids only through symbols.
export function seededBytes(seed: number): (n: number) => Uint8Array {
  let state = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = (t ^ (t >>> 14)) & 0xff;
    }
    return out;
  };
}
