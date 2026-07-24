/**
 * Theme context.
 *
 * Follows the OS by default but allows an explicit override, because inspectors
 * frequently want to force dark on a night shift regardless of system schedule.
 * The choice is persisted so it survives a cold start in the field.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import {
  breakpoints,
  darkColors,
  elevation,
  lightColors,
  motion,
  radius,
  spacing,
  touchTarget,
  typography,
  type ThemeColors,
} from './tokens';
import { storage } from '../lib/storage';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Theme {
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  touchTarget: typeof touchTarget;
  elevation: typeof elevation;
  motion: typeof motion;
  isDark: boolean;
  /** True on tablets and large foldables — enables the two-pane layout. */
  isTablet: boolean;
  isWide: boolean;
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const PREFERENCE_KEY = 'theme.preference';

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const systemScheme = useColorScheme();
  const { width } = useWindowDimensions();

  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const stored = storage.getString(PREFERENCE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });

  useEffect(() => {
    storage.set(PREFERENCE_KEY, preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
  }, []);

  const theme = useMemo<Theme>(() => {
    const isDark = preference === 'system' ? systemScheme === 'dark' : preference === 'dark';
    return {
      colors: isDark ? darkColors : lightColors,
      spacing,
      radius,
      typography,
      touchTarget,
      elevation,
      motion,
      isDark,
      isTablet: width >= breakpoints.tablet,
      isWide: width >= breakpoints.wide,
    };
  }, [preference, systemScheme, width]);

  const value = useMemo(
    () => ({ theme, preference, setPreference }),
    [theme, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a ThemeProvider');
  return ctx.theme;
}

export function useThemePreference(): { preference: ThemePreference; setPreference: (p: ThemePreference) => void } {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemePreference must be used inside a ThemeProvider');
  return { preference: ctx.preference, setPreference: ctx.setPreference };
}
