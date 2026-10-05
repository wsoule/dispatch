import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

// A minimal server-side WebSocket (RFC 6455) for the relay's tenant
// connections: text messages, ping/pong and close, with fragmented messages
// reassembled up to a cap. Client frames must be masked; ours are not.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The Sec-WebSocket-Accept value for a client's key. */
function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** The 101 response that completes a WebSocket handshake. */
export function handshake(key: string): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n');
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x80 | opcode, len])
      : len < 65_536
        ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127]),
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64BE(BigInt(len));
              return b;
            })(),
          ]);
  return Buffer.concat([head, payload]);
}

export class WsConnection {
  private buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partsLength = 0;
  private fragmenting = false;
  private closed = false;
  private lastSeen = Date.now();
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(
    private readonly socket: Duplex,
    private maxMessage: number
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.lastSeen = Date.now();
      this.read(chunk);
    });
    socket.on('close', () => this.ended());
    socket.on('error', () => this.ended());
  }

  /** Raises (or lowers) the message cap: small before auth, larger after. */
  setMaxMessage(bytes: number): void {
    this.maxMessage = bytes;
  }

  /** How long since the peer last sent anything (a pong counts). */
  silentForMs(): number {
    return Date.now() - this.lastSeen;
  }

  send(text: string): void {
    if (!this.closed) this.socket.write(frame(0x1, Buffer.from(text)));
  }

  ping(): void {
    if (!this.closed) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.socket.write(frame(0x8, payload));
    this.socket.end();
    this.ended();
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose();
  }

  // Frames are read strictly (RFC 6455 5.2-5.5): masked, no RSV bits, control
  // frames short and never fragmented, continuations only inside a message, and
  // text that is valid UTF-8.
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.closed || this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const control = opcode >= 0x8;
      if ((b0 & 0x70) !== 0 || (b1 & 0x80) === 0) return this.close(1002);
      let len = b1 & 0x7f;
      let offset = 2;
      if (control && (!fin || len > 125)) return this.close(1002);
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) return this.close(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxMessage) return this.close(1009);
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(
        this.buffer.subarray(offset + 4, offset + 4 + len)
      );
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1) {
        if (this.fragmenting) return this.close(1002);
      } else if (opcode === 0x0) {
        if (!this.fragmenting) return this.close(1002);
      } else {
        // A reserved opcode (3-7, 11-15).
        return this.close(1002);
      }
      this.partsLength += payload.length;
      if (this.partsLength > this.maxMessage) return this.close(1009);
      this.parts.push(payload);
      this.fragmenting = !fin;
      if (!fin) continue;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(this.parts)
        );
      } catch {
        return this.close(1007);
      }
      this.parts = [];
      this.partsLength = 0;
      this.onMessage(text);
    }
  }
}
