/**
 * Location capture.
 *
 * GPS in the field is not the clean signal a demo suggests. Readings arrive with
 * wildly varying accuracy, the first fix after a cold start is often hundreds of
 * metres out, and inside a substation or plant room there may be no fix at all.
 *
 * Three decisions follow:
 *  - We sample for a short window and keep the *best* fix, rather than taking
 *    the first one. The first reading is frequently the worst.
 *  - Accuracy is always surfaced to the user. A coordinate without its accuracy
 *    is a false claim of precision.
 *  - A mock-location flag is treated as a hard failure, never a warning. If an
 *    inspection's location can be spoofed, the whole evidentiary value collapses.
 */

import type { GeoPoint } from '@orbit/types';
import { bestFix, distanceMeters, gradeAccuracy } from '@orbit/utils';
import * as Location from 'expo-location';

export interface CaptureOptions {
  /** How long to keep sampling for a better fix, in ms. */
  timeoutMs?: number;
  /** Stop early once this accuracy is reached, in metres. */
  targetAccuracyMeters?: number;
  /** Emitted on every intermediate reading so the UI can show live accuracy. */
  onProgress?: (fix: GeoPoint, elapsedMs: number) => void;
  signal?: AbortSignal;
}

export type PermissionOutcome = 'GRANTED' | 'DENIED' | 'RESTRICTED';

export interface LocationCaptureResult {
  point: GeoPoint | null;
  grade: ReturnType<typeof gradeAccuracy>;
  /** Set when capture failed; safe to show to the user verbatim. */
  error: string | null;
  /** Number of readings considered. */
  samples: number;
}

function toGeoPoint(reading: Location.LocationObject): GeoPoint {
  return {
    latitude: reading.coords.latitude,
    longitude: reading.coords.longitude,
    accuracy: reading.coords.accuracy,
    altitude: reading.coords.altitude,
    altitudeAccuracy: reading.coords.altitudeAccuracy ?? null,
    heading: reading.coords.heading,
    speed: reading.coords.speed,
    capturedAt: new Date(reading.timestamp).toISOString() as GeoPoint['capturedAt'],
    // Android reports this directly. iOS does not expose it, so a spoofed
    // location on iOS requires a jailbreak, which is outside this threat model.
    mocked: (reading as unknown as { mocked?: boolean }).mocked === true,
  };
}

export async function requestPermission(): Promise<PermissionOutcome> {
  const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
  if (status === Location.PermissionStatus.GRANTED) return 'GRANTED';
  // "Denied and cannot ask again" needs different UI — the user has to go to
  // Settings, and telling them to "allow the prompt" would be wrong.
  return canAskAgain ? 'DENIED' : 'RESTRICTED';
}

export async function hasPermission(): Promise<boolean> {
  const { status } = await Location.getForegroundPermissionsAsync();
  return status === Location.PermissionStatus.GRANTED;
}

export async function isLocationEnabled(): Promise<boolean> {
  return Location.hasServicesEnabledAsync();
}

/**
 * Capture the best available fix within the timeout.
 *
 * Returns as soon as `targetAccuracyMeters` is met, so a good fix is fast and
 * only a poor environment costs the full window.
 */
export async function captureLocation(
  options: CaptureOptions = {},
): Promise<LocationCaptureResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const target = options.targetAccuracyMeters ?? 10;

  if (!(await hasPermission())) {
    const outcome = await requestPermission();
    if (outcome !== 'GRANTED') {
      return {
        point: null,
        grade: 'UNKNOWN',
        samples: 0,
        error:
          outcome === 'RESTRICTED'
            ? 'Location access is turned off for Orbit Field. Enable it in your device settings to stamp inspections with their location.'
            : 'Location permission is required to record where this inspection took place.',
      };
    }
  }

  if (!(await isLocationEnabled())) {
    return {
      point: null,
      grade: 'UNKNOWN',
      samples: 0,
      error: 'Location services are switched off on this device.',
    };
  }

  const samples: GeoPoint[] = [];
  const started = Date.now();

  return new Promise<LocationCaptureResult>((resolve) => {
    let subscription: Location.LocationSubscription | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      clearTimeout(timer);

      const best = bestFix(samples, 60_000);

      if (!best) {
        const anyMocked = samples.some((s) => s.mocked);
        resolve({
          point: null,
          grade: 'UNKNOWN',
          samples: samples.length,
          error: anyMocked
            ? 'A simulated location was detected. Turn off mock locations to continue.'
            : 'Could not get a location fix. Move to an area with a clearer view of the sky and try again.',
        });
        return;
      }

      resolve({
        point: best,
        grade: gradeAccuracy(best.accuracy),
        samples: samples.length,
        error: null,
      });
    };

    const timer = setTimeout(finish, timeoutMs);

    options.signal?.addEventListener('abort', finish);

    void Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        // Report every reading; we do the selection ourselves.
        timeInterval: 500,
        distanceInterval: 0,
      },
      (reading) => {
        const point = toGeoPoint(reading);

        // A mocked reading poisons the sample set — discard it entirely rather
        // than averaging it in.
        if (point.mocked) {
          samples.push(point);
          return;
        }

        samples.push(point);
        options.onProgress?.(point, Date.now() - started);

        if (point.accuracy !== null && point.accuracy <= target) {
          finish();
        }
      },
    )
      .then((sub) => {
        subscription = sub;
        if (settled) sub.remove();
      })
      .catch(() => {
        finish();
      });
  });
}

/** Single quick reading, for stamping a photo without blocking the shutter. */
export async function quickLocation(): Promise<GeoPoint | null> {
  try {
    if (!(await hasPermission())) return null;
    // The last known position is instant and usually good enough for a photo
    // stamp; waiting several seconds per shot would make burst capture painful.
    const last = await Location.getLastKnownPositionAsync({ maxAge: 30_000 });
    if (last) return toGeoPoint(last);

    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return toGeoPoint(current);
  } catch {
    return null;
  }
}

/** Whether a fix falls inside a site's registered geofence. */
export function checkGeofence(
  point: GeoPoint,
  site: { latitude: number | null; longitude: number | null; geofenceRadiusMeters: number | null },
): { inside: boolean; distanceMeters: number | null; radius: number | null } {
  if (site.latitude === null || site.longitude === null) {
    return { inside: true, distanceMeters: null, radius: null };
  }

  const distance = distanceMeters(point, { latitude: site.latitude, longitude: site.longitude });
  const radius = site.geofenceRadiusMeters;

  // With no radius configured we report the distance but never block — an
  // arbitrary default would reject legitimate work at large sites.
  if (radius === null) return { inside: true, distanceMeters: distance, radius: null };

  // The fix's own accuracy is added to the allowance. Rejecting someone standing
  // at the gate because their phone reported ±40 m would be a false negative.
  const allowance = radius + (point.accuracy ?? 0);
  return { inside: distance <= allowance, distanceMeters: distance, radius };
}

export { distanceMeters, gradeAccuracy };
