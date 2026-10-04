import { childEnv } from '@dispatch/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CdpConnection } from './cdp.js';
import { buildPickerScript, PICK_RESULT_GLOBAL } from './pickerScript.js';

/**
 * A Chromium the daemon drives.
 *
 * Headed by default, which is the point rather than an oversight: Design Mode
 * is someone looking at their own app and pointing at the thing that is wrong.
 * A headless browser can be scripted but not pointed at, so `headless` is
 * opt-in for the scripted uses (a snapshot in CI, a `dispatch browser` call
 * from a script).
 */

export interface LaunchOptions {
  /** Defaults to the first Chromium found on this machine. */
  executablePath?: string;
  headless?: boolean;
  url?: string;
  /** Viewport, applied through the window rather than emulation. */
  width?: number;
  height?: number;
  /**
   * Extra Chromium flags.
   *
   * The one that matters in practice is `--no-sandbox`, which Chromium
   * requires when it runs as root — in a container, or in CI. It is not
   * applied automatically: turning off a browser's sandbox is a real
   * reduction in isolation, and doing it silently on the user's behalf is the
   * kind of thing that should have to be asked for.
   */
  extraArgs?: string[];
}

interface PickedElement {
  selector: string;
  tagName: string;
  id: string | null;
  className: string | null;
  text: string;
  outerHTML: string;
  outerHTMLTruncated: boolean;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  url: string;
}

export type PickOutcome =
  | { state: 'picked'; element: PickedElement; screenshot: string }
  | { state: 'cancelled' }
  | { state: 'waiting' };

// Where a Chromium-based browser is on each platform, in the order a person is
// likely to have them. Any of them speaks the DevTools protocol this drives. `CHROME_PATH` wins over all of it, which is both the documented escape
// hatch and what lets a test point at a downloaded build.
const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/snap/bin/brave',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
};

/** The browser this machine can launch, or null when there is none. */
export function findChrome(
  platform: string = process.platform,
  exists: (path: string) => boolean = (path) => Bun.file(path).size > 0,
  which: (name: string) => string | null = (name) => Bun.which(name)
): string | null {
  const configured = process.env.CHROME_PATH;
  if (configured !== undefined && configured !== '') return configured;
  for (const candidate of CHROME_CANDIDATES[platform] ?? []) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable path is simply not a candidate.
    }
  }
  for (const name of [
    'google-chrome',
    'chromium',
    'chromium-browser',
    'chrome',
    'microsoft-edge',
    'brave-browser',
  ]) {
    const found = which(name);
    if (found !== null) return found;
  }
  return null;
}

/** Reads the websocket endpoint Chromium prints to stderr on startup. */
export function parseDevToolsUrl(line: string): string | null {
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
  return match?.[1] ?? null;
}

/**
 * Extra Chromium flags from `DISPATCH_CHROME_ARGS`, split on whitespace.
 *
 * The escape hatch for environments the daemon cannot detect its way out of.
 * The one that comes up in practice is `--no-sandbox`, which Chromium requires
 * when it runs as root — in a container or in CI. Deliberately an explicit
 * opt-in rather than something the daemon decides for itself: turning off a
 * browser's sandbox is a real reduction in isolation, and it should be
 * somebody's decision rather than a silent fallback.
 */
export function envChromeArgs(
  raw: string | undefined = process.env.DISPATCH_CHROME_ARGS
): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.trim().split(/\s+/);
}

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserLaunchError';
  }
}

// How long to wait for Chromium to announce its debugging endpoint.
const LAUNCH_TIMEOUT_MS = 20_000;

export class BrowserSession {
  private constructor(
    readonly id: string,
    private readonly proc: { kill(): void; exited: Promise<number> },
    private readonly cdp: CdpConnection,
    private readonly targetId: string,
    private readonly profileDir: string
  ) {}

