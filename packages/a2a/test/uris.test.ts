import { A2A_VERSION_HEADER, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';

import {
  ENVELOPE_URI,
  EXTENSION_URIS,
  GATE_URI,
  WORK_URI,
} from '../src/index.js';

describe('extension URIs', () => {
  it('follow https://dispatch.foo/a2a/ext/<name>/v1', () => {
    expect(EXTENSION_URIS).toEqual([ENVELOPE_URI, GATE_URI, WORK_URI]);
    for (const uri of EXTENSION_URIS) {
      expect(uri).toMatch(/^https:\/\/dispatch\.foo\/a2a\/ext\/[a-z]+\/v1$/);
    }
  });

  it('uses the SDK header names', () => {
    expect(A2A_VERSION_HEADER).toBe('A2A-Version');
    expect(HTTP_EXTENSION_HEADER).toBe('A2A-Extensions');
  });
});
