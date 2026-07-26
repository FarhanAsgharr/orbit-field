/**
 * Server-paginated table.
 *
 * Every list screen in the console is the same shape — search, filter, page,
 * sort — so it is one component rather than nine near-identical ones. Column
 * rendering is supplied per screen; everything else is shared.
 *
 * Search is debounced. Without it, a nine-character query fires nine requests
 * and the results race, so the operator sees answers to a query they have
 * already moved past.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import React, { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import { Empty, ErrorBanner, Loading, Pagination } from './ui';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  /** Right-aligns and applies tabular figures. */
  numeric?: boolean;
  width?: string;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  /** API path, e.g. `/users`. */
  endpoint: string;
  queryKey: unknown[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  searchPlaceholder?: string;
  filters?: React.ReactNode;
  extraQuery?: Record<string, string | number | boolean | string[] | undefined>;
  defaultSort?: { by: string; dir: 'asc' | 'desc' };
  emptyTitle?: string;
  emptyBody?: string;
  toolbarAction?: React.ReactNode;
  onRowClick?: (row: T) => void;
  pageSize?: number;
}

interface PagedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function DataTable<T>({
  endpoint,
  queryKey,
  columns,
  rowKey,
  searchPlaceholder = 'Search',
  filters,
  extraQuery,
  defaultSort,
  emptyTitle = 'Nothing here yet',
  emptyBody,
  toolbarAction,
  onRowClick,
  pageSize = 25,
}: DataTableProps<T>): React.ReactElement {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(defaultSort);

  const debouncedSearch = useDebounced(search);

  // A new search or filter invalidates the current page number: showing page 4
  // of a result set that now has one page is an empty screen the operator has
  // no way to interpret.
  // Serialised once into a variable: an expression inside the dependency array
  // cannot be statically verified, so a future edit can silently drop it.
  const extraQueryKey = JSON.stringify(extraQuery);
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, extraQueryKey]);

  const query = useMemo(
    () => ({
      page,
      pageSize,
      search: debouncedSearch || undefined,
      sortBy: sort?.by,
      sortDir: sort?.dir,
      ...extraQuery,
    }),
    [page, pageSize, debouncedSearch, sort, extraQuery],
  );

  const { data, isLoading, isError, error } = useQuery<PagedResponse<T>>({
    queryKey: [...queryKey, query],
    queryFn: () => api.get<PagedResponse<T>>(endpoint, query),
    // Keeps the previous page visible while the next loads, so paging does not
    // flash the table to empty and back.
    placeholderData: keepPreviousData,
  });

  const toggleSort = (key: string): void => {
    setSort((current) =>
      current?.by === key
        ? { by: key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { by: key, dir: 'asc' },
    );
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="toolbar__search">
          <input
            className="input"
            type="search"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={searchPlaceholder}
          />
        </div>
        {filters}
        {toolbarAction ? <div className="right">{toolbarAction}</div> : null}
      </div>

      {isError ? (
        <ErrorBanner
          message={error instanceof Error ? error.message : 'Could not load this list.'}
        />
      ) : null}

      <div className="card">
        {isLoading ? (
          <Loading rows={6} />
        ) : !data || data.items.length === 0 ? (
          <Empty
            title={debouncedSearch ? 'No matches' : emptyTitle}
            body={
              debouncedSearch
                ? `Nothing matches “${debouncedSearch}”. Try a different term.`
                : emptyBody
            }
            action={
              debouncedSearch ? (
                <button className="btn btn--secondary" onClick={() => setSearch('')}>
                  Clear search
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className={data.items.length > 12 ? 'table-wrap table-wrap--tall' : 'table-wrap'}>
              <table className="table">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        style={{
                          width: column.width,
                          textAlign: column.numeric ? 'right' : undefined,
                        }}
                        aria-sort={
                          sort?.by === column.key
                            ? sort.dir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                      >
                        {column.sortable ? (
                          <button
                            className="btn btn--ghost btn--sm"
                            style={{
                              padding: 0,
                              height: 'auto',
                              font: 'inherit',
                              color: 'inherit',
                            }}
                            onClick={() => toggleSort(column.key)}
                          >
                            {column.header}
                            {sort?.by === column.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                          </button>
                        ) : (
                          column.header
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr
                      key={rowKey(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      style={onRowClick ? { cursor: 'pointer' } : undefined}
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={column.numeric ? 'table__num num' : undefined}
                        >
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}
