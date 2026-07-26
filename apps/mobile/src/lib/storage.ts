/**
 * Key-value storage.
 *
 * MMKV for ordinary preferences (synchronous, so the theme does not flash on
 * cold start), and the OS keychain/keystore for anything an attacker with the
 * device would want. Tokens never touch MMKV — MMKV is a file, and a file on a
 * rooted device is readable.
 */

import * as SecureStore from 'expo-secure-store';
import { MMKV } from 'react-native-mmkv';

export const storage = new MMKV({ id: 'orbit-field' });

/**
 * A second, separately-encrypted store for anything derived from user data.
 * Kept apart so a "clear cache" action can wipe it without touching settings.
 */
export const cacheStorage = new MMKV({ id: 'orbit-field-cache' });

const SECURE_KEYS = {
  ACCESS_TOKEN: 'orbit.accessToken',
  REFRESH_TOKEN: 'orbit.refreshToken',
  DEVICE_ID: 'orbit.deviceId',
  INSTALLATION_ID: 'orbit.installationId',
  BIOMETRIC_ENABLED: 'orbit.biometricEnabled',
  LAST_EMAIL: 'orbit.lastEmail',
} as const;

/**
 * Secure storage wrapper.
 *
 * expo-secure-store is async and can fail — a device with no passcode set has
 * no keychain protection class available. Failures are surfaced rather than
 * swallowed, because silently falling back to plaintext would be worse than an
 * error the user can act on.
 */
export const secureStorage = {
  async get(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      // A read failure means the item is unreadable (corrupt keychain entry,
      // changed passcode). Treating it as absent forces a clean re-login,
      // which is the only safe recovery.
      return null;
    }
  },

  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, {
      // Tokens must survive a reboot so an inspector who restarts their phone
      // in the field is not locked out, but must not sync to a new device.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  },

  async remove(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Already gone is the desired end state.
    }
  },

  keys: SECURE_KEYS,
};

/** Typed JSON helpers over MMKV. */
export const kv = {
  getJson<T>(key: string, fallback: T): T {
    const raw = storage.getString(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },

  setJson(key: string, value: unknown): void {
    storage.set(key, JSON.stringify(value));
  },

  remove(key: string): void {
    storage.delete(key);
  },
};

export const STORAGE_KEYS = {
  THEME_PREFERENCE: 'theme.preference',
  LAST_SYNC_AT: 'sync.lastAt',
  SYNC_WIFI_ONLY: 'sync.wifiOnlyMedia',
  SYNC_AUTO: 'sync.auto',
  ONBOARDED: 'app.onboarded',
  LIST_FILTERS: 'inspections.filters',
  DASHBOARD_LAYOUT: 'dashboard.layout',
} as const;
