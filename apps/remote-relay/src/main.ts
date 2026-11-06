import { startRelay } from './relay.js';

// The container entrypoint: Railway injects PORT and fronts this with TLS,
// which is what makes the daemons' and phones' wss:// URLs secure.
const relay = startRelay({
  port: Number(process.env.PORT ?? 8080),
  trustForwardedFor: process.env.RELAY_TRUST_PROXY === '1',
  log: (line) => console.log(line),
});
console.log(`dispatch remote relay listening on :${relay.port}`);
