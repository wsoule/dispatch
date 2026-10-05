// Test vectors from RFC 9421 (HTTP Message Signatures), © IETF Trust, as
// published at https://www.rfc-editor.org/rfc/rfc9421, with the RFC 8792
// line wrapping undone. B.1.3's key; §2.4's and B.2.4's ECDSA examples.

export const TEST_KEY_ECC_P256 = {
  kty: 'EC',
  crv: 'P-256',
  x: 'qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA',
  y: 'Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0',
  d: 'UpuF81l-kOxbjf7T4mNSv0r5tN67Gim7rnf6EFpcYDs',
};

// Appendix B.2: the test-request (with §2.4's Content-Type) and test-response.
export const TEST_REQUEST = {
  method: 'POST',
  targetUri: 'https://example.com/foo?param=Value&Pet=dog',
  headers: new Headers({
    Host: 'example.com',
    Date: 'Tue, 20 Apr 2021 02:07:55 GMT',
    'Content-Type': 'application/json',
    'Content-Digest':
      'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
    'Content-Length': '18',
  }),
};

export const TEST_RESPONSE = {
  status: 200,
  headers: new Headers({
    Date: 'Tue, 20 Apr 2021 02:07:56 GMT',
    'Content-Type': 'application/json',
    'Content-Digest':
      'sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
    'Content-Length': '23',
  }),
};

// B.2.4: a response signed with ecdsa-p256-sha256.
export const B24 = {
  signatureInput:
    'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
  signature:
    'sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:',
  base: [
    '"@status": 200',
    '"content-type": application/json',
    '"content-digest": sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
    '"content-length": 23',
    '"@signature-params": ("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
  ].join('\n'),
};

// §2.4: a 503 response covering request components with the req parameter.
export const REQRES = {
  response: {
    status: 503,
    headers: new Headers({
      Date: 'Tue, 20 Apr 2021 02:07:56 GMT',
      'Content-Type': 'application/json',
      'Content-Length': '62',
      'Content-Digest':
        'sha-512=:0Y6iCBzGg5rZtoXS95Ijz03mslf6KAMCloESHObfwnHJDbkkWWQz6PhhU9kxsTbARtY2PTBOzq24uJFpHsMuAg==:',
    }),
  },
  signatureInput:
    'reqres=("@status" "content-digest" "content-type" "@authority";req "@method";req "@path";req "content-digest";req);created=1618884479;keyid="test-key-ecc-p256"',
  signature:
    'reqres=:dMT/A/76ehrdBTD/2Xx8QuKV6FoyzEP/I9hdzKN8LQJLNgzU4W767HK05rx1i8meNQQgQPgQp8wq2ive3tV5Ag==:',
  base: [
    '"@status": 503',
    '"content-digest": sha-512=:0Y6iCBzGg5rZtoXS95Ijz03mslf6KAMCloESHObfwnHJDbkkWWQz6PhhU9kxsTbARtY2PTBOzq24uJFpHsMuAg==:',
    '"content-type": application/json',
    '"@authority";req: example.com',
    '"@method";req: POST',
    '"@path";req: /foo',
    '"content-digest";req: sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
    '"@signature-params": ("@status" "content-digest" "content-type" "@authority";req "@method";req "@path";req "content-digest";req);created=1618884479;keyid="test-key-ecc-p256"',
  ].join('\n'),
};
