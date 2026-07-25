/**
 * Tab navigation.
 *
 * Four destinations, deliberately. Field apps accumulate tabs until the bar is
 * unusable with a gloved thumb; anything beyond four belongs behind the "More"
 * screen. The sync indicator lives in the header rather than as a fifth tab,
 * because it is status, not a destination.
 */

import React from 'react';
import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useSession } from '../../src/stores/session.store';

/**
 * Glyph-based icons.
 *
 * Text glyphs rather than an icon font: they render identically on both
 * platforms, add no asset weight, and scale with the user's font-size setting,
 * which an icon font does not.
 */
function TabIcon({
  glyph,
  color,
  badge,
}: {
  glyph: string;
  color: string;
  badge?: number;
}): React.ReactElement {
  return (
    <View style={{ width: 32, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 22, color, lineHeight: 26 }}>{glyph}</Text>
      {badge !== undefined && badge > 0 ? (
        <View
          style={{
            position: 'absolute',
            top: -4,
            right: -2,
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: '#E24A2E',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 4,
          }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default function TabsLayout(): React.ReactElement | null {
  const theme = useTheme();
  const syncStatus = useSession((s) => s.syncStatus);
  const runtime = useSession((s) => s.runtime);

  /**
   * The boundary of the authenticated area.
   *
   * `(tabs)` is the router's initial route, so for a signed-out user it mounts
   * before the root guard's redirect — which runs in an effect, i.e. after the
   * render — has had a chance to move anyone. Every screen below here calls
   * `useRuntime()`, which throws without a session, so the app opened straight
   * into the error boundary instead of the login screen.
   *
   * Guarding here rather than in the root layout is deliberate: the root must
   * keep `<Slot />` mounted unconditionally or Expo Router refuses to navigate
   * at all ("Attempted to navigate before mounting the Root Layout component"),
   * which trades the crash for a hang. Holding a blank screen for the single
   * frame before the redirect lands costs nothing and is invisible.
   */
  if (!runtime) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
  }

  // Anything the user must act on: failed operations and unresolved conflicts.
  // Merely pending work is not badged — that is normal and constant offline,
  // and badging it would train people to ignore the badge.
  const actionable =
    (syncStatus?.failedOperations ?? 0) + (syncStatus?.conflictedOperations ?? 0);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          // Taller than the platform default so the target clears 48pt with
          // the label included.
          height: 64,
          paddingTop: 6,
          paddingBottom: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => <TabIcon glyph="◈" color={color} />,
        }}
      />
      <Tabs.Screen
        name="inspections"
        options={{
          title: 'Inspections',
          tabBarIcon: ({ color }) => <TabIcon glyph="☰" color={color} />,
        }}
      />
      <Tabs.Screen
        name="sync"
        options={{
          title: 'Sync',
          tabBarIcon: ({ color }) => <TabIcon glyph="⇅" color={color} badge={actionable} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color }) => <TabIcon glyph="⋯" color={color} />,
        }}
      />
    </Tabs>
  );
}
