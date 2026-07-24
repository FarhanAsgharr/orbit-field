/**
 * Expo app configuration.
 *
 * This was a static app.json until the API URL had to vary per build. An APK is
 * a frozen artefact: whatever URL is baked in here is the only server that
 * installation will ever talk to, so it has to come from the environment at
 * build time rather than a literal.
 *
 * The build fails loudly rather than silently shipping a localhost URL, because
 * an APK pointing at localhost installs fine, opens fine, and then fails every
 * sign-in with a network error that looks like a backend outage.
 */

import type { ExpoConfig } from 'expo/config';

/**
 * `EXPO_PUBLIC_API_URL` is the origin of the backend, including the version
 * prefix — e.g. https://orbit-field-api.up.railway.app/api/v1
 */
function resolveApiUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();

  if (configured) {
    if (!/^https?:\/\//.test(configured)) {
      throw new Error(
        `EXPO_PUBLIC_API_URL must include the scheme, got "${configured}".`,
      );
    }
    // A device on a mobile network cannot reach a private address, and the
    // resulting failure looks identical to the server being down.
    if (process.env.EAS_BUILD === 'true' && /localhost|127\.0\.0\.1/.test(configured)) {
      throw new Error(
        `EXPO_PUBLIC_API_URL is "${configured}". A packaged build cannot reach ` +
          'localhost — set it to the public URL of your deployed backend.',
      );
    }
    return configured.replace(/\/+$/, '');
  }

  // Local development only. `expo start` on a simulator can reach the host
  // machine; a physical device on the same LAN needs the host's IP instead.
  if (process.env.EAS_BUILD === 'true') {
    throw new Error(
      'EXPO_PUBLIC_API_URL is not set. A packaged build has no default server ' +
        'to fall back to — set it in eas.json or the EAS project environment.',
    );
  }
  return 'http://localhost:4000/api/v1';
}

const config: ExpoConfig = {
  name: 'Orbit Field',
  slug: 'orbit-field',
  version: '1.0.0',
  orientation: 'default',
  scheme: 'orbit',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0B0F1A',
  },
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'app.orbitfield.field',
    requireFullScreen: false,
    infoPlist: {
      NSCameraUsageDescription:
        'Orbit Field uses the camera to capture inspection evidence photographs and to scan asset barcodes.',
      NSPhotoLibraryUsageDescription:
        'Orbit Field attaches existing photographs to inspections when your organisation permits it.',
      NSMicrophoneUsageDescription: 'Orbit Field records voice notes against inspection findings.',
      NSLocationWhenInUseUsageDescription:
        'Orbit Field stamps inspections and photographs with your location to prove they were carried out on site.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Orbit Field records your location while an inspection is in progress to verify site attendance.',
      NSFaceIDUsageDescription:
        'Orbit Field uses Face ID to unlock the app without re-entering your password in the field.',
      UIBackgroundModes: ['fetch', 'processing'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'app.orbitfield.field',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0B0F1A',
    },
    permissions: [
      'CAMERA',
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'RECORD_AUDIO',
      'READ_EXTERNAL_STORAGE',
      'WRITE_EXTERNAL_STORAGE',
      'USE_BIOMETRIC',
      'USE_FINGERPRINT',
      'VIBRATE',
      'RECEIVE_BOOT_COMPLETED',
      'WAKE_LOCK',
      'FOREGROUND_SERVICE',
    ],
    blockedPermissions: ['com.google.android.gms.permission.AD_ID'],
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    [
      'expo-camera',
      {
        cameraPermission: 'Orbit Field uses the camera to capture inspection evidence.',
        recordAudioAndroid: true,
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Orbit Field records your location to prove inspections were carried out on site.',
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
    [
      'expo-local-authentication',
      {
        faceIDPermission: 'Orbit Field uses Face ID to unlock the app in the field.',
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#3B7BFF',
      },
    ],
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '15.1' },
        android: { minSdkVersion: 24, compileSdkVersion: 35, targetSdkVersion: 35 },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    apiUrl: resolveApiUrl(),
    eas: {
      // Filled in by `eas init`. Left null so a missing project id fails at
      // build time with EAS's own message rather than being mistaken for a
      // configuration error in this file.
      projectId: process.env.EAS_PROJECT_ID ?? null,
    },
  },
};

export default config;
