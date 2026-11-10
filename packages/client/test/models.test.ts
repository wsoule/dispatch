import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelDisplayName,
  readDefaultModel,
  readRoleModelOverride,
  resolveExecuteModel,
  resolveRoleModel,
  storeRoleModelOverride,
} from '../src/models';
import { memoryStorage } from '../src/storage';

// `modelDisplayName` is the single id->label mapping used across the Sessions analytics views
// (session rows, session detail, per-model spend). It must name every model shape that shows up
// in real ingested logs — current dispatchable models, older generations still present in
// history, the `<synthetic>` sentinel, dated/versioned suffixes — and never throw on an
// unknown or missing id.
describe('modelDisplayName', () => {
  test('maps a current dispatchable model id to its label', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
  });

  test('maps historical (non-dispatchable) model ids seen in ingested sessions', () => {
    // Opus 5, Fable 5 and Opus 4.8 left the picker but still appear in past
    // sessions; the exact historical entry wins over the prefix its successor shares.
    expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
    expect(modelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(modelDisplayName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelDisplayName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  test('names the <synthetic> sentinel rather than showing the raw token', () => {
    expect(modelDisplayName('<synthetic>')).toBe('Synthetic');
  });

  test('resolves a dated/versioned suffix to its family label via longest prefix', () => {
    expect(modelDisplayName('claude-opus-5-20260115')).toBe('Opus 5');
    expect(modelDisplayName('claude-opus-5-5-20260915')).toBe('Opus 5.5');
  });

  test('falls back to the raw id for a genuinely unknown model', () => {
    expect(modelDisplayName('some-future-model')).toBe('some-future-model');
  });

  test('returns undefined for a missing id so callers can show "unknown model"', () => {
    expect(modelDisplayName(null)).toBeUndefined();
    expect(modelDisplayName(undefined)).toBeUndefined();
  });
});

describe('effort picker', () => {
  test('offers Default first, naming the configured level when there is one', () => {
    expect(effortOptions(undefined)[0]).toEqual({
      id: DEFAULT_EFFORT_ID,
      label: 'Default',
    });
    expect(effortOptions('xhigh')[0]?.label).toBe('Default (Extra high)');
    expect(effortOptions(undefined)[5]?.label).toBe('Max');
    expect(effortOptions(undefined).map((o) => o.id)).toEqual([
      DEFAULT_EFFORT_ID,
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  test('maps the Default sentinel to no effort and a level to itself', () => {
    expect(effortFromId(DEFAULT_EFFORT_ID)).toBeUndefined();
    expect(effortFromId('max')).toBe('max');
  });
});

describe('device model picks', () => {
  test('a role pick round-trips under the key desktop has always used', () => {
    const store = memoryStorage();
    storeRoleModelOverride('overseer', 'claude-fable-5-1', store);
    expect(store.get('dispatch:model:overseer')).toBe('claude-fable-5-1');
    expect(readRoleModelOverride('overseer', store)).toBe('claude-fable-5-1');
    expect(resolveRoleModel('overseer', null, store)).toBe('claude-fable-5-1');
  });

  test('a stored id no longer offered falls back to config, then the default', () => {
    const store = memoryStorage({
      'dispatch:model:plan': 'claude-retired-1',
      'dispatch:default-model': 'claude-retired-1',
    });
    expect(readRoleModelOverride('plan', store)).toBeUndefined();
    expect(
      resolveRoleModel('plan', { models: { plan: 'claude-sonnet-5-5' } }, store)
    ).toBe('claude-sonnet-5-5');
    expect(readDefaultModel(store)).toBe('claude-opus-5-5');
    expect(
      resolveExecuteModel({ models: { execute: 'claude-haiku-5-5' } }, store)
    ).toBe('claude-haiku-5-5');
  });

  test('a Settings change outranks a pick made before it', () => {
    const store = memoryStorage();
    const opus = { models: { overseer: 'claude-opus-5-5' } };
    storeRoleModelOverride(
      'overseer',
      'claude-haiku-5-5',
      store,
      'claude-sonnet-5-5'
    );
    expect(resolveRoleModel('overseer', opus, store)).toBe('claude-opus-5-5');
    storeRoleModelOverride(
      'overseer',
      'claude-haiku-5-5',
      store,
      'claude-opus-5-5'
    );
    expect(resolveRoleModel('overseer', opus, store)).toBe('claude-haiku-5-5');
  });

  test('a pick saved before picks recorded their base yields to config', () => {
    const store = memoryStorage({
      'dispatch:model:overseer': 'claude-haiku-5-5',
    });
    expect(
      resolveRoleModel(
        'overseer',
        { models: { overseer: 'claude-opus-5-5' } },
        store
      )
    ).toBe('claude-opus-5-5');
  });

  test('a stored id the picker replaced resolves to its successor', () => {
    const store = memoryStorage({
      'dispatch:model:plan': 'claude-haiku-4-5-20251001',
      'dispatch:default-model': 'claude-haiku-4-5-20251001',
    });
    expect(readRoleModelOverride('plan', store)).toBe('claude-haiku-5-5');
    expect(readDefaultModel(store)).toBe('claude-haiku-5-5');
    expect(resolveExecuteModel(null, store)).toBe('claude-haiku-5-5');
  });
});
