/**
 * `globalThis.crypto.getRandomValues` for Hermes.
 *
 * Node and every browser provide this; Hermes does not, and React Native adds
 * no polyfill of its own. Nothing warns about it — the gap only appears at the
 * first call, at runtime, on a real build.
 *
 * That first call is `ulid()`. Every primary key in this app is minted on the
 * device (see `packages/utils/src/id.ts`), and `randomBytes` there refuses to
 * degrade to `Math.random()` for identifiers that end up in a compliance
 * record — it throws instead. So without this module:
 *
 *   - `engine.sync()` dies on its first line, before it can even open its log
 *     row, and because that line sits outside the try/finally the `running`
 *     flag is never cleared. Every later sync returns immediately and silently.
 *     The app signs in, reports "Online", and never downloads any work.
 *   - Nothing offline can be created at all: outbox operations, inspections,
 *     attachments and responses all need a client-minted ULID.
 *
 * The failure is invisible in development, where Metro's runtime supplies
 * `crypto`, and invisible in the release log, because the throw surfaces inside
 * a `void`-ed promise that nobody awaits.
 *
 * Imported for its side effect, first, before anything that might mint an id.
 * `expo-crypto` is already a dependency and is backed by the platform CSPRNG,
 * so this adds no new native module.
 */

import { getRandomValues } from 'expo-crypto';

type RandomFillingCrypto = {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};

const globals = globalThis as unknown as { crypto?: Partial<RandomFillingCrypto> };

if (typeof globals.crypto?.getRandomValues !== 'function') {
  const fill = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array;
    // expo-crypto accepts the integer TypedArrays, which is every type the Web
    // Crypto signature permits here.
    return getRandomValues(array as never) as unknown as T;
  };

  if (globals.crypto) {
    // Keep whatever else the runtime already exposes (`randomUUID`, `subtle`).
    globals.crypto.getRandomValues = fill;
  } else {
    // Not writable by assignment on some runtimes, hence defineProperty.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: fill },
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
}
