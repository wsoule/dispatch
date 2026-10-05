// The relay's tenants: one live connection per card-key thumbprint, found
// from a request path's /t/<thumbprint> prefix and nothing else.

const TENANT_PATH = /^\/t\/([A-Za-z0-9_-]{43})(\/.*)?$/;

export class TenantRouter<Conn> {
  private readonly live = new Map<string, Conn>();

  /** Admits `conn` for `thumbprint`; the connection it replaced, if any. */
  admit(thumbprint: string, conn: Conn): Conn | null {
    const previous = this.live.get(thumbprint) ?? null;
    this.live.set(thumbprint, conn);
    return previous;
  }

  /** Drops `conn`, unless another connection replaced it meanwhile. */
  drop(thumbprint: string, conn: Conn): void {
    if (this.live.get(thumbprint) === conn) this.live.delete(thumbprint);
  }

  connOf(thumbprint: string): Conn | null {
    return this.live.get(thumbprint) ?? null;
  }

  /** The live tenant a path names, and the rest of it; null for anything else. */
  route(path: string): { tenant: string; rest: string } | null {
    const m = TENANT_PATH.exec(path);
    if (m === null || !this.live.has(m[1])) return null;
    return { tenant: m[1], rest: m[2] ?? '/' };
  }
}
