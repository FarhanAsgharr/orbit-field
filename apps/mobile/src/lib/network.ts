/**
 * Connectivity.
 *
 * `isConnected` alone is not enough. A device attached to a site wifi access
 * point with no upstream route reports connected, and every request then hangs
 * until it times out. `isInternetReachable` distinguishes the two, which is the
 * difference between the sync engine backing off politely and hammering a dead
 * link.
 */

import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { NetworkState } from '../sync/engine';

let current: NetworkState = { isConnected: false, isMetered: false };
let unsubscribe: (() => void) | null = null;

const listeners = new Set<(state: NetworkState) => void>();

function translate(state: NetInfoState): NetworkState {
  // `isInternetReachable` is null while NetInfo is still probing. Treating null
  // as connected avoids a false "offline" banner in the first second after
  // launch, which users read as the app being broken.
  const reachable = state.isInternetReachable ?? true;
  const isConnected = Boolean(state.isConnected) && reachable;

  // Cellular is always metered. Wifi is metered when the OS says so (a phone
  // hotspot), which is exactly the case where a 40 MB video upload would cost
  // the inspector real money.
  const isMetered =
    state.type === 'cellular' ||
    (state.type === 'wifi' && state.details?.isConnectionExpensive === true);

  return { isConnected, isMetered };
}

/** Begin observing. Called once during app start-up. */
export function startNetworkMonitor(): () => void {
  if (unsubscribe) return unsubscribe;

  unsubscribe = NetInfo.addEventListener((state) => {
    const next = translate(state);
    const changed = next.isConnected !== current.isConnected || next.isMetered !== current.isMetered;
    current = next;
    if (changed) {
      for (const listener of listeners) listener(next);
    }
  });

  void NetInfo.fetch().then((state) => {
    current = translate(state);
  });

  return unsubscribe;
}

export function stopNetworkMonitor(): void {
  unsubscribe?.();
  unsubscribe = null;
  listeners.clear();
}

/** Synchronous read — the sync engine needs this without awaiting. */
export function getNetworkState(): NetworkState {
  return current;
}

/** Subscribe to transitions. Returns an unsubscribe function. */
export function onNetworkChange(listener: (state: NetworkState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Force a fresh probe, e.g. when the user taps "retry". */
export async function refreshNetworkState(): Promise<NetworkState> {
  const state = await NetInfo.fetch();
  current = translate(state);
  return current;
}

export type { NetworkState };
