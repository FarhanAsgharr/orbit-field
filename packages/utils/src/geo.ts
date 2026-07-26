/** Geospatial helpers. Pure, dependency-free, identical on device and server. */

import type { GeoPoint } from '@orbit/types';

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than Vincenty: at the distances that matter here (metres to
 * tens of kilometres) the ellipsoidal correction is under 0.5 %, well inside GPS
 * noise, and haversine has no convergence failure mode near antipodes.
 */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, degrees clockwise from true north. */
export function bearingDegrees(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function isWithinGeofence(
  point: { latitude: number; longitude: number },
  center: { latitude: number; longitude: number },
  radiusMeters: number,
): boolean {
  return distanceMeters(point, center) <= radiusMeters;
}

export type AccuracyGrade = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'UNUSABLE' | 'UNKNOWN';

/** Bucket a raw accuracy reading for display as a status chip. */
export function gradeAccuracy(accuracyMeters: number | null): AccuracyGrade {
  if (accuracyMeters === null || !Number.isFinite(accuracyMeters)) return 'UNKNOWN';
  if (accuracyMeters <= 5) return 'EXCELLENT';
  if (accuracyMeters <= 15) return 'GOOD';
  if (accuracyMeters <= 50) return 'FAIR';
  if (accuracyMeters <= 200) return 'POOR';
  return 'UNUSABLE';
}

export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // 0,0 is in the Gulf of Guinea. It is far more often a null-island sentinel
    // from a failed fix than a real inspection site.
    !(lat === 0 && lon === 0)
  );
}

/** Format for display, e.g. `24.774265° N, 46.738586° E`. */
export function formatCoordinate(lat: number, lon: number, precision = 6): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(precision)}° ${ns}, ${Math.abs(lon).toFixed(precision)}° ${ew}`;
}

/** Degrees → 16-point compass label. */
export function compassPoint(degrees: number): string {
  const points = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  return points[Math.round((degrees % 360) / 22.5) % 16]!;
}

/** Axis-aligned bounding box around a set of points, padded by `paddingMeters`. */
export function boundingBox(
  points: Array<{ latitude: number; longitude: number }>,
  paddingMeters = 0,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } | null {
  if (points.length === 0) return null;
  let minLat = 90,
    maxLat = -90,
    minLon = 180,
    maxLon = -180;
  for (const p of points) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLon = Math.min(minLon, p.longitude);
    maxLon = Math.max(maxLon, p.longitude);
  }
  if (paddingMeters > 0) {
    const latPad = (paddingMeters / EARTH_RADIUS_M) * (180 / Math.PI);
    const midLat = toRad((minLat + maxLat) / 2);
    const lonPad = latPad / Math.max(Math.cos(midLat), 1e-6);
    minLat -= latPad;
    maxLat += latPad;
    minLon -= lonPad;
    maxLon += lonPad;
  }
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * Pick the best fix from a stream of readings.
 * Prefers accuracy but discards anything older than `maxAgeMs`, since a very
 * precise fix from ten minutes ago is worse than a rough one from just now.
 */
export function bestFix(fixes: GeoPoint[], maxAgeMs = 60_000, now = Date.now()): GeoPoint | null {
  const fresh = fixes.filter((f) => !f.mocked && now - Date.parse(f.capturedAt) <= maxAgeMs);
  const pool = fresh.length > 0 ? fresh : fixes.filter((f) => !f.mocked);
  if (pool.length === 0) return null;
  return pool.reduce((best, f) =>
    (f.accuracy ?? Infinity) < (best.accuracy ?? Infinity) ? f : best,
  );
}
