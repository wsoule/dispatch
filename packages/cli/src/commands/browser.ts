import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';

import type { ApiClient, PickOutcome } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { appTokenClient } from './appToken.js';

/**
 * `dispatch browser` — script the Chromium the daemon drives.
 *
 * Every subcommand needs the daemon's APP token rather than the agent token
 * it hands out on disk. That is not an inconvenience to work around: these
 * commands run arbitrary script in a browser carrying the user's own session
 * cookies, so a credential an agent can read must not reach them.
 */

// How long `pick` waits for the user to click something before giving up.
const PICK_TIMEOUT_MS = 120_000;
const PICK_POLL_MS = 250;

// `--token` is on every subcommand rather than the group, because commander
// does not pass a group-level option down to an action handler.
function withTokenOption(command: Command): Command {
  return command.option(
    '--token <token>',
    'the daemon app token (or DISPATCH_APP_TOKEN)'
  );
}

/** Writes a base64 PNG to a file, or prints it when no path was given. */
function emitScreenshot(
  ctx: CliContext,
  screenshot: string,
  out: string | undefined
): void {
  if (out === undefined) {
    ctx.log(screenshot);
    return;
  }
  writeFileSync(out, Buffer.from(screenshot, 'base64'));
  ctx.log(`wrote ${out}`);
}

