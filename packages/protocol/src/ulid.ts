const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function increment(digits: number[]): void {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < 31) {
      digits[i] += 1;
      return;
    }
    digits[i] = 0;
  }
  throw new Error('ulid random component overflowed within one millisecond');
}

// Returns a ULID generator: 48-bit ms time + 80 random bits, strictly
// increasing even for same-millisecond calls or a clock that steps back.
export function createUlidFactory(
  randomBytes: (n: number) => Uint8Array = defaultRandom
): (nowMs: number) => string {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return (nowMs: number): string => {
    if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIME) {
      throw new RangeError(`ulid time out of range: ${nowMs}`);
    }
    if (nowMs <= lastTime) {
      increment(lastRandom);
    } else {
      lastTime = nowMs;
      // 256 is a multiple of 32, so byte % 32 stays uniform.
      lastRandom = Array.from(randomBytes(16), (b) => b % 32);
    }
    return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join('');
  };
}
