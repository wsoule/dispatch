import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import {
  accessFor,
  ATTACHED_READ_ONLY,
  NEEDS_DECIDE,
  OPERATOR_ONLY,
  SettingsAccessProvider,
  useSettingsAccess,
} from './access';

describe('accessFor', () => {
  test('no connection grants nothing', () => {
    expect(accessFor(null, false)).toEqual({
      canDecide: false,
      canOperate: false,
      decideReason: NEEDS_DECIDE,
      operateReason: OPERATOR_ONLY,
    });
  });

  test('request tier can read settings but change none', () => {
    expect(accessFor('request', false)).toEqual({
      canDecide: false,
      canOperate: false,
      decideReason: NEEDS_DECIDE,
      operateReason: OPERATOR_ONLY,
    });
  });

  test('decide tier saves config but not the operator-only keys', () => {
    expect(accessFor('decide', false)).toEqual({
      canDecide: true,
      canOperate: false,
      decideReason: NEEDS_DECIDE,
      operateReason: OPERATOR_ONLY,
    });
  });

  test('operator tier changes everything', () => {
    expect(accessFor('operator', false)).toEqual({
      canDecide: true,
      canOperate: true,
      decideReason: NEEDS_DECIDE,
      operateReason: OPERATOR_ONLY,
    });
  });

  // A teammate is told to ask the owner; the owner's own attached window is
  // told to restart Dispatch from the app instead.
  test('the reason names who can fix it', () => {
    expect(accessFor('request', false).decideReason).toBe(NEEDS_DECIDE);
    expect(accessFor('request', true).decideReason).toBe(ATTACHED_READ_ONLY);
    expect(accessFor(null, true).decideReason).toBe(ATTACHED_READ_ONLY);
    // Restarting from the app also unlocks the owner-only settings.
    expect(accessFor('request', false).operateReason).toBe(OPERATOR_ONLY);
    expect(accessFor('request', true).operateReason).toBe(ATTACHED_READ_ONLY);
    // Being attached never changes what the tier itself allows.
    expect(accessFor('request', true).canDecide).toBe(false);
    expect(accessFor('operator', true).canOperate).toBe(true);
  });
});

function AccessProbe() {
  const access = useSettingsAccess();
  return (
    <p>
      {`decide=${String(access.canDecide)} operate=${String(access.canOperate)}`}
    </p>
  );
}

describe('SettingsAccessProvider', () => {
  // Sections rendered on their own, as their tests do, keep every control live.
  test('outside a provider nothing is locked', () => {
    render(<AccessProbe />);
    expect(screen.getByText('decide=true operate=true')).toBeDefined();
  });

  test('a provider hands its access down', () => {
    render(
      <SettingsAccessProvider access={accessFor('request', false)}>
        <AccessProbe />
      </SettingsAccessProvider>
    );
    expect(screen.getByText('decide=false operate=false')).toBeDefined();
  });
});