export function registerBrowserCommands(
  program: Command,
  ctx: CliContext
): void {
  const browser = program
    .command('browser')
    .description('Drive a Chromium the daemon controls');

  withTokenOption(
    browser
      .command('open [url]')
      .description('Open a browser and print its session id')
      .option('--headless', 'run without a window (for scripts and CI)')
      .option('--width <px>', 'window width', Number)
      .option('--height <px>', 'window height', Number)
      .option('--json')
  ).action(
    async (
      url: string | undefined,
      opts: {
        headless?: boolean;
        width?: number;
        height?: number;
        json?: boolean;
        token?: string;
      }
    ) => {
      const api = await appTokenClient(
        ctx,
        opts.token,
        'dispatch browser open'
      );
      const info = await api.launchBrowser({
        ...(url === undefined ? {} : { url }),
        ...(opts.headless === true ? { headless: true } : {}),
        ...(opts.width === undefined ? {} : { width: opts.width }),
        ...(opts.height === undefined ? {} : { height: opts.height }),
      });
      if (opts.json === true) {
        ctx.log(JSON.stringify(info, null, 2));
        return;
      }
      ctx.log(`${info.id}  ${info.url}${info.headless ? '  (headless)' : ''}`);
    }
  );

  withTokenOption(
    browser.command('list').description('Every open browser').option('--json')
  ).action(async (opts: { json?: boolean; token?: string }) => {
    const api = await appTokenClient(ctx, opts.token, 'dispatch browser list');
    const browsers = await api.listBrowsers();
    if (opts.json === true) {
      ctx.log(JSON.stringify(browsers, null, 2));
      return;
    }
    if (browsers.length === 0) {
      ctx.log('no browsers open');
      return;
    }
    for (const info of browsers) {
      ctx.log(`${info.id}  ${info.url}${info.picking ? '  (picking)' : ''}`);
    }
  });

  withTokenOption(
    browser
      .command('goto <id> <url>')
      .description('Navigate an open browser')
      .option('--json')
  ).action(
    async (
      id: string,
      url: string,
      opts: { json?: boolean; token?: string }
    ) => {
      const api = await appTokenClient(
        ctx,
        opts.token,
        'dispatch browser goto'
      );
      const info = await api.navigateBrowser(id, url);
      ctx.log(opts.json === true ? JSON.stringify(info, null, 2) : info.url);
    }
  );

  withTokenOption(
    browser
      .command('snapshot <id>')
      .description('Capture the page as a PNG')
      .option('--out <file>', 'write the PNG here instead of printing base64')
  ).action(async (id: string, opts: { out?: string; token?: string }) => {
    const api = await appTokenClient(
      ctx,
      opts.token,
      'dispatch browser snapshot'
    );
    const { screenshot } = await api.browserScreenshot(id);
    emitScreenshot(ctx, screenshot, opts.out);
  });

  withTokenOption(
    browser.command('click <id> <selector>').description('Click an element')
  ).action(async (id: string, selector: string, opts: { token?: string }) => {
    const api = await appTokenClient(ctx, opts.token, 'dispatch browser click');
    await api.browserClick(id, selector);
    ctx.log(`clicked ${selector}`);
  });

  withTokenOption(
    browser
      .command('fill <id> <selector> <value>')
      .description('Type a value into a field')
  ).action(
    async (
      id: string,
      selector: string,
      value: string,
      opts: { token?: string }
    ) => {
      const api = await appTokenClient(
        ctx,
        opts.token,
        'dispatch browser fill'
      );
      await api.browserFill(id, selector, value);
      ctx.log(`filled ${selector}`);
    }
  );

  withTokenOption(
    browser
      .command('text <id> <selector>')
      .description('Print an element’s visible text')
      .option('--json')
  ).action(
    async (
      id: string,
      selector: string,
      opts: { json?: boolean; token?: string }
    ) => {
      const api = await appTokenClient(
        ctx,
        opts.token,
        'dispatch browser text'
      );
      const result = await api.browserText(id, selector);
      ctx.log(
        opts.json === true ? JSON.stringify(result, null, 2) : result.text
      );
    }
  );

  withTokenOption(
    browser
      .command('eval <id> <expression>')
      .description('Evaluate JavaScript in the page')
      .option('--json')
  ).action(
    async (
      id: string,
      expression: string,
      opts: { json?: boolean; token?: string }
    ) => {
      const api = await appTokenClient(
        ctx,
        opts.token,
        'dispatch browser eval'
      );
      const { value } = await api.browserEvaluate(id, expression);
      // An expression can evaluate to anything; a bare `String()` on an
      // object prints `[object Object]`, which is never what anyone wanted to
      // see. Objects and arrays go through JSON, primitives print as
      // themselves.
      ctx.log(
        opts.json === true
          ? JSON.stringify({ value }, null, 2)
          : formatValue(value)
      );
    }
  );

  withTokenOption(
    browser
      .command('pick <id>')
      .description('Design Mode: click an element and print what it is')
      .option('--out <file>', 'also write the element’s screenshot here')
      .option('--json')
  ).action(
    async (
      id: string,
      opts: { out?: string; json?: boolean; token?: string }
    ) => {
      const api = await appTokenClient(
        ctx,
        opts.token,
        'dispatch browser pick'
      );
      await api.browserStartPick(id);
      ctx.log('click an element in the browser (Esc to cancel)…');
      const outcome = await pollForPick(api, id);
      if (outcome.state === 'cancelled') throw new CliError('pick cancelled');
      if (outcome.state !== 'picked') {
        throw new CliError('timed out waiting for a click');
      }

      if (opts.out !== undefined) {
        emitScreenshot(ctx, outcome.screenshot, opts.out);
      }
      if (opts.json === true) {
        ctx.log(JSON.stringify(outcome, null, 2));
        return;
      }
      const { element } = outcome;
      ctx.log(element.selector);
      ctx.log(element.outerHTML);
      for (const [prop, value] of Object.entries(element.styles)) {
        if (value !== '') ctx.log(`${prop}: ${value}`);
      }
    }
  );

  withTokenOption(
    browser.command('close <id>').description('Close a browser')
  ).action(async (id: string, opts: { token?: string }) => {
    const api = await appTokenClient(ctx, opts.token, 'dispatch browser close');
    await api.closeBrowser(id);
    ctx.log(`closed ${id}`);
  });
}

// One evaluated value as a line of terminal output.
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/**
 * Polls until the user clicks something, presses Escape, or the wait runs out.
 *
 * Exported for its own test: the loop's job is to keep asking without
 * spinning, and to give up rather than block a script forever.
 */
export async function pollForPick(
  api: Pick<ApiClient, 'browserPickResult'>,
  id: string,
  timeoutMs: number = PICK_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<PickOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await api.browserPickResult(id);
    if (outcome.state !== 'waiting') return outcome;
    if (Date.now() >= deadline) return { state: 'waiting' };
    await sleep(PICK_POLL_MS);
  }
}
