import { type ApiClient, ApiError, type WorkspaceFile } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Activity, type ReactNode } from 'react';

import { FilePreview, PREVIEW_MAX_BYTES, previewPlan } from './FilePreview';

type PreviewClient = Pick<
  ApiClient,
  'fetchWorkspaceBlob' | 'workspaceDownloadUrl' | 'workspaceFileUrl'
>;

// Object URLs made and revoked during a test, in order. happy-dom's own
// createObjectURL is replaced so each blob gets a predictable name and the
// type the preview gave it can be read back.
let created: { url: string; type: string }[] = [];
let revoked: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  created = [];
  revoked = [];
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:preview-${created.length + 1}`;
    created.push({ url, type: (blob as Blob).type });
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

// A client whose raw reads answer with `respond` and whose download tickets
// come from `ticket` (by default each one a fresh URL, `…?ticket=t-<n>`),
// recording each path read and each ticket asked for. Its raw-route links
// have the shape the real client builds for a loopback daemon.
function fakeClient(
  respond: (path: string) => Promise<Blob> = () =>
    Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
  ticket?: (path: string) => Promise<string>
): PreviewClient & {
  reads: string[];
  tickets: { path: string; runId: string | null | undefined }[];
} {
  const reads: string[] = [];
  const tickets: { path: string; runId: string | null | undefined }[] = [];
  return {
    reads,
    tickets,
    fetchWorkspaceBlob: (path: string) => {
      reads.push(path);
      return respond(path);
    },
    workspaceDownloadUrl: (path: string, scope?: { runId?: string | null }) => {
      tickets.push({ path, runId: scope?.runId });
      return ticket === undefined
        ? Promise.resolve(
            `http://127.0.0.1:4100/api/files/raw?ticket=t-${tickets.length}`
          )
        : ticket(path);
    },
    workspaceFileUrl: (path: string) =>
      `http://127.0.0.1:4100/api/files/raw?${new URLSearchParams({ path }).toString()}`,
  };
}

