import { ATTACHMENT_MAX_BYTES } from '@dispatch-foo/core/browser';
import type { TaskAttachment } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useRef } from 'react';

import { ToastProvider } from '../../shell/Toasts';
import { AttachmentsRow, useAttachmentUpload } from './AttachmentsRow';

const SPEC: TaskAttachment = {
  name: 'spec.png',
  path: '.dispatch/attachments/t-1/spec.png',
  size: 48 * 1024,
  addedAt: '2026-09-20T10:00:00Z',
};

interface Log {
  uploads: { id: string; names: string[] }[];
  removed: { id: string; name: string }[];
}

function clientWith(log: Log): ApiClient {
  return {
    uploadTaskAttachments: (id: string, files: File[]) => {
      log.uploads.push({ id, names: files.map((f) => f.name) });
      return Promise.resolve({} as never);
    },
    removeTaskAttachment: (id: string, name: string) => {
      log.removed.push({ id, name });
      return Promise.resolve({} as never);
    },
    fetchHealth: () => new Promise(() => {}),
  } as unknown as ApiClient;
}

// The row as the page mounts it: the upload hook lives in the parent so a
// paste anywhere on the page shares its `uploading` flag.
function Harness({
  client,
  attachments,
  editable = true,
}: {
  client: ApiClient | null;
  attachments: TaskAttachment[];
  editable?: boolean;
}) {
  const upload = useAttachmentUpload(client, 't-1');
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <AttachmentsRow
      taskId="t-1"
      attachments={attachments}
      client={client}
      port={4100}
      editable={editable}
      upload={upload.upload}
      uploading={upload.uploading}
      inputRef={inputRef}
    />
  );
}

function mount(props: Parameters<typeof Harness>[0]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <Harness {...props} />
      </ToastProvider>
    </QueryClientProvider>
  );
}

// The hidden `<input type="file">` the row mounts for its picker.
function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input mounted');
  return input;
}

describe('AttachmentsRow', () => {
  test('renders a chip per attachment with the name and size', () => {
    mount({
      client: clientWith({ uploads: [], removed: [] }),
      attachments: [SPEC],
    });
    expect(screen.getByText('spec.png · 48 KB')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Remove spec.png' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy();
  });

  test('× removes through the client', async () => {
    const log: Log = { uploads: [], removed: [] };
    mount({ client: clientWith(log), attachments: [SPEC] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove spec.png' }));
      await Promise.resolve();
    });
    expect(log.removed).toEqual([{ id: 't-1', name: 'spec.png' }]);
  });

  test('the Attach button is present with no chips, and absent when not editable', () => {
    mount({
      client: clientWith({ uploads: [], removed: [] }),
      attachments: [],
    });
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="attachment-chip"]')
    ).toHaveLength(0);
  });

  test('an archived task keeps its chips but loses Attach and ×', () => {
    mount({
      client: clientWith({ uploads: [], removed: [] }),
      attachments: [SPEC],
      editable: false,
    });
    expect(screen.getByText('spec.png · 48 KB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Remove spec.png' })
    ).toBeNull();
  });

  test('a file over the cap toasts and never reaches the client', async () => {
    const log: Log = { uploads: [], removed: [] };
    mount({ client: clientWith(log), attachments: [] });
    const input = fileInput();
    const big = new File(
      [new Uint8Array(ATTACHMENT_MAX_BYTES + 1)],
      'huge.bin'
    );
    await act(async () => {
      fireEvent.change(input, { target: { files: [big] } });
      await Promise.resolve();
    });
    expect(log.uploads).toEqual([]);
    expect(await screen.findByText('File too large')).toBeTruthy();
  });

  // One request per file: the daemon's cap is per file, and a failure names
  // the one that did not land while the rest still do.
  test('picked files upload one request each, and a failure names its file', async () => {
    const log: Log = { uploads: [], removed: [] };
    const client = clientWith(log);
    const base = client.uploadTaskAttachments;
    client.uploadTaskAttachments = (id, files) => {
      if (files[0]?.name === 'b.txt')
        return Promise.reject(new Error('disk full'));
      return base(id, files);
    };
    mount({ client, attachments: [] });
    const input = fileInput();
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [
            new File(['x'], 'a.txt'),
            new File(['y'], 'b.txt'),
            new File(['z'], 'c.txt'),
          ],
        },
      });
      await Promise.resolve();
    });
    expect(log.uploads).toEqual([
      { id: 't-1', names: ['a.txt'] },
      { id: 't-1', names: ['c.txt'] },
    ]);
    expect(await screen.findByText('Could not attach b.txt')).toBeTruthy();
    expect(await screen.findByText('disk full')).toBeTruthy();
  });
});
