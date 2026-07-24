/**
 * Design tokens.
 *
 * Calibrated for the actual use context, which is not an office: bright
 * sunlight, gloved hands, and a device held at arm's length inside a
 * switchroom. That drives three departures from a typical mobile palette:
 *
 *  - Text contrast targets WCAG AAA (7:1), not AA. AA is comfortable indoors
 *    and unreadable on a phone at midday.
 *  - The minimum touch target is 48pt, not 44pt, because a gloved finger has a
 *    larger and less precise contact patch.
 *  - Status colours are distinguishable without hue alone — every status also
 *    carries an icon and a label, since roughly 8% of male field staff have
 *    some form of colour vision deficiency and red/green is the worst possible
 *    pairing for pass/fail.
 */

export const palette = {
  // Neutrals. The dark ramp is the primary surface: field work happens at dawn
  // and dusk far more than a 9-to-5 app assumes.
  slate950: '#070A12',
  slate900: '#0B0F1A',
  slate850: '#111726',
  slate800: '#18202F',
  slate700: '#232C3D',
  slate600: '#33405A',
  slate500: '#4A5A78',
  slate400: '#6B7C9B',
  slate300: '#94A3BC',
  slate200: '#C3CDDC',
  slate100: '#E2E8F0',
  slate50: '#F5F8FC',
  white: '#FFFFFF',

  // Brand
  blue600: '#1B5CF0',
  blue500: '#3B7BFF',
  blue400: '#6699FF',
  blue300: '#9BBCFF',
  blue100: '#E4EDFF',

  // Status. Chosen so the pass/fail pair remains distinguishable under
  // deuteranopia — the green leans teal and the red leans orange.
  green600: '#0E8A5F',
  green500: '#13A874',
  green100: '#D8F3E8',
  amber600: '#B26A00',
  amber500: '#E08600',
  amber100: '#FDEED6',
  red600: '#C2371F',
  red500: '#E24A2E',
  red100: '#FCE3DD',
  violet500: '#7C5CFF',
  violet100: '#EAE4FF',
} as const;

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  accent: string;
  accentMuted: string;
  accentText: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  info: string;
  infoMuted: string;
  /** Overlay behind modals and sheets. */
  scrim: string;
}

export const darkColors: ThemeColors = {
  background: palette.slate950,
  surface: palette.slate900,
  surfaceRaised: palette.slate850,
  surfaceSunken: palette.slate950,
  border: palette.slate700,
  borderStrong: palette.slate600,
  textPrimary: palette.slate50,
  textSecondary: palette.slate300,
  textMuted: palette.slate400,
  textInverse: palette.slate950,
  accent: palette.blue500,
  accentMuted: 'rgba(59, 123, 255, 0.16)',
  accentText: palette.white,
  success: palette.green500,
  successMuted: 'rgba(19, 168, 116, 0.16)',
  warning: palette.amber500,
  warningMuted: 'rgba(224, 134, 0, 0.16)',
  danger: palette.red500,
  dangerMuted: 'rgba(226, 74, 46, 0.16)',
  info: palette.violet500,
  infoMuted: 'rgba(124, 92, 255, 0.16)',
  scrim: 'rgba(3, 6, 12, 0.72)',
};

export const lightColors: ThemeColors = {
  background: palette.slate50,
  surface: palette.white,
  surfaceRaised: palette.white,
  surfaceSunken: palette.slate100,
  border: palette.slate200,
  borderStrong: palette.slate300,
  textPrimary: palette.slate950,
  textSecondary: palette.slate600,
  textMuted: palette.slate500,
  textInverse: palette.white,
  accent: palette.blue600,
  accentMuted: palette.blue100,
  accentText: palette.white,
  success: palette.green600,
  successMuted: palette.green100,
  warning: palette.amber600,
  warningMuted: palette.amber100,
  danger: palette.red600,
  dangerMuted: palette.red100,
  info: palette.violet500,
  infoMuted: palette.violet100,
  scrim: 'rgba(11, 15, 26, 0.48)',
};

/** 4pt base scale. */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  displayLarge: { fontSize: 34, lineHeight: 40, fontWeight: '700' as const, letterSpacing: -0.5 },
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, letterSpacing: -0.4 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.2 },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  // 14pt is the floor for anything an inspector must read to make a decision.
  caption: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  captionStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  // Reserved for non-essential metadata only — never for a question or answer.
  micro: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const, letterSpacing: 0.2 },
  mono: { fontSize: 14, lineHeight: 20, fontWeight: '500' as const, fontFamily: 'Menlo' },
} as const;

/**
 * Gloved-hand minimum. Apple says 44pt and Android 48dp; we take the larger and
 * apply it everywhere, because a mistap on a pass/fail control is a data
 * integrity problem, not a usability annoyance.
 */
export const touchTarget = {
  minimum: 48,
  comfortable: 56,
  large: 64,
} as const;

export const elevation = {
  none: { shadowOpacity: 0, elevation: 0 },
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.16,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 6,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.26,
    shadowRadius: 22,
    elevation: 14,
  },
} as const;

export const motion = {
  /** Instant feedback on tap — anything slower feels broken under gloves. */
  instant: 90,
  fast: 160,
  normal: 240,
  slow: 360,
} as const;

/** Breakpoint above which tablet two-pane layouts engage. */
export const breakpoints = {
  tablet: 768,
  wide: 1024,
} as const;
