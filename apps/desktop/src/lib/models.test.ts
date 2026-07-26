import { describe, expect, test } from 'bun:test';

import { modelDisplayName } from './models.ts';

// `modelDisplayName` is the single id->label mapping used across the Sessions analytics views
// (session rows, session detail, per-model spend). It must name every model shape that shows up
// in real ingested logs — current dispatchable models, older generations still present in
// history, the `<synthetic>` sentinel, dated/versioned suffixes — and never throw on an
// unknown or missing id.
describe('modelDisplayName', () => {
  test('maps a current dispatchable model id to its label', () => {
    expect(modelDisplayName('claude-opus-5')).toBe('Opus 5');
    expect(modelDisplayName('claude-fable-5')).toBe('Fable 5');
  });

  test('maps historical (non-dispatchable) model ids seen in ingested sessions', () => {
    expect(modelDisplayName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelDisplayName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  test('names the <synthetic> sentinel rather than showing the raw token', () => {
    expect(modelDisplayName('<synthetic>')).toBe('Synthetic');
  });

  test('resolves a dated/versioned suffix to its family label via longest prefix', () => {
    expect(modelDisplayName('claude-opus-5-20260115')).toBe('Opus 5');
  });

  test('falls back to the raw id for a genuinely unknown model', () => {
    expect(modelDisplayName('some-future-model')).toBe('some-future-model');
  });

  test('returns undefined for a missing id so callers can show "unknown model"', () => {
    expect(modelDisplayName(null)).toBeUndefined();
    expect(modelDisplayName(undefined)).toBeUndefined();
  });
});
