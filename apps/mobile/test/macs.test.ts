import { describe, expect, test } from 'bun:test';

import {
  activeMac,
  addMac,
  EMPTY,
  offerKind,
  type Paired,
  parseMacList,
  removeMac,
  selectMac,
} from '../src/macs';

const mac = (id: string, name = `${id}'s Mac`): Paired => ({
  relay: 'wss://remote.dispatch.foo',
  daemonId: id,
  daemonKey: `key-${id}`,
  daemonName: name,
  phoneSecret: `secret-${id}`,
});

describe('the Macs a phone is paired with', () => {
  test('reads the one-Mac shape earlier builds stored', () => {
    const list = parseMacList(JSON.stringify(mac('work')));
    expect(list.active).toBe('work');
    expect(list.macs).toHaveLength(1);
  });

  test('reads its own shape back, and nothing from junk', () => {
    const list = addMac(addMac(EMPTY, mac('work')), mac('home'));
    expect(parseMacList(JSON.stringify(list))).toEqual(list);
    expect(parseMacList('not json')).toEqual(EMPTY);
    expect(parseMacList(null)).toEqual(EMPTY);
    expect(
      parseMacList(JSON.stringify({ active: 'x', macs: [{ relay: 1 }] }))
    ).toEqual(EMPTY);
  });

  test('a stored active Mac that is gone falls back to the first', () => {
    const text = JSON.stringify({ active: 'gone', macs: [mac('work')] });
    expect(parseMacList(text).active).toBe('work');
  });

  test('pairing adds a Mac and uses it; pairing it again replaces its keys', () => {
    let list = addMac(EMPTY, mac('work'));
    list = addMac(list, mac('home'));
    expect(activeMac(list)?.daemonId).toBe('home');
    list = addMac(list, { ...mac('work'), phoneSecret: 'new' });
    expect(list.macs.map((m) => m.daemonId)).toEqual(['home', 'work']);
    expect(activeMac(list)?.phoneSecret).toBe('new');
  });

  test('switches only to a Mac it knows', () => {
    const list = addMac(addMac(EMPTY, mac('work')), mac('home'));
    expect(selectMac(list, 'work').active).toBe('work');
    expect(selectMac(list, 'nope')).toBe(list);
  });

  test('forgetting the Mac in use moves to the next, and the last leaves none', () => {
    let list = addMac(addMac(EMPTY, mac('work')), mac('home'));
    list = removeMac(list, 'home');
    expect(list.active).toBe('work');
    list = removeMac(list, 'work');
    expect(list).toEqual({ active: null, macs: [] });
    expect(activeMac(list)).toBeNull();
  });

  test('tells a known Mac from one whose keys changed', () => {
    const list = addMac(EMPTY, mac('work'));
    const offer = {
      daemonId: 'work',
      daemonKey: 'key-work',
      relay: mac('work').relay,
    };
    expect(offerKind(list, offer)).toBe('same');
    expect(offerKind(list, { ...offer, daemonKey: 'other' })).toBe(
      'key-changed'
    );
    expect(offerKind(list, { ...offer, relay: 'wss://evil.example' })).toBe(
      'key-changed'
    );
    expect(offerKind(list, { ...offer, daemonId: 'home' })).toBe('new');
  });
});
