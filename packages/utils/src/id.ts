/**
 * ULID generation.
 *
 * Offline devices must mint primary keys that will never collide with keys
 * minted by 4,000 other devices in the same organisation, and that sort by
 * creation time so index locality on Postgres stays good. ULID gives both:
 * 48 bits of millisecond timestamp followed by 80 bits of randomness, encoded in
 * Crockford base32.
 *
 * Implemented here rather than pulled from npm because it must behave identically
 * in Node, in Hermes (React Native), and in the browser, and because the
 * monotonic-within-a-millisecond guarantee below is stricter than most packages
 * provide by default.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = 281474976710655; // 2^48 - 1, i.e. year 10889

/** Cryptographically secure random bytes across Node, RN, and browsers. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const g = globalThis as unknown as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  };
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
    return bytes;
  }
  // Last resort. Reaching here means the runtime has no CSPRNG, which for an
  // app that mints security-relevant identifiers is a defect, not a fallback —
  // so we make it loud rather than silently degrading entropy.
  throw new Error(
    'No cryptographically secure random source available; refusing to mint identifiers.',
  );
}

function encodeTime(now: number, len: number): string {
  if (!Number.isInteger(now) || now < 0 || now > TIME_MAX) {
    throw new RangeError(`ULID timestamp out of range: ${now}`);
  }
  let out = '';
  let remaining = now;
  for (let i = len - 1; i >= 0; i--) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i]! % ENCODING_LEN];
  }
  return out;
}

/**
 * Increment the random component in base32, used to keep IDs strictly ordered
 * when several are minted inside the same millisecond.
 */
function incrementBase32(str: string): string {
  const chars = str.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = ENCODING.indexOf(chars[i]!);
    if (index === -1) throw new Error('Invalid base32 character in ULID');
    if (index < ENCODING_LEN - 1) {
      chars[i] = ENCODING[index + 1]!;
      return chars.join('');
    }
    chars[i] = ENCODING[0]!; // carry
  }
  // Overflowed all 80 random bits inside one millisecond — statistically
  // impossible, but if it happens we must not return a duplicate.
  throw new Error('ULID random component overflow');
}

let lastTime = -1;
let lastRandom = '';

/**
 * Generate a ULID that is strictly monotonic within this process. Two calls in
 * the same millisecond return increasing values, so `ORDER BY id` equals
 * `ORDER BY created_at` even at sub-millisecond insert rates.
 */
export function ulid(seedTime?: number): string {
  const now = seedTime ?? Date.now();

  if (now === lastTime) {
    lastRandom = incrementBase32(lastRandom);
  } else if (now < lastTime) {
    // Clock moved backwards (NTP correction, user changing device time).
    // Keep issuing under the previous timestamp rather than emitting IDs that
    // sort before ones already handed out.
    lastRandom = incrementBase32(lastRandom);
    return encodeTime(lastTime, TIME_LEN) + lastRandom;
  } else {
    lastTime = now;
    lastRandom = encodeRandom(RANDOM_LEN);
  }

  return encodeTime(now, TIME_LEN) + lastRandom;
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** Extract the creation time embedded in a ULID. */
export function ulidTime(id: string): Date {
  if (!isUlid(id)) throw new TypeError(`Not a ULID: ${id}`);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    time = time * ENCODING_LEN + ENCODING.indexOf(id[i]!);
  }
  return new Date(time);
}

/** RFC-4122 v4 UUID, for the few places an external system demands one. */
export function uuidv4(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Human-facing inspection reference, e.g. `INS-2026-004182`.
 * The sequence is allocated server-side; offline records display their ULID
 * suffix until they sync and receive the real number.
 */
export function formatInspectionNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}

/** Placeholder shown for an inspection that has not yet reached the server. */
export function provisionalInspectionNumber(id: string): string {
  return `DRAFT-${id.slice(-6)}`;
}
