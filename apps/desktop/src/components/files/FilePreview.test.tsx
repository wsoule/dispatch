import type { ApiClient, WorkspaceFile } from '@dispatch/client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { FilePreview } from './FilePreview';

afterEach(cleanup);

const client = {
  workspaceFileUrl: (path: string) => `http://127.0.0.1:4100/raw/${path}`,
} as unknown as ApiClient;

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

test('a markdown file a run wrote never auto-loads its images, even loopback ones', () => {
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
});

test('an image file renders an <img> from the raw route, named by its path', () => {
  const { container } = render(
    <FilePreview
      client={client}
      file={file({
        path: 'shot.png',
        mime: 'image/png',
        preview: 'image',
        kind: 'binary',
        text: null,
      })}
      runId={null}
    />
  );
  const img = container.querySelector('img');
  expect(img?.getAttribute('src')).toBe('http://127.0.0.1:4100/raw/shot.png');
  expect(img?.getAttribute('alt')).toBe('shot.png');
});

test('a PDF renders in a titled frame', () => {
  // about:blank, so happy-dom loads no page into the frame over the network.
  const blank = {
    workspaceFileUrl: () => 'about:blank',
  } as unknown as ApiClient;
  const { container } = render(
    <FilePreview
      client={blank}
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
  const frame = container.querySelector('iframe');
  expect(frame?.getAttribute('title')).toBe('spec.pdf');
  expect(frame?.getAttribute('src')).toBe('about:blank');
});

test('a file too large to open says its size and offers Download', () => {
  render(
    <FilePreview
      client={client}
      file={file({
        path: 'dump.log',
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
  const link = screen.getByRole('link', { name: 'Download' });
  expect(link.getAttribute('href')).toBe('http://127.0.0.1:4100/raw/dump.log');
  expect(link.hasAttribute('download')).toBe(true);
});
