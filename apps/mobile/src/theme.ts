import { useColorScheme } from 'react-native';

import { type Colours, dark, light, radius } from './theme.gen';

// The phone's design system: the desktop's colours (generated into
// theme.gen.ts), Geist at a phone-sized scale, and the status tones of
// docs/architecture.md §8.2. Screens read colours through useColours() and
// never write a hex of their own.

export { radius };
export type { Colours };

export function useColours(): Colours {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Font families, one per weight (see src/fonts.ts). */
export const font = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
} as const;

/** Type sizes. The desktop's 13.5px body is too small to read at arm's
 * length, so the phone runs a step or two larger on the same ratios. */
export const size = {
  caption: 12,
  small: 13,
  body: 15,
  heading: 17,
  title: 22,
  large: 28,
  mono: 12.5,
} as const;

/**
 * What a colour means, as on desktop: amber is waiting on you, blue is live,
 * green is review or succeeded, red is failed, gray is done or inactive. The
 * accent is for actions and selection, and never a status.
 */
export type Tone = 'accent' | 'amber' | 'blue' | 'green' | 'red' | 'gray';

export interface ToneColours {
  /** Text, icons and dots in the tone. */
  ink: string;
  /** The tint a chip or a card fills with. */
  soft: string;
  /** A tinted border. */
  line: string;
}

export function toneColours(c: Colours, tone: Tone): ToneColours {
  switch (tone) {
    case 'accent':
      return { ink: c.accentInk, soft: c.accentSoft, line: c.accentLine };
    case 'amber':
      return { ink: c.amber, soft: c.amberSoft, line: c.amberLine };
    case 'blue':
      return { ink: c.blue, soft: c.blueSoft, line: c.blueLine };
    case 'green':
      return { ink: c.green, soft: c.greenSoft, line: c.greenLine };
    case 'red':
      return { ink: c.red, soft: c.redSoft, line: c.redLine };
    case 'gray':
      return { ink: c.text3, soft: c.surface3, line: c.borderStrong };
  }
}
