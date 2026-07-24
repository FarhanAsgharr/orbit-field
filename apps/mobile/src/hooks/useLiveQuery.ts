/**
 * Live SQLite queries.
 *
 * Screens read from the local database, which changes underneath them for two
 * reasons: the user edits something, or the sync engine applies a pulled change.
 * Neither goes through React state, so components need an explicit signal to
 * re-read.
 *
 * A revision counter, bumped on every write, is deliberately coarse: a
 * fine-grained per-table subscription sounds better but means a screen showing
 * a joined projection (inspection + site + attachment count) has to subscribe to
 * four tables and still cannot know whether its particular row changed.
 * Re-running a millisecond-scale indexed query is cheaper than the bookkeeping.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

type Listener = () => void;

let revision = 0;
const listeners = new Set<Listener>();

/** Notify every live query that local data changed. */
export function invalidateQueries(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return revision;
}

/**
 * Run `query` and re-run it whenever local data changes.
 *
 * `deps` behaves like a `useMemo` dependency list — include anything the query
 * closes over (filters, ids), or the screen will keep showing the old result.
 */
export function useLiveQuery<T>(query: () => T, deps: readonly unknown[] = []): T {
  const rev = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const queryRef = useRef(query);
  queryRef.current = query;

  const [value, setValue] = useState<T>(() => query());

  useEffect(() => {
    setValue(queryRef.current());
    // `rev` is the change signal; `deps` covers the query's own inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, ...deps]);

  return value;
}

/**
 * Imperative refresh for pull-to-refresh.
 * Returns a callback plus the in-flight flag the RefreshControl needs.
 */
export function useRefresh(onRefresh: () => Promise<void>): {
  refreshing: boolean;
  refresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void onRefresh()
      .catch(() => undefined)
      .finally(() => {
        setRefreshing(false);
        invalidateQueries();
      });
  }, [onRefresh, refreshing]);

  return { refreshing, refresh };
}
