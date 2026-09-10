import { describe, expect, it } from 'bun:test';

import { redactSecretUrls } from '../src/secretUrls.js';

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX';
const DISCORD = 'https://discord.com/api/webhooks/1234567890/abcdefg-hijklmn';

describe('redactSecretUrls', () => {
  it('masks the path of a webhook URL and keeps the host', () => {
    const out = redactSecretUrls({
      notifications: { enabled: true, webhook: SLACK },
    });
    expect(out.notifications.webhook).toBe('https://hooks.slack.com/…');
    expect(out.notifications.enabled).toBe(true);
    expect(JSON.stringify(out)).not.toContain('T000/B000');
  });

  it('masks every URL nested under a webhook-shaped key', () => {
    const out = redactSecretUrls({
      notifications: {
        webhook: { url: DISCORD, events: ['landed'] },
        webhookUrl: SLACK,
      },
    });
    expect(out.notifications.webhook.url).toBe('https://discord.com/…');
    expect(out.notifications.webhook.events).toEqual(['landed']);
    expect(out.notifications.webhookUrl).toBe('https://hooks.slack.com/…');
  });

  it('leaves non-URL values and unrelated URLs alone', () => {
    const input = {
      verify: { url: 'http://localhost:3000/deep/path' },
      notifications: { webhook: 'not a url' },
      statuses: ['draft', 'ready'],
      autoCommit: false,
      queue: null,
    };
    expect(redactSecretUrls(input)).toEqual(input);
  });

  it('does not mutate its input', () => {
    const input = { notifications: { webhook: SLACK } };
    redactSecretUrls(input);
    expect(input.notifications.webhook).toBe(SLACK);
  });
});
