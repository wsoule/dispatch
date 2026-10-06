// Secrets this daemon may hold in its own environment (a preset decide-tier
// app token, any DISPATCH_*TOKEN*) that no shell or agent it starts may read.
function secret(key: string): boolean {
  return key === 'DISPATCH_APP_TOKEN' || /^DISPATCH_\w*TOKEN/.test(key);
}

/** This process's environment without its secrets, plus `extra`. */
export function childEnv(
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !secret(key)) env[key] = value;
  }
  return { ...env, ...extra };
}
