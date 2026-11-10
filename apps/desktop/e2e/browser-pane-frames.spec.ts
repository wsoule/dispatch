import { expect, type Frame, type Page, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';

import { APP_TOKEN, DAEMON_PORT, VITE_PORT } from './paths';

// The browser pane frames pages with `allow-same-origin`, and `browserRefusal`
// only sees the address the pane sets. These pages start somewhere allowed and
// then move the frame onto the app's origin or the daemon's, which only the
// browser can stop: the app and the daemon's shell answer with
// `frame-ancestors 'none'`, and daemon previews with a CSP sandbox.

const APP = `http://localhost:${VITE_PORT}/`;
const DAEMON = `http://localhost:${DAEMON_PORT}`;
const PREVIEW = `${DAEMON}/preview/r-nothing/`;

// Serves the pages that move their frame: two HTTP redirects and one script.
function startMover(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/redirect-to-app') {
      res.writeHead(302, { location: APP }).end();
    } else if (req.url === '/redirect-to-preview') {
      res.writeHead(302, { location: PREVIEW }).end();
    } else if (req.url === '/script-to-app') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<p>moving</p><script>setTimeout(() => { location.href = ${JSON.stringify(APP)}; }, 50);</script>`
        );
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let mover: Server | null = null;

// The mover's port, once beforeAll has started it.
function moverPort(): number {
  const address = mover?.address() ?? null;
  if (address === null || typeof address === 'string') {
    throw new Error('the mover server has no port');
  }
  return address.port;
}

function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token)
    throw new Error('DISPATCH_E2E_TOKEN is unset; see global-setup.ts');
  return `${baseURL}&token=${token}&appToken=${APP_TOKEN}`;
}

// Opens the Overseer's browser pane and points it at `address`.
async function openInPane(page: Page, address: string): Promise<void> {
  await expect(page.getByTestId('overseer-view')).toBeVisible();
  await page.getByTestId('overseer-browser-toggle').click();
  const field = page.getByTestId('browser-pane').getByLabel('Address');
  await field.fill(address);
  await field.press('Enter');
  await expect(page.getByTitle('Browser page')).toBeAttached();
}

// The pane's frame once it reaches a URL starting with `prefix`.
async function paneFrameAt(page: Page, prefix: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(() => {
      found = page.frames().find((f) => f.url().startsWith(prefix));
      return found !== undefined;
    })
    .toBe(true);
  if (found === undefined) throw new Error(`no frame at ${prefix}`);
  return found;
}

// Whether the pane's frame holds a document the app can reach into, which it
// can only when the frame shares the app's origin.
function frameIsSameOriginWithApp(page: Page): Promise<boolean> {
  return page
    .getByTitle('Browser page')
    .evaluate((el) => (el as HTMLIFrameElement).contentDocument !== null);
}

test.beforeAll(async () => {
  mover = await startMover();
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (mover === null) resolve();
    else mover.close(() => resolve());
  });
});

test.describe('the browser pane after its frame navigates', () => {
  // The first test pays the app's cold load, which runs past 30s in WebKit.
  test.slow();
  for (const path of ['/redirect-to-app', '/script-to-app']) {
    test(`refuses the app's own origin (${path})`, async ({
      page,
      baseURL,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
      const refused: string[] = [];
      page.on('console', (msg) => {
        if (msg.text().includes('frame-ancestors')) refused.push(msg.text());
      });
      await page.goto(authedUrl(baseURL));
      await openInPane(page, `localhost:${moverPort()}${path}`);

      await expect.poll(() => refused.length).toBeGreaterThan(0);
      expect(await frameIsSameOriginWithApp(page)).toBe(false);
    });
  }

  test('runs a daemon preview with an opaque origin', async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    await page.goto(authedUrl(baseURL));
    await openInPane(page, `localhost:${moverPort()}/redirect-to-preview`);

    const frame = await paneFrameAt(page, PREVIEW);
    // A same-origin preview could fetch the daemon's `/` and read its token.
    expect(await frame.evaluate(() => window.origin)).toBe('null');
  });
});
