// The three lines apps/demo/src/daemon.ts guarantees on stdout, in this
// order: the listen URL, then the app token, then the agent token. Shared by
// test/daemon.test.ts and src/sessions.ts so both read the same contract.
export interface DaemonStdout {
  port: number;
  appToken: string;
  agentToken: string;
}

const PATTERNS: { [K in keyof DaemonStdout]: RegExp } = {
  port: /listening on http:\/\/127\.0\.0\.1:(\d+)/,
  appToken: /DISPATCH_APP_TOKEN=([0-9a-f]+)/,
  agentToken: /DISPATCH_AGENT_TOKEN=([0-9a-f]+)/,
};

/**
 * Reads a spawned daemon's stdout until the port, app token, and agent token
 * have all appeared, or `timeoutMs` elapses. Throws on timeout so callers
 * never have to null-check a partially filled result.
 */
export async function parseDaemonStdout(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number
): Promise<DaemonStdout> {
  const found: Partial<Record<keyof DaemonStdout, string>> = {};
  const reader = stream.getReader();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Object.keys(found).length < 3 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const key of Object.keys(PATTERNS) as (keyof DaemonStdout)[]) {
        const match = PATTERNS[key].exec(buf);
        if (match?.[1] !== undefined) found[key] = match[1];
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (
    found.port === undefined ||
    found.appToken === undefined ||
    found.agentToken === undefined
  ) {
    throw new Error(
      'daemon did not emit the expected stdout contract within timeout'
    );
  }
  return {
    port: Number(found.port),
    appToken: found.appToken,
    agentToken: found.agentToken,
  };
}
