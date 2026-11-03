import type { ApiClient, WorkspaceFile } from '@dispatch/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Activity, type ReactNode } from 'react';

import { FilePreview, PREVIEW_MAX_BYTES, previewPlan } from './FilePreview';

type PreviewClient = Pick<ApiClient, 'fetchWorkspaceBlob' | 'workspaceFileUrl'>;

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

// A client whose raw reads answer with `respond`, recording each path read.
function fakeClient(
  respond: (path: string) => Promise<Blob> = () =>
    Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]))
): PreviewClient & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fetchWorkspaceBlob: (path: string) => {
      reads.push(path);
      return respond(path);
    },
    workspaceFileUrl: (path: string) => `http://127.0.0.1:4100/raw/${path}`,
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

test('a file too large to open says its size, and Download reads it with the client', async () => {
  const client = fakeClient();
  const clicked: { href: string; download: string }[] = [];
  const click = mock(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = click;
  try {
    render(
      <FilePreview
        client={client}
        file={file({
          path: 'logs/dump.log',
          size: 5 * 1024 * 1024,
          kind: 'too-large',
          text: null,
        })}
        runId={null}
      />
    );
    expect(
      screen.getByText('Too large to open in the editor (5.0 MB).')
    ).toBeTruthy();
    expect(client.reads).toEqual([]);
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('download')).toBe('dump.log');
    fireEvent.click(link);
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(client.reads).toEqual(['logs/dump.log']);
    expect(clicked[0]).toEqual({
      href: 'blob:preview-1',
      download: 'dump.log',
    });
    // Saved as plain bytes: the minute-long URL is never a document of the
    // file's own type in the app's origin.
    expect(created).toEqual([
      { url: 'blob:preview-1', type: 'application/octet-stream' },
    ]);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
  }
});

test('a failed download says so in a danger line and leaves the link usable', async () => {
  const client = fakeClient(() =>
    Promise.reject(new Error('request failed: 401'))
  );
  render(
    <FilePreview
      client={client}
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
  expect(
    screen.getByText('Binary file (2.0 KB, application/octet-stream).')
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Download' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Download failed: request failed: 401');
  expect(alert.getAttribute('data-tone')).toBe('danger');
  expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
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
      'http://127.0.0.1:4100/raw/media/huge.mp4'
    );
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.click(link)).toBe(true);
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
  let release: (blob: Blob) => void = () => undefined;
  const client = fakeClient((path) =>
    path === 'a.bin'
      ? Promise.reject(new Error('no such file'))
      : path === 'b.bin'
        ? new Promise<Blob>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(new Blob([new Uint8Array([1])]))
  );
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = mock(() => undefined);
  const binary = (path: string) =>
    file({
      path,
      size: 2048,
      mime: 'application/octet-stream',
      kind: 'binary',
      text: null,
    });
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
    // c.bin opens while b.bin is still read: its own link is idle and works.
    view.rerender(
      <FilePreview client={client} file={binary('c.bin')} runId={null} />
    );
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(link);
    await waitFor(() =>
      expect(client.reads).toEqual(['a.bin', 'b.bin', 'c.bin'])
    );
    release(new Blob([new Uint8Array([2])]));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy()
    );
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
  }
});
