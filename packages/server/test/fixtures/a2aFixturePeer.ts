// A scripted A2A peer on loopback, run as its own process for the desktop e2e
// specs (Playwright runs under Node, FixturePeer needs Bun). Prints one JSON
// line, { url, control }, once both servers listen; the bearer is
// `peer-token`.
//
// Control (loopback only): GET /opened lists the asks it received, POST
// /answer { body } answers the latest one, GET /stats counts card fetches.
import { FixturePeer } from '../a2a/fixturePeer.js';

const peer = new FixturePeer().start();
const control = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/opened')
      return Response.json({ opened: peer.opened });
    if (req.method === 'GET' && path === '/stats')
      return Response.json({ cardFetches: peer.cardFetches });
    if (req.method === 'POST' && path === '/answer') {
      const { body } = (await req.json()) as { body?: unknown };
      if (typeof body !== 'string' || peer.latest() === '')
        return new Response('nothing to answer', { status: 409 });
      peer.answer(peer.latest(), body);
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  },
});

process.stdout.write(
  `${JSON.stringify({ url: peer.url, control: `http://127.0.0.1:${control.port}` })}\n`
);

const stop = () => {
  void control.stop(true);
  void peer.stop().then(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
