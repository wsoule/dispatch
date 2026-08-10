import { describe, expect, test } from 'bun:test';

import { injectDemoHtml, type InjectOptions } from '../src/inject.js';

const HTML =
  '<!doctype html><html><head><title>x</title></head><body></body></html>';
const OPTS: InjectOptions = {
  baseUrl: 'https://demo.x/s/ab12',
  root: '/tmp/s/storefront',
  agentToken: 'a'.repeat(64),
  appToken: 'b'.repeat(64),
  embed: false,
};

describe('injectDemoHtml', () => {
  test('injects the demo config before any script runs', () => {
    const out = injectDemoHtml(HTML, OPTS);
    expect(out).toContain('window.__DISPATCH_DEMO__');
    expect(out).toContain('"baseUrl":"https://demo.x/s/ab12"');
    expect(out.indexOf('__DISPATCH_DEMO__')).toBeLessThan(
      out.indexOf('</head>')
    );
  });

  test('embed hides the banner', () => {
    expect(injectDemoHtml(HTML, OPTS)).toContain('demo-banner');
    expect(injectDemoHtml(HTML, { ...OPTS, embed: true })).not.toContain(
      'demo-banner'
    );
  });

  test('falls back to injecting before the first script when there is no </head>', () => {
    const noHead =
      '<!doctype html><html><body><script src="/x.js"></script></body></html>';
    const out = injectDemoHtml(noHead, OPTS);
    expect(out.indexOf('__DISPATCH_DEMO__')).toBeLessThan(
      out.indexOf('<script src="/x.js">')
    );
  });

  test('escapes </script> in config values so an app token cannot break out', () => {
    const evil: InjectOptions = {
      ...OPTS,
      root: '</script><script>alert(1)</script>',
    };
    const out = injectDemoHtml(HTML, evil);
    // The raw payload must never appear verbatim inside the injected
    // <script> block — that would let it close the tag early.
    expect(out).not.toContain('</script><script>alert(1)</script>');
    // Every "<" from the config value is escaped to \u003c so no literal
    // "<" character reaches the parser inside the script body.
    expect(out).toContain('\\u003c/script>\\u003cscript>alert(1)');
  });
});
