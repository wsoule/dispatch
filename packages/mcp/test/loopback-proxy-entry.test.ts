import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'src', 'bin.ts');

// The bin's first act is exemptLoopbackFromProxy (core's
// loopback-proxy.test.ts proves that keeps a loopback fetch off HTTP_PROXY).
// This checks the wiring: a preload records NO_PROXY as the process exits,
// after the bin ran `hooks claude`, which prints a config and exits without
// touching the network, from an environment whose lists hold only a corporate
// host.
describe('dispatch-mcp entry', () => {
  it('adds the loopback addresses to NO_PROXY before it does anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-mcp-no-proxy-'));
    try {
      const probe = join(dir, 'probe.ts');
      writeFileSync(
        probe,
        "process.on('exit', () => process.stderr.write(`\\nNO_PROXY=${process.env.NO_PROXY}\\nno_proxy=${process.env.no_proxy}\\n`));\n"
      );
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/proxy/i.test(key)) env[key] = value;
      }
      Object.assign(env, {
        HTTP_PROXY: 'http://proxy.corp.invalid:3128',
        NO_PROXY: 'corp.internal',
        no_proxy: 'corp.internal',
      });
      const child = Bun.spawn(
        [process.execPath, '--preload', probe, BIN, 'hooks', 'claude'],
        { env, stdout: 'pipe', stderr: 'pipe' }
      );
      const [err, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(err).toContain(
        '\nNO_PROXY=corp.internal,127.0.0.1,localhost,::1\n'
      );
      expect(err).toContain(
        '\nno_proxy=corp.internal,127.0.0.1,localhost,::1\n'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
