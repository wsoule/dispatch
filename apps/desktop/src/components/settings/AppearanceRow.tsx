import type { ThemeChoice } from '@dispatch/ui';

import { setThemeChoice, useThemeChoice } from '../../hooks/useThemeChoice';
import { ModeSetting } from './fields';
import { SettingsGroup } from './SettingsGroup';

const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Settings → General → Appearance: System, Light or Dark for this browser.
 *  It shows what html[data-theme] shows, so it stays in step with the
 *  sidebar's toggle and other windows, and saves through setThemeChoice. The
 *  group needs no tier (`requires="none"`): the theme is a preference in this
 *  origin's localStorage (each daemon port its own in a browser, one for the
 *  Tauri app), not project config, so a teammate who may not change config
 *  can still pick it. */
export function AppearanceRow() {
  const theme = useThemeChoice();
  return (
    <SettingsGroup
      title="Appearance"
      hint="Saved in this browser only. Nothing here changes the project."
      requires="none"
      keywords="theme dark light mode system colour color appearance"
    >
      <ModeSetting<ThemeChoice>
        id="settings-theme"
        title="Theme"
        subtitle="System follows your computer’s light or dark setting."
        value={theme}
        choices={THEME_CHOICES}
        onSave={setThemeChoice}
      />
    </SettingsGroup>
  );
}
