import type { ApiClient, WorkspaceFile } from '@dispatch/client';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { FilePreview } from './FilePreview';

afterEach(cleanup);

const client = {
  workspaceFileUrl: (path: string) => `http://127.0.0.1:4100/raw/${path}`,
} as unknown as ApiClient;

test('a markdown file a run wrote never auto-loads its images, even loopback ones', () => {
  const file = {
    path: 'NOTES.md',
    kind: 'text',
    text: '# Notes\n![probe](http://127.0.0.1:4100/api/secret.png)\n',
  } as unknown as WorkspaceFile;
  const { container } = render(
    <FilePreview client={client} file={file} runId={null} />
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('[image: probe]');
});
