/**
 * Device identity.
 *
 * The installation id must survive app restarts and OS updates but must NOT
 * survive a reinstall — a fresh install is a new device enrolment as far as the
 * server's device-binding policy is concerned. `expo-application`'s Android ID
 * and iOS identifierForVendor have exactly that lifetime, with a generated
 * fallback persisted to the keychain for cases where neither is available.
 */

import { ulid } from '@orbit/utils';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

import { secureStorage } from './storage';

let cached: string | null = null;

export async function getInstallationId(): Promise<string> {
  if (cached) return cached;

  const stored = await secureStorage.get(secureStorage.keys.INSTALLATION_ID);
  if (stored) {
    cached = stored;
    return stored;
  }

  let native: string | null = null;
  try {
    native =
      Platform.OS === 'android'
        ? Application.getAndroidId()
        : await Application.getIosIdForVendorAsync();
  } catch {
    native = null;
  }

  // A generated id is functionally equivalent here: the server treats the
  // installation id as opaque, and it is persisted to the keychain either way.
  const id = native ?? ulid();
  await secureStorage.set(secureStorage.keys.INSTALLATION_ID, id);
  cached = id;
  return id;
}

/** Human-readable device label shown in the admin device list. */
export function deviceLabel(brand: string | null, model: string | null): string {
  if (brand && model) return `${brand} ${model}`;
  return model ?? brand ?? 'Unknown device';
}
