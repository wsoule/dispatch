import { ATTACHMENT_MAX_BYTES } from '@dispatch-foo/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  absoluteAttachmentPath,
  attachmentLabel,
  filesFromDataTransfer,
  splitOversized,
} from './attachments';

function transferWith(files: File[], viaItems: boolean): DataTransfer {
  const items = viaItems
    ? files.map((file) => ({ kind: 'file', getAsFile: () => file }))
    : [{ kind: 'string', getAsFile: () => null }];
  return { items, files: viaItems ? [] : files } as unknown as DataTransfer;
}

describe('filesFromDataTransfer', () => {
  test('reads a paste through its items', () => {
    const png = new File(['x'], 'spec.png');
    expect(filesFromDataTransfer(transferWith([png], true))).toEqual([png]);
  });

  test('reads a drop through its files list', () => {
    const png = new File(['x'], 'spec.png');
    expect(filesFromDataTransfer(transferWith([png], false))).toEqual([png]);
  });

  test('is empty for a text paste and a null transfer', () => {
    expect(filesFromDataTransfer(transferWith([], false))).toEqual([]);
    expect(filesFromDataTransfer(null)).toEqual([]);
  });
});

describe('splitOversized', () => {
  test('separates files over the daemon cap', () => {
    const small = new File(['x'], 'small.txt');
    const big = new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], 'big.bin');
    expect(splitOversized([small, big])).toEqual({
      accepted: [small],
      rejected: [big],
    });
  });
});

describe('attachmentLabel', () => {
  test('joins the name and a readable size', () => {
    expect(
      attachmentLabel({
        name: 'spec.png',
        path: '.dispatch/attachments/t-1/spec.png',
        size: 48 * 1024,
        addedAt: '2026-09-20T10:00:00Z',
      })
    ).toBe('spec.png · 48 KB');
  });
});

describe('absoluteAttachmentPath', () => {
  test('joins the daemon root and the relative path once', () => {
    const attachment = {
      name: 'spec.png',
      path: '.dispatch/attachments/t-1/spec.png',
      size: 1,
      addedAt: '',
    };
    expect(absoluteAttachmentPath('/repo', attachment)).toBe(
      '/repo/.dispatch/attachments/t-1/spec.png'
    );
    expect(absoluteAttachmentPath('/repo/', attachment)).toBe(
      '/repo/.dispatch/attachments/t-1/spec.png'
    );
  });
});
