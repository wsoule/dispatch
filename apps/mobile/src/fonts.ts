import {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
} from '@expo-google-fonts/geist';
import {
  GeistMono_400Regular,
  GeistMono_500Medium,
} from '@expo-google-fonts/geist-mono';
import { useFonts } from 'expo-font';

// The desktop's typefaces, Geist and Geist Mono, bundled with the app. iOS
// picks a custom font by family name, not by fontWeight, so each weight the
// app uses is its own family; src/theme.ts names them.
const FONTS = {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  GeistMono_400Regular,
  GeistMono_500Medium,
};

/** True once the fonts are ready, or once loading them failed (the app then
 * falls back to the system font rather than never starting). */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(FONTS);
  return loaded || error !== null;
}