// Replaces HTMLAnchorElement's click for one test, recording the href and
// download name of each link clicked (the page's throwaway download links);
// `restore` puts the real click back.
function recordLinkClicks(): {
  clicked: { href: string; download: string }[];
  restore: () => void;
} {
  const clicked: { href: string; download: string }[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = mock(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
  return {
    clicked,
    restore: () => {
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

// A file as the daemon describes it; each case overrides what it is about.
function file(patch: Partial<WorkspaceFile>): WorkspaceFile {
  return {
    path: 'NOTES.md',
    runId: null,
    size: 10,
    modifiedAt: '2026-11-03T00:00:00Z',
    mime: 'text/markdown',
    preview: 'none',
    kind: 'text',
    text: '',
    ...patch,
  };
}

const PNG = file({
  path: 'shot.png',
  mime: 'image/png',
  preview: 'image',
  kind: 'binary',
  text: null,
});

test('a markdown file a run wrote never auto-loads its images, even loopback ones', () => {
  const client = fakeClient();
  const { container } = render(
    <FilePreview
      client={client}
      file={file({
        text: '# Notes\n![probe](http://127.0.0.1:4100/api/secret.png)\n',
      })}
      runId={null}
    />
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('[image: probe]');
  expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
  expect(client.reads).toEqual([]);
});

test('an image is read with the client and shown from a blob URL, never the raw route', async () => {
  const client = fakeClient();
  const { container } = render(
    <FilePreview client={client} file={PNG} runId="run-1" />
  );
  // Loading first: a skeleton, no element pointing anywhere yet.
  expect(screen.getByRole('status').textContent).toBe('Loading shot.png');
  expect(container.querySelector('img')).toBeNull();
  const img = await screen.findByRole('img', { name: 'shot.png' });
  expect(img.getAttribute('src')).toBe('blob:preview-1');
  expect(client.reads).toEqual(['shot.png']);
  // Re-typed from the file's mime, whatever the response said.
  expect(created).toEqual([{ url: 'blob:preview-1', type: 'image/png' }]);
});

test('the blob URL is revoked when the file changes and when the preview unmounts', async () => {
  const client = fakeClient();
  const view = render(<FilePreview client={client} file={PNG} runId={null} />);
  await screen.findByRole('img', { name: 'shot.png' });
  const other = { ...PNG, path: 'other.png' };
  view.rerender(<FilePreview client={client} file={other} runId={null} />);
  expect(revoked).toEqual(['blob:preview-1']);
  const next = await screen.findByRole('img', { name: 'other.png' });
  expect(next.getAttribute('src')).toBe('blob:preview-2');
  view.unmount();
  expect(revoked).toEqual(['blob:preview-1', 'blob:preview-2']);
});

test('an equal file never reads the bytes twice; a changed mtime does', async () => {
  const client = fakeClient();
  const view = render(<FilePreview client={client} file={PNG} runId={null} />);
  await screen.findByRole('img', { name: 'shot.png' });
  // A new WorkspaceFile object for the same file, as a reopen produces.
  view.rerender(<FilePreview client={client} file={{ ...PNG }} runId={null} />);
  await Promise.resolve();
  expect(client.reads).toEqual(['shot.png']);
  expect(revoked).toEqual([]);
  view.rerender(
    <FilePreview
      client={client}
      file={{ ...PNG, modifiedAt: '2026-11-03T00:05:00Z' }}
      runId={null}
    />
  );
  await waitFor(() =>
    expect(
      screen.getByRole('img', { name: 'shot.png' }).getAttribute('src')
    ).toBe('blob:preview-2')
  );
  expect(client.reads).toEqual(['shot.png', 'shot.png']);
});

test('a read that resolves after the file changed is dropped, not shown or leaked', async () => {
  let release: (blob: Blob) => void = () => undefined;
  const client = fakeClient((path) =>
    path === 'slow.png'
      ? new Promise<Blob>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(new Blob([new Uint8Array([1])]))
  );
  const view = render(
    <FilePreview
      client={client}
      file={{ ...PNG, path: 'slow.png' }}
      runId={null}
    />
  );
  view.rerender(<FilePreview client={client} file={PNG} runId={null} />);
  await screen.findByRole('img', { name: 'shot.png' });
  release(new Blob([new Uint8Array([9])]));
  await Promise.resolve();
  // Only the current file ever became an object URL.
  expect(created.map((entry) => entry.url)).toEqual(['blob:preview-1']);
  expect(
    screen.getByRole('img', { name: 'shot.png' }).getAttribute('src')
  ).toBe('blob:preview-1');
});

test('a failed read is a danger notice with the daemon message, not a broken image', async () => {
  const client = fakeClient(() =>
    Promise.reject(Object.assign(new Error('no such file'), { status: 404 }))
  );
  const { container } = render(
    <FilePreview client={client} file={PNG} runId={null} />
  );
  const alert = await screen.findByRole('alert');
  expect(alert.getAttribute('data-tone')).toBe('danger');
  expect(alert.textContent).toContain('Could not load the preview');
  expect(alert.textContent).toContain('no such file');
  expect(container.querySelector('img')).toBeNull();
  expect(created).toEqual([]);
});

test('an image the webview cannot decode turns into the error line', async () => {
  const client = fakeClient();
  render(<FilePreview client={client} file={PNG} runId={null} />);
  const img = await screen.findByRole('img', { name: 'shot.png' });
  fireEvent.error(img);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('The image could not be decoded.');
  expect(screen.queryByRole('img', { name: 'shot.png' })).toBeNull();
});

test('a PDF renders in a titled frame from a blob typed application/pdf', async () => {
  // about:blank, so happy-dom loads no page into the frame.
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    created.push({ url: 'about:blank', type: (blob as Blob).type });
    return 'about:blank';
  };
  const client = fakeClient(() =>
    // A daemon answer with a wrong type must not make the frame a document.
    Promise.resolve(new Blob(['<script>1</script>'], { type: 'text/html' }))
  );
  const { container } = render(
    <FilePreview
      client={client}
      file={file({
        path: 'spec.pdf',
        mime: 'application/pdf',
        preview: 'pdf',
        kind: 'binary',
        text: null,
      })}
      runId={null}
    />
  );
  await waitFor(() =>
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
      'about:blank'
    )
  );
  expect(container.querySelector('iframe')?.getAttribute('title')).toBe(
    'spec.pdf'
  );
  expect(created).toEqual([{ url: 'about:blank', type: 'application/pdf' }]);
});

test('an SVG previews as an image from a data: URL, never a same-origin blob: URL', async () => {
  // A blob: URL would live in the app's origin without the raw route's CSP,
  // so the SVG's script could run there if the URL were opened as a page.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
  const client = fakeClient(() =>
    Promise.resolve(new Blob([svg], { type: 'text/plain' }))
  );
  render(
    <FilePreview
      client={client}
      file={file({
        path: 'logo.svg',
        mime: 'image/svg+xml',
        preview: 'image',
        kind: 'text',
        text: svg,
      })}
      runId={null}
    />
  );
  const img = await screen.findByRole('img', { name: 'logo.svg' });
  const src = img.getAttribute('src') ?? '';
  expect(src.startsWith('blob:')).toBe(false);
  expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  expect(atob(src.slice(src.indexOf(',') + 1))).toBe(svg);
  expect(created).toEqual([]);
  expect(client.reads).toEqual(['logo.svg']);
});

test('a media file over the preview cap is offered as a download, never read up front', () => {
  const client = fakeClient();
  render(
    <FilePreview
      client={client}
      file={file({
        path: 'talk.mp4',
        mime: 'video/mp4',
        preview: 'video',
        kind: 'too-large',
        size: PREVIEW_MAX_BYTES + 1,
        text: null,
      })}
      runId={null}
    />
  );
  expect(screen.getByText(/^Too large to preview \(/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
  expect(client.reads).toEqual([]);
});

const DUMP = file({
  path: 'logs/dump.log',
  size: 5 * 1024 * 1024,
  kind: 'too-large',
  text: null,
});

const BINARY = file({
  path: 'app.bin',
  size: 2048,
  mime: 'application/octet-stream',
  kind: 'binary',
  text: null,
});

test('a file too large to open says its size, and Download streams it through a ticket URL minted on click', async () => {
  const client = fakeClient();
  const links = recordLinkClicks();
  try {
    render(<FilePreview client={client} file={DUMP} runId="run-3" />);
    expect(
      screen.getByText('Too large to open in the editor (5.0 MB).')
    ).toBeTruthy();
    // Nothing is asked for before the click: a ticket dies after a minute.
    expect(client.tickets).toEqual([]);
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('download')).toBe('dump.log');
    // fireEvent returns false when a handler called preventDefault: the bare
    // raw route, which 401s without the bearer header, is never navigated.
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(links.clicked).toHaveLength(1));
    expect(client.tickets).toEqual([{ path: 'logs/dump.log', runId: 'run-3' }]);
    expect(links.clicked[0]).toEqual({
      href: 'http://127.0.0.1:4100/api/files/raw?ticket=t-1',
      download: 'dump.log',
    });
    // The browser streams it: the page never read the bytes or made a blob.
    expect(client.reads).toEqual([]);
    expect(created).toEqual([]);
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Download' }).hasAttribute('aria-busy')
      ).toBe(false)
    );
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    links.restore();
  }
});

test('every Download asks for a fresh ticket, and a click while one is pending does nothing', async () => {
  let issue: (url: string) => void = () => undefined;
  const client = fakeClient(
    undefined,
    () =>
      new Promise<string>((resolve) => {
        issue = resolve;
      })
  );
  const links = recordLinkClicks();
  try {
    render(<FilePreview client={client} file={BINARY} runId={null} />);
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    const busy = screen.getByRole('link', { name: 'Downloading…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // A second click while the ticket is on its way neither asks again nor
    // follows the bare raw route.
    expect(fireEvent.click(busy)).toBe(false);
    expect(client.tickets).toHaveLength(1);
    await act(async () => {
      issue('http://127.0.0.1:4100/api/files/raw?ticket=first');
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    await act(async () => {
      issue('http://127.0.0.1:4100/api/files/raw?ticket=second');
      await Promise.resolve();
    });
    expect(client.tickets).toHaveLength(2);
    expect(links.clicked.map((entry) => entry.href)).toEqual([
      'http://127.0.0.1:4100/api/files/raw?ticket=first',
      'http://127.0.0.1:4100/api/files/raw?ticket=second',
    ]);
    expect(client.reads).toEqual([]);
  } finally {
    links.restore();
  }
});

// What a daemon from before tickets answers the ticket route: its catch-all
// 404 for a route it does not know.
const NO_TICKET_ROUTE = () =>
  Promise.reject(new ApiError('not found: /api/files/download-ticket', 404));

test('when the daemon has no ticket route, Download falls back to reading the bytes and saving them', async () => {
  const client = fakeClient(undefined, NO_TICKET_ROUTE);
  const links = recordLinkClicks();
  try {
    render(<FilePreview client={client} file={DUMP} runId="run-3" />);
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    await waitFor(() => expect(links.clicked).toHaveLength(1));
    expect(client.tickets).toHaveLength(1);
    expect(client.reads).toEqual(['logs/dump.log']);
    expect(links.clicked[0]).toEqual({
      href: 'blob:preview-1',
      download: 'dump.log',
    });
    // Saved as plain bytes: the minute-long URL is never a document of the
    // file's own type in the app's origin.
    expect(created).toEqual([
      { url: 'blob:preview-1', type: 'application/octet-stream' },
    ]);
    // The fallback worked, so there is nothing to report.
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    links.restore();
  }
});

test('when the ticket route is missing and the fallback read fails too, the danger line gives both reasons and the link stays usable', async () => {
  const client = fakeClient(
    () => Promise.reject(new Error('request failed: 401')),
    NO_TICKET_ROUTE
  );
  render(<FilePreview client={client} file={BINARY} runId={null} />);
  expect(
    screen.getByText('Binary file (2.0 KB, application/octet-stream).')
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Download' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    'Download failed: not found: /api/files/download-ticket (reading it into the page failed too: request failed: 401)'
  );
  expect(alert.getAttribute('data-tone')).toBe('danger');
  expect(client.tickets).toHaveLength(1);
  expect(client.reads).toEqual(['app.bin']);
  expect(created).toEqual([]);
  expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
});

test('a failure with no message still says what went wrong', async () => {
  const client = fakeClient(
    () => Promise.reject(new Error('')),
    () => Promise.reject(new ApiError('', 404))
  );
  render(<FilePreview client={client} file={BINARY} runId={null} />);
  fireEvent.click(screen.getByRole('link', { name: 'Download' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    'Download failed: the daemon issued no download link (reading it into the page failed too: the daemon did not send the file)'
  );
});

// Every refusal but a missing route is about this file or this moment, so the
// page shows it and never reads a file of any size into the tab instead: a
// server error, the file gone, a token refused, or no answer at all.
test('a ticket refused for any other reason shows that reason alone and never reads the file into the page', async () => {
  const huge = file({
    path: 'media/huge.webm',
    size: PREVIEW_MAX_BYTES * 40,
    mime: 'video/webm',
    preview: 'video',
    kind: 'binary',
    text: null,
  });
  for (const refusal of [
    new ApiError('internal error', 500),
    new ApiError('the daemon is restarting', 503),
    new ApiError('no such file', 404),
    new ApiError('token rejected', 401, 'auth_invalid_token'),
    new TypeError('Failed to fetch'),
  ]) {
    const client = fakeClient(undefined, () => Promise.reject(refusal));
    const view = render(
      <FilePreview client={client} file={huge} runId={null} />
    );
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`Download failed: ${refusal.message}`);
    expect(client.tickets).toHaveLength(1);
    expect(client.reads).toEqual([]);
    expect(created).toEqual([]);
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
    view.unmount();
  }
});

test("on a team-local page Download is the browser's own streamed download of the raw route", () => {
  // dispatchd injects this into the page it serves in team-local mode, where
  // the session cookie authenticates a navigation.
  const page = globalThis as { __DISPATCH_SHARED__?: unknown };
  page.__DISPATCH_SHARED__ = { root: '/srv/team' };
  try {
    const client = fakeClient();
    render(
      <FilePreview
        client={client}
        file={file({
          path: 'media/huge.mp4',
          size: PREVIEW_MAX_BYTES + 1,
          mime: 'video/mp4',
          preview: 'video',
          kind: 'binary',
          text: null,
        })}
        runId={null}
      />
    );
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('href')).toBe(
      'http://127.0.0.1:4100/api/files/raw?path=media%2Fhuge.mp4'
    );
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.click(link)).toBe(true);
    expect(client.tickets).toEqual([]);
    expect(client.reads).toEqual([]);
    expect(created).toEqual([]);
    expect(link.hasAttribute('aria-busy')).toBe(false);
  } finally {
    delete page.__DISPATCH_SHARED__;
  }
});

test('previewPlan: preview wins over kind, and an unexpected mime is never shown', () => {
  expect(previewPlan(file({ preview: 'image', mime: 'image/png' }))).toEqual({
    as: 'image',
    type: 'image/png',
  });
  // An image-flagged file whose mime is not an image falls back by kind.
  expect(
    previewPlan(
      file({ preview: 'image', mime: 'text/html', kind: 'binary', text: null })
    )
  ).toEqual({ as: 'plain', reason: 'binary' });
  expect(previewPlan(file({ preview: 'none', kind: 'text' }))).toEqual({
    as: 'markdown',
  });
  expect(
    previewPlan(
      file({ preview: 'audio', mime: 'audio/mpeg', kind: 'binary', text: null })
    )
  ).toEqual({ as: 'audio', type: 'audio/mpeg' });
});

// The Files page under a hidden Activity, as the shell holds it while
// Settings or the Overseer covers it.
function hosted(
  client: PreviewClient,
  mode: 'visible' | 'hidden',
  shown = true,
  preview: WorkspaceFile = PNG
): ReactNode {
  return (
    <Activity mode={mode}>
      {shown ? (
        <FilePreview client={client} file={preview} runId={null} />
      ) : null}
    </Activity>
  );
}

test('a hide and show keeps the URL: no second read, no revoke, the same src', async () => {
  const client = fakeClient();
  const view = render(hosted(client, 'visible'));
  await screen.findByRole('img', { name: 'shot.png' });
  view.rerender(hosted(client, 'hidden'));
  await waitFor(() => expect(revoked).toEqual([]));
  view.rerender(hosted(client, 'visible'));
  const img = await screen.findByRole('img', { name: 'shot.png' });
  expect(img.getAttribute('src')).toBe('blob:preview-1');
  expect(client.reads).toEqual(['shot.png']);
  expect(revoked).toEqual([]);
  view.unmount();
  expect(revoked).toEqual(['blob:preview-1']);
});

test('a preview removed while hidden revokes its URL then', async () => {
  const client = fakeClient();
  const view = render(hosted(client, 'visible'));
  await screen.findByRole('img', { name: 'shot.png' });
  view.rerender(hosted(client, 'hidden'));
  await Promise.resolve();
  expect(revoked).toEqual([]);
  // No cleanup runs for a hidden subtree; the removal itself releases it.
  view.rerender(hosted(client, 'hidden', false));
  await waitFor(() => expect(revoked).toEqual(['blob:preview-1']));
});

test('a file changed while hidden is read again on show, and the old URL goes', async () => {
  const client = fakeClient();
  const view = render(hosted(client, 'visible'));
  await screen.findByRole('img', { name: 'shot.png' });
  view.rerender(hosted(client, 'hidden'));
  const other = { ...PNG, path: 'other.png' };
  view.rerender(hosted(client, 'hidden', true, other));
  view.rerender(hosted(client, 'visible', true, other));
  const img = await screen.findByRole('img', { name: 'other.png' });
  expect(img.getAttribute('src')).toBe('blob:preview-2');
  expect(revoked).toEqual(['blob:preview-1']);
});

test("a download's busy state and failure stay with the file they were for", async () => {
  let issue: (url: string) => void = () => undefined;
  const client = fakeClient(
    () => Promise.reject(new Error('no such file')),
    (path) =>
      path === 'a.bin'
        ? Promise.reject(new ApiError('no such file', 404))
        : path === 'b.bin'
          ? new Promise<string>((resolve) => {
              issue = resolve;
            })
          : Promise.resolve(
              `http://127.0.0.1:4100/api/files/raw?ticket=${path}`
            )
  );
  const links = recordLinkClicks();
  const binary = (path: string) => ({ ...BINARY, path });
  try {
    const view = render(
      <FilePreview client={client} file={binary('a.bin')} runId={null} />
    );
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    await screen.findByRole('alert');
    // b.bin opens: a.bin's failure does not follow it.
    view.rerender(
      <FilePreview client={client} file={binary('b.bin')} runId={null} />
    );
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    expect(
      screen
        .getByRole('link', { name: 'Downloading…' })
        .getAttribute('aria-busy')
    ).toBe('true');
    // c.bin opens while b.bin's ticket is still on its way: its own link is
    // idle and works.
    view.rerender(
      <FilePreview client={client} file={binary('c.bin')} runId={null} />
    );
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(link);
    await waitFor(() =>
      expect(links.clicked.map((entry) => entry.href)).toEqual([
        'http://127.0.0.1:4100/api/files/raw?ticket=c.bin',
      ])
    );
    expect(client.tickets.map((entry) => entry.path)).toEqual([
      'a.bin',
      'b.bin',
      'c.bin',
    ]);
    // b.bin's ticket arriving late still starts b.bin's own download, and
    // changes nothing on c.bin's link.
    await act(async () => {
      issue('http://127.0.0.1:4100/api/files/raw?ticket=b.bin');
      await Promise.resolve();
    });
    expect(links.clicked.map((entry) => entry.href)).toEqual([
      'http://127.0.0.1:4100/api/files/raw?ticket=c.bin',
      'http://127.0.0.1:4100/api/files/raw?ticket=b.bin',
    ]);
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // Nothing was read into the page: a.bin's ticket was refused for the
    // file itself, which reading it would not have changed.
    expect(client.reads).toEqual([]);
  } finally {
    links.restore();
  }
});

// The desktop app: Tauri's `invoke` calls `window.__TAURI_INTERNALS__.invoke`,
// so defining it plays the backend (and makes isTauri() true) without
// mock.module, which bun hoists across every file in the run. Each command is
// recorded with its arguments; `respond` answers download_workspace_file.
type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
  };
};

function playDesktopBackend(respond: () => Promise<unknown>): {
  calls: { cmd: string; args: unknown }[];
} {
  const calls: { cmd: string; args: unknown }[] = [];
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'download_workspace_file') return respond();
      if (cmd === 'reveal_in_finder') return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    },
  };
  return { calls };
}

// Runs `body` with navigator.platform reading `platform`, the value the
// library's isApplePlatform falls back to (happy-dom has no userAgentData),
// then puts the real one back.
async function onPlatform(
  platform: string,
  body: () => Promise<void> | void
): Promise<void> {
  const own = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    get: () => platform,
  });
  try {
    await body();
  } finally {
    if (own === undefined) {
      Reflect.deleteProperty(navigator, 'platform');
    } else {
      Object.defineProperty(navigator, 'platform', own);
    }
  }
}

