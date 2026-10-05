import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

import { WsConnection } from '../../src/relay/ws.js';

// A socket that records what the connection writes and whether it closed.
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  write(b: Buffer | string): boolean {
    this.written.push(Buffer.from(b));
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

// A masked client frame.
function frame(opcode: number, payload: Buffer, fin = true, rsv = 0): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  const head =
    payload.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, 0x80 | payload.length])
      : Buffer.from([
          (fin ? 0x80 : 0) | rsv | opcode,
          0x80 | 126,
          payload.length >> 8,
          payload.length & 0xff,
        ]);
  return Buffer.concat([head, mask, masked]);
}

// The close code the connection sent, if any.
function closeCode(s: FakeSocket): number | null {
  const close = s.written.find((b) => (b[0] & 0x0f) === 0x8);
  return close === undefined || close.length < 4 ? null : close.readUInt16BE(2);
}

function conn(max = 1024) {
  const s = new FakeSocket();
  const c = new WsConnection(s as unknown as Duplex, max);
  const got: string[] = [];
  c.onMessage = (t) => got.push(t);
  return { s, c, got };
}

describe('WsConnection strictness (relay review M3)', () => {
  it('reassembles a fragmented text message', () => {
    const { s, got } = conn();
    s.emit('data', frame(0x1, Buffer.from('hel'), false));
    s.emit('data', frame(0x0, Buffer.from('lo')));
    expect(got).toEqual(['hello']);
  });

  it('refuses a control frame over 125 bytes or without FIN', () => {
    const a = conn();
    a.s.emit('data', frame(0x9, Buffer.alloc(126)));
    expect(closeCode(a.s)).toBe(1002);
    const b = conn();
    b.s.emit('data', frame(0x9, Buffer.alloc(1), false));
    expect(closeCode(b.s)).toBe(1002);
  });

  it('refuses a new data frame inside a fragmented message, and a stray continuation', () => {
    const a = conn();
    a.s.emit('data', frame(0x1, Buffer.from('a'), false));
    a.s.emit('data', frame(0x1, Buffer.from('b')));
    expect(closeCode(a.s)).toBe(1002);
    const b = conn();
    b.s.emit('data', frame(0x0, Buffer.from('b')));
    expect(closeCode(b.s)).toBe(1002);
  });

  it('refuses RSV bits and invalid UTF-8', () => {
    const a = conn();
    a.s.emit('data', frame(0x1, Buffer.from('a'), true, 0x40));
    expect(closeCode(a.s)).toBe(1002);
    const b = conn();
    b.s.emit('data', frame(0x1, Buffer.from([0xff, 0xfe])));
    expect(closeCode(b.s)).toBe(1007);
    expect(b.got).toEqual([]);
  });

  it('caps a message at its current limit, which can be raised after auth', () => {
    const a = conn(16);
    a.s.emit('data', frame(0x1, Buffer.alloc(32, 0x61)));
    expect(closeCode(a.s)).toBe(1009);
    const b = conn(16);
    b.c.setMaxMessage(64);
    b.s.emit('data', frame(0x1, Buffer.alloc(32, 0x61)));
    expect(b.got).toHaveLength(1);
  });

  it('counts any frame from the peer as alive, and reports how long it has been silent', () => {
    const { s, c } = conn();
    const before = c.silentForMs();
    s.emit('data', frame(0xa, Buffer.alloc(0)));
    expect(c.silentForMs()).toBeLessThanOrEqual(before + 5);
  });
});