  static async launch(
    id: string,
    options: LaunchOptions = {}
  ): Promise<BrowserSession> {
    const executable = options.executablePath ?? findChrome();
    if (executable === null) {
      throw new BrowserLaunchError(
        'no Chrome or Chromium found — install one, or set CHROME_PATH to its binary'
      );
    }

    // A throwaway profile per session. Without it Chromium refuses to start a
    // second instance against a profile already in use, so a second browser
    // session would fail for reasons that look nothing like the cause.
    const profileDir = mkdtempSync(join(tmpdir(), 'dispatch-browser-'));
    const args = [
      // Port 0 lets the OS pick, and Chromium prints the real one; a fixed
      // port would collide with a browser the user already has open for
      // debugging.
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(options.headless === true ? ['--headless=new', '--disable-gpu'] : []),
      ...(options.width !== undefined && options.height !== undefined
        ? [`--window-size=${options.width},${options.height}`]
        : []),
      ...(options.extraArgs ?? []),
      ...envChromeArgs(),
      options.url ?? 'about:blank',
    ];

    const proc = Bun.spawn([executable, ...args], {
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const wsUrl = await readDevToolsUrl(proc.stderr, proc.exited);
    if (wsUrl === null) {
      proc.kill();
      rmSync(profileDir, { recursive: true, force: true });
      throw new BrowserLaunchError(
        'Chromium started but never announced a DevTools endpoint'
      );
    }

    const cdp = await CdpConnection.connect(wsUrl);
    // The browser-level socket can drive a page only through a target session,
    // so attach to the tab and keep its session id for every page command.
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const pageTarget = Array.isArray(targets)
      ? (targets as { targetId?: unknown; type?: unknown }[]).find(
          (target) => target.type === 'page'
        )
      : undefined;
    if (pageTarget === undefined || typeof pageTarget.targetId !== 'string') {
      cdp.close();
      proc.kill();
      throw new BrowserLaunchError('Chromium opened no page to attach to');
    }
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    if (typeof sessionId !== 'string') {
      cdp.close();
      proc.kill();
      throw new BrowserLaunchError('Chromium refused to attach to its page');
    }

    const session = new BrowserSession(id, proc, cdp, sessionId, profileDir);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('DOM.enable');
    return session;
  }

  /** Every page command goes through the attached target's session. */
  private send(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    return this.cdp.send(method, params, this.targetId);
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
  }

  async currentUrl(): Promise<string> {
    const result = await this.evaluate('location.href');
    return typeof result === 'string' ? result : '';
  }

  /** Runs an expression in the page and returns its value. */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // Without this, a page whose own script threw earlier can leave the
      // evaluation reporting an exception that has nothing to do with us.
      userGesture: true,
    });
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception !== undefined) {
      throw new Error(exception.text ?? 'evaluation failed');
    }
    const value = result.result as { value?: unknown } | undefined;
    return value?.value;
  }

  /** A base64 PNG of the page, or of one element's box. */
  async screenshot(clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  }): Promise<string> {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip === undefined
        ? {}
        : { clip: { ...clip, scale: clip.scale ?? 1 } }),
    });
    return typeof result.data === 'string' ? result.data : '';
  }

  /**
   * Clicks the first element matching `selector`.
   *
   * Through the element's own `click()` rather than synthesized mouse events
   * at coordinates: a scripted click should not depend on the element being
   * scrolled into view, and coordinates go stale the moment the page reflows.
   */
  async click(selector: string): Promise<void> {
    const found = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`
    );
    if (found !== true) throw new Error(`no element matches ${selector}`);
  }

  /**
   * Types a value into the first element matching `selector`.
   *
   * The `input` and `change` events are dispatched by hand because setting
   * `value` from script does not fire them, and every framework that binds a
   * field — React included — is listening for exactly those. Without them the
   * page looks filled in and the app has not noticed.
   */
  async fill(selector: string, value: string): Promise<void> {
    const found = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          'value'
        )?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
    );
    if (found !== true) throw new Error(`no element matches ${selector}`);
  }

  /** The visible text of the first element matching `selector`. */
  async textOf(selector: string): Promise<string | null> {
    const text = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? (el.innerText ?? el.textContent ?? '') : null;
      })()`
    );
    return typeof text === 'string' ? text : null;
  }

  /** Arms Design Mode: the next click in the page is captured, not delivered. */
  async startPicking(): Promise<void> {
    await this.evaluate(buildPickerScript());
  }

  /**
   * What the picker has captured so far.
   *
   * Polled rather than pushed: the alternative is a CDP binding whose callback
   * has to survive reloads and re-injection, and the UI is asking on a timer
   * regardless. A picked element also comes back with a cropped screenshot of
   * exactly that element, which is the part that makes it useful in a prompt.
   */
  async pickResult(): Promise<PickOutcome> {
    const raw = await this.evaluate(`window.${PICK_RESULT_GLOBAL} ?? null`);
    if (raw === null || raw === undefined) return { state: 'waiting' };
    const value = raw as Partial<PickedElement> & { cancelled?: boolean };
    if (value.cancelled === true) {
      await this.evaluate(`window.${PICK_RESULT_GLOBAL} = null`);
      return { state: 'cancelled' };
    }
    if (typeof value.selector !== 'string' || value.rect === undefined) {
      return { state: 'waiting' };
    }

    const element = value as PickedElement;
    // The rect is in CSS pixels relative to the viewport, which is exactly
    // what `Page.captureScreenshot`'s clip wants — no scaling needed, since
    // the capture is taken at the same scale the page is laid out in.
    const screenshot = await this.screenshot({
      x: element.rect.x,
      y: element.rect.y,
      width: Math.max(1, element.rect.width),
      height: Math.max(1, element.rect.height),
    });
    await this.evaluate(`window.${PICK_RESULT_GLOBAL} = null`);
    return { state: 'picked', element, screenshot };
  }

  close(): void {
    this.cdp.close();
    this.proc.kill();
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}

/**
 * Waits for the `DevTools listening on ws://…` line Chromium prints at
 * startup, rather than polling `/json/version` on a port we guessed. With
 * `--remote-debugging-port=0` there is no port to guess: this line is the only
 * place the real one appears.
 */
async function readDevToolsUrl(
  stderr: ReadableStream<Uint8Array>,
  exited: Promise<number>
): Promise<string | null> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), LAUNCH_TIMEOUT_MS);
    timer.unref?.();
  });
  // A Chromium that dies on startup (a bad flag, a missing library) would
  // otherwise leave this waiting out the full timeout for a line that is never
  // coming.
  const died = exited.then(() => null);

  const scan = (async (): Promise<string | null> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
      const url = parseDevToolsUrl(buffered);
      if (url !== null) return url;
      // Chromium is noisy on stderr; keep only enough to span a split line.
      if (buffered.length > 8192) buffered = buffered.slice(-4096);
    }
  })();

  try {
    return await Promise.race([scan, deadline, died]);
  } finally {
    reader.releaseLock();
  }
}
