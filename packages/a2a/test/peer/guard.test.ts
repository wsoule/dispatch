import { describe, expect, it } from 'bun:test';

import {
  blockedAddressReason,
  guardPublicUrl,
  pinPublicUrl,
} from '../../src/peer/guard.js';

const resolvesTo =
  (...addresses: string[]) =>
  () =>
    Promise.resolve(addresses);

describe('blockedAddressReason', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.100.100.200', 'cgnat'],
    ['192.0.0.192', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['198.51.100.7', 'reserved'],
    ['203.0.113.9', 'reserved'],
    ['224.0.0.1', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'private'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:0:a9fe:a9fe', 'link-local'],
    ['::127.0.0.1', 'loopback'],
    ['::8.8.8.8', 'reserved'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['64:ff9b:1::1', 'private'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:c0a8:101::1', 'private'],
    ['2001::1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['100::1', 'reserved'],
    ['4000::1', 'reserved'],
    ['not an ip', 'unspecified'],
  ])('%s is %s', (ip, reason) => {
    expect(blockedAddressReason(ip)).toBe(reason);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is public', (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });
});

describe('guardPublicUrl', () => {
  it('accepts an https name, any port, that resolves only to public addresses', async () => {
    const url = await guardPublicUrl(
      'https://agent.example.com:8443/.well-known/agent-card.json',
      { lookup: resolvesTo('93.184.216.34', '2606:2800:220:1::1') }
    );
    expect(url.host).toBe('agent.example.com:8443');
  });

  it.each([
    ['http://agent.example.com/card', 'must be https'],
    ['file:///etc/passwd', 'must be https'],
    ['https://user:pw@agent.example.com/card', 'user or password'],
    ['https://10.0.0.5/card', 'not an IP address'],
    ['https://2130706433/card', 'not an IP address'],
    ['https://0x7f.1/card', 'not an IP address'],
    ['https://[::1]/card', 'not an IP address'],
    ['https://[::ffff:169.254.169.254]/card', 'not an IP address'],
    ['not a url', 'not a URL'],
  ])('refuses %s', async (raw, why) => {
    await expect(
      guardPublicUrl(raw, { lookup: resolvesTo('93.184.216.34') })
    ).rejects.toThrow(why);
  });

  it('refuses a name with one public and one private address', async () => {
    await expect(
      guardPublicUrl('https://split.example.com/', {
        lookup: resolvesTo('93.184.216.34', '10.0.0.7'),
      })
    ).rejects.toMatchObject({
      code: 'invalid',
      field: 'cardUrl',
      message: expect.stringContaining('private'),
    });
  });

  it('refuses a name that resolves to the cloud metadata address', async () => {
    await expect(
      guardPublicUrl('https://metadata.example.com/', {
        lookup: resolvesTo('169.254.169.254'),
      })
    ).rejects.toThrow('link-local');
  });

  it('refuses a name that resolves to nothing, naming the field it was given', async () => {
    await expect(
      guardPublicUrl('https://nowhere.example.com/', {
        lookup: resolvesTo(),
        field: 'url',
      })
    ).rejects.toMatchObject({ field: 'url' });
  });

  it('refuses a name whose lookup fails', async () => {
    await expect(
      guardPublicUrl('https://broken.example.com/', {
        lookup: () => Promise.reject(new Error('ENOTFOUND')),
      })
    ).rejects.toThrow('does not resolve');
  });
});

describe('pinPublicUrl', () => {
  it('returns the checked address to connect to', async () => {
    const pinned = await pinPublicUrl('https://agent.example.com/x', {
      lookup: resolvesTo('2606:2800:220:1::1', '93.184.216.34'),
    });
    expect(pinned.url.hostname).toBe('agent.example.com');
    expect(pinned.address).toBe('2606:2800:220:1::1');
  });
});
