import { describe, expect, it } from 'bun:test';

import { TenantRouter } from '../../src/relay/router.js';

const A = 'a'.repeat(43);
const B = 'b'.repeat(43);

describe('TenantRouter', () => {
  it('routes /t/<thumbprint>/… to a live tenant only, and nothing else', () => {
    const r = new TenantRouter<object>();
    const conn = {};
    r.admit(A, conn);
    expect(r.route(`/t/${A}/a2a/v1/tasks`)).toEqual({
      tenant: A,
      rest: '/a2a/v1/tasks',
    });
    expect(r.route(`/t/${A}`)).toEqual({ tenant: A, rest: '/' });
    expect(r.route(`/t/${B}/a2a/v1/tasks`)).toBeNull();
    expect(r.route('/admin')).toBeNull();
    expect(r.route(`/t/${A}x/a2a`)).toBeNull();
  });

  it('a second admission replaces the first, and dropping a stale one changes nothing', () => {
    const r = new TenantRouter<object>();
    const first = {};
    const second = {};
    expect(r.admit(A, first)).toBeNull();
    expect(r.admit(A, second)).toBe(first);
    r.drop(A, first);
    expect(r.connOf(A)).toBe(second);
    r.drop(A, second);
    expect(r.connOf(A)).toBeNull();
    expect(r.route(`/t/${A}/a2a/v1`)).toBeNull();
  });
});
