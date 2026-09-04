/**
 * Runs `pnpm audit --audit-level critical` and separates its two failure
 * modes: a real critical advisory fails the gate, while a registry that
 * cannot be reached (timeouts against npm's advisories endpoint have failed
 * CI twice on otherwise-green runs) warns and passes — registry weather is
 * not a property of this commit. The audit still runs on every CI pass, so
 * an outage only ever defers the check to the next push.
 */
const proc = Bun.spawnSync(
  ['pnpm', 'audit', '--audit-level', 'critical', '--json'],
  { stdout: 'pipe', stderr: 'pipe' }
);
const out = proc.stdout.toString();
const err = proc.stderr.toString();

if (proc.exitCode === 0) process.exit(0);

const networkShaped =
  /TimeoutError|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|aborted due to timeout|error \(2\d\)\. Will retry/i;
// pnpm prints advisory JSON on stdout when it actually evaluated advisories;
// a run that died talking to the registry has none.
const evaluated = /"advisories"|"vulnerabilities"/.test(out);

if (!evaluated && networkShaped.test(out + err)) {
  console.error(
    'audit-gate: npm registry unreachable — audit deferred, not failed.\n' +
      (err.trim().split('\n').slice(-3).join('\n') || out.slice(-300))
  );
  process.exit(0);
}

console.error(err || out);
process.exit(proc.exitCode ?? 1);
