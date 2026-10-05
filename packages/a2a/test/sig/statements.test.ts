import { describe, expect, it } from 'bun:test';

import { parseUnpairNotice, unpairNotice } from '../../src/sig/statements.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const AT = new Date('2026-10-01T00:00:00Z');

describe('unpair notices', () => {
  it('round-trips a notice', () => {
    expect(parseUnpairNotice(unpairNotice(ID, AT))).toEqual({
      id: ID,
      at: AT.toISOString(),
    });
  });

  it('refuses another statement kind, a bad id or a bad time', () => {
    const good = unpairNotice(ID, AT);
    expect(
      parseUnpairNotice({ ...good, tag: 'dispatch-a2a-rotate-v1' })
    ).toBeNull();
    expect(parseUnpairNotice({ ...good, id: 'short' })).toBeNull();
    expect(parseUnpairNotice({ ...good, at: 'yesterday' })).toBeNull();
    expect(parseUnpairNotice([good])).toBeNull();
    expect(parseUnpairNotice(null)).toBeNull();
  });
});
