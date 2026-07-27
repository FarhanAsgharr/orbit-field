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
  /**
   * Turn on row selection.
   *
   * Optional and off by default, so the seven tables that do not want it are
   * unchanged. When set, the table renders a checkbox column and reports the
   * current selection; the page above owns what to do with it.
   */
  selection?: {
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
    /** Rendered above the table while anything is selected. */
    actions?: (selected: Set<string>, clear: () => void) => React.ReactNode;
  };
  /** Rendered in the toolbar; receives the query in force, so exports match the view. */
  exportAction?: (
    query: Record<string, string | number | boolean | undefined | null>,
  ) => React.ReactNode;
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
  selection,
  exportAction,
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
        <div className="right row gap-2">
          {/* The export gets the query in force, so what downloads is what is
              on screen — an export that quietly ignores the filters is worse
              than none, because nobody checks the row count. */}
          {exportAction ? exportAction(query) : null}
          {toolbarAction}
        </div>
      </div>

      {selection && selection.selected.size > 0 ? (
        <div className="toolbar" role="region" aria-label="Selected rows">
          <strong>{selection.selected.size} selected</strong>
          {selection.actions?.(selection.selected, () => selection.onChange(new Set()))}
          <button className="btn btn--ghost btn--sm" onClick={() => selection.onChange(new Set())}>
            Clear selection
          </button>
        </div>
      ) : null}

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
                    {selection ? (
                      <th style={{ width: '36px' }}>
                        <input
                          type="checkbox"
                          aria-label="Select every row on this page"
                          checked={
                            data.items.length > 0 &&
                            data.items.every((r) => selection.selected.has(rowKey(r)))
                          }
                          onChange={(e) => {
                            // Scoped to the page in view. Selecting rows a
                            // person cannot see is how a bulk action ends up
                            // touching records nobody looked at.
                            const next = new Set(selection.selected);
                            for (const r of data.items) {
                              if (e.target.checked) next.add(rowKey(r));
                              else next.delete(rowKey(r));
                            }
                            selection.onChange(next);
                          }}
                        />
                      </th>
                    ) : null}
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
                      {selection ? (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${rowKey(row)}`}
                            checked={selection.selected.has(rowKey(row))}
                            onChange={(e) => {
                              const next = new Set(selection.selected);
                              if (e.target.checked) next.add(rowKey(row));
                              else next.delete(rowKey(row));
                              selection.onChange(next);
                            }}
                          />
                        </td>
                      ) : null}
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
