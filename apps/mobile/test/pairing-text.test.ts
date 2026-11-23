import { generateKeyPair, pairingUrl } from '@dispatch/remote';
import { describe, expect, test } from 'bun:test';

import { readPairingText } from '../src/pairing';

const offer = {
  relay: 'wss://remote.dispatch.foo',
  daemonId: 'a'.repeat(32),
  daemonKey: generateKeyPair().publicKey,
  offerId: '0123456789abcdef',
  code: crypto.getRandomValues(new Uint8Array(32)),
  name: "Ada's Mac · dispatch",
};
const link = pairingUrl(offer);

describe('reading what was pasted into the pairing box', () => {
  test('takes the link as the Mac shows it', () => {
    const read = readPairingText(link);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.offer.offerId).toBe(offer.offerId);
  });

  test('finds the link inside surrounding text and line breaks', () => {
    expect(readPairingText(`  Pair: ${link}\n`).ok).toBe(true);
    const wrapped = `${link.slice(0, 40)}\n${link.slice(40)}`;
    expect(readPairingText(wrapped).ok).toBe(true);
  });

  test('takes a link a browser or chat app percent-encoded', () => {
    expect(readPairingText(encodeURIComponent(link)).ok).toBe(true);
  });

  test("says when it is the desktop app's device link, not the iPhone code", () => {
    const read = readPairingText(
      'dispatch://pair?url=http%3A%2F%2F127.0.0.1%3A4771&code=ABCD-EFGH'
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('Show code under iPhone');
  });

  test('says the same for a bare device pairing code', () => {
    const read = readPairingText('ABCD-EFGH');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('Show code under iPhone');
  });

  test('still refuses anything else, saying where the right code is', () => {
    const read = readPairingText('hello');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('Settings › Devices');
  });
});
