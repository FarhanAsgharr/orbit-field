/**
 * Root layout.
 *
 * Owns three things: the provider stack, the boot sequence, and the redirect
 * between the authenticated and unauthenticated route groups.
 *
 * The splash screen is held until `boot()` resolves so the user never sees a
 * flash of the login screen before a cached session is restored — that flash
 * reads as "I've been signed out", which is alarming when you are standing in a
 * substation with a day's unsynced work on the device.
 */

import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { View } from 'react-native';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { useSession } from '../src/stores/session.store';
import { startNetworkMonitor, stopNetworkMonitor } from '../src/lib/network';
import { AppErrorBoundary } from '../src/components/AppErrorBoundary';

void SplashScreen.preventAutoHideAsync();

/**
 * React Query is used only for server-backed reads that have no local mirror
 * (analytics, admin lists). Inspection data never goes through it — that comes
 * from SQLite, synchronously, so it works offline.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      // The sync engine owns retry policy for anything that matters. Retrying
      // here as well would double up and mask genuine failures.
      retry: 1,
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    },
  },
});

function RouteGuard({ children }: { children: React.ReactNode }): React.ReactElement | null {
  const phase = useSession((s) => s.phase);
  const segments = useSegments();
  const router = useRouter();
  const theme = useTheme();

  useEffect(() => {
    if (phase === 'BOOTING') return;

    const inAuthGroup = segments[0] === '(auth)';
    const signedIn = phase === 'AUTHENTICATED' || phase === 'AUTHENTICATED_UNVERIFIED';

    if (!signedIn && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (signedIn && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [phase, segments, router]);

  useEffect(() => {
    if (phase !== 'BOOTING') {
      void SplashScreen.hideAsync();
    }
  }, [phase]);

  if (phase === 'BOOTING') {
    // Matching the splash background avoids a one-frame colour flash between
    // the native splash and the first React render.
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
  }

  return <>{children}</>;
}

function AppShell(): React.ReactElement {
  const theme = useTheme();
  const boot = useSession((s) => s.boot);

  useEffect(() => {
    const stop = startNetworkMonitor();
    void boot();
    return () => {
      stop();
      stopNetworkMonitor();
    };
  }, [boot]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <RouteGuard>
        <Slot />
      </RouteGuard>
    </View>
  );
}

export default function RootLayout(): React.ReactElement {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <AppErrorBoundary>
              <AppShell />
            </AppErrorBoundary>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