test('in the desktop app Download saves through the backend and offers Reveal in Finder on macOS', async () => {
  await onPlatform('MacIntel', savesThroughTheBackend);
});

async function savesThroughTheBackend(): Promise<void> {
  let finish: (path: string) => void = () => undefined;
  const backend = playDesktopBackend(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  try {
    const client = fakeClient();
    render(
      <FilePreview
        client={client}
        file={file({
          path: 'media/huge.mp4',
          size: PREVIEW_MAX_BYTES + 1,
          mime: 'video/mp4',
          preview: 'video',
          kind: 'binary',
          text: null,
        })}
        runId="run-7"
      />
    );
    // fireEvent returns false when a handler called preventDefault: the
    // webview's own download (which wry cancels) never starts.
    expect(
      fireEvent.click(screen.getByRole('link', { name: 'Download' }))
    ).toBe(false);
    expect(
      screen
        .getByRole('link', { name: 'Downloading…' })
        .getAttribute('aria-busy')
    ).toBe('true');
    // The backend gets the raw route's address and nothing else: no token,
    // and the page never reads the bytes itself.
    expect(backend.calls).toEqual([
      {
        cmd: 'download_workspace_file',
        args: {
          url: 'http://127.0.0.1:4100/api/files/raw?path=media%2Fhuge.mp4',
        },
      },
    ]);
    expect(client.tickets).toEqual([]);
    expect(client.reads).toEqual([]);
    expect(created).toEqual([]);
    // The status line is there, empty, before the save lands, so a screen
    // reader announces it when it fills.
    expect(screen.getByRole('status').textContent).toBe('');

    await act(async () => {
      finish('/Users/me/Downloads/huge (1).mp4');
      await Promise.resolve();
    });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(
      'Saved to /Users/me/Downloads/huge (1).mp4'
    );
    expect(
      screen.getByRole('link', { name: 'Download' }).hasAttribute('aria-busy')
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(backend.calls.at(-1)).toEqual({
      cmd: 'reveal_in_finder',
      args: { path: '/Users/me/Downloads/huge (1).mp4' },
    });
  } finally {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  }
}

test('away from macOS the saved file is shown in its folder, not in Finder', async () => {
  await onPlatform('Win32', async () => {
    const backend = playDesktopBackend(() =>
      Promise.resolve('C:\\Users\\me\\Downloads\\app.bin')
    );
    try {
      render(
        <FilePreview
          client={fakeClient()}
          file={{ ...BINARY, path: 'platform/app.bin' }}
          runId={null}
        />
      );
      fireEvent.click(screen.getByRole('link', { name: 'Download' }));
      const show = await screen.findByRole('button', {
        name: 'Show in folder',
      });
      expect(
        screen.queryByRole('button', { name: 'Reveal in Finder' })
      ).toBeNull();
      fireEvent.click(show);
      expect(backend.calls.at(-1)).toEqual({
        cmd: 'reveal_in_finder',
        args: { path: 'C:\\Users\\me\\Downloads\\app.bin' },
      });
    } finally {
      delete (window as TauriWindow).__TAURI_INTERNALS__;
    }
  });
});

test("in the desktop app a refused save shows the backend's reason and the link stays usable", async () => {
  await onPlatform('MacIntel', refusedSaveKeepsTheLink);
});

async function refusedSaveKeepsTheLink(): Promise<void> {
  const backend = playDesktopBackend(() =>
    Promise.reject('No running Dispatch daemon answers on port 4100.')
  );
  try {
    render(
      <FilePreview
        client={fakeClient()}
        file={file({
          path: 'app.bin',
          size: 2048,
          mime: 'application/octet-stream',
          kind: 'binary',
          text: null,
        })}
        runId={null}
      />
    );
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Download failed: No running Dispatch daemon answers on port 4100.'
    );
    expect(screen.getByRole('status').textContent).toBe('');
    expect(
      screen.queryByRole('button', { name: 'Reveal in Finder' })
    ).toBeNull();
    // A second try goes out again: the old failure clears while it runs.
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    expect(backend.calls).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    await screen.findByRole('alert');
  } finally {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  }
}

test('in the desktop app a save outlives its link: back on the file it says where the file went', async () => {
  await onPlatform('MacIntel', saveOutlivesItsLink);
});

async function saveOutlivesItsLink(): Promise<void> {
  let finish: (path: string) => void = () => undefined;
  const backend = playDesktopBackend(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const binary = (path: string) => ({ ...BINARY, path });
  try {
    const client = fakeClient();
    const view = render(
      <FilePreview
        client={client}
        file={binary('remount/app.bin')}
        runId="run-9"
      />
    );
    fireEvent.click(screen.getByRole('link', { name: 'Download' }));
    // Another file opens while the backend is still writing this one.
    view.rerender(
      <FilePreview
        client={client}
        file={binary('remount/other.bin')}
        runId="run-9"
      />
    );
    expect(
      screen.getByRole('link', { name: 'Download' }).hasAttribute('aria-busy')
    ).toBe(false);
    // Back on the first file mid-save: still busy, and a click starts no
    // second copy.
    view.rerender(
      <FilePreview
        client={client}
        file={binary('remount/app.bin')}
        runId="run-9"
      />
    );
    const busy = screen.getByRole('link', { name: 'Downloading…' });
    expect(fireEvent.click(busy)).toBe(false);
    expect(
      backend.calls.filter((c) => c.cmd === 'download_workspace_file')
    ).toHaveLength(1);
    // It finishes while the other file is open again.
    view.rerender(
      <FilePreview
        client={client}
        file={binary('remount/other.bin')}
        runId="run-9"
      />
    );
    await act(async () => {
      finish('/Users/me/Downloads/app.bin');
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toBe('');
    view.rerender(
      <FilePreview
        client={client}
        file={binary('remount/app.bin')}
        runId="run-9"
      />
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Saved to /Users/me/Downloads/app.bin'
    );
    expect(
      screen.getByRole('button', { name: 'Reveal in Finder' })
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Download' }).hasAttribute('aria-busy')
    ).toBe(false);
  } finally {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  }
}
