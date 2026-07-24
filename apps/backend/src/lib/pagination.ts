/**
 * Pagination and query helpers.
 *
 * Offset pagination is used for admin list screens, where users jump to
 * arbitrary pages and the dataset is small enough that the offset cost is
 * irrelevant. Cursor pagination is used for anything a device streams, where
 * a stable ordering under concurrent inserts matters more than page numbers —
 * offset pagination silently skips rows when the underlying set shifts.
 */

import { z } from 'zod';
import type { Paginated } from '@orbit/types';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export function paginationArgs(input: PaginationInput): { skip: number; take: number } {
  return { skip: (input.page - 1) * input.pageSize, take: input.pageSize };
}

export function paginate<T>(items: T[], total: number, input: PaginationInput): Paginated<T> {
  return {
    items,
    total,
    page: input.page,
    pageSize: input.pageSize,
    hasMore: input.page * input.pageSize < total,
  };
}

/**
 * Build an ORDER BY clause from an allowlist.
 *
 * The allowlist is not optional — interpolating a caller-supplied column name
 * into SQL is an injection vector, and Prisma's `orderBy` will happily accept a
 * key that does not exist and throw at runtime.
 */
export function sortArgs<T extends string>(
  sortBy: string | undefined,
  sortDir: string | undefined,
  allowed: readonly T[],
  fallback: T,
): Record<string, 'asc' | 'desc'> {
  const column = allowed.includes(sortBy as T) ? (sortBy as T) : fallback;
  const direction = sortDir === 'asc' ? 'asc' : 'desc';
  return { [column]: direction };
}

/** Case-insensitive contains filter, or undefined when the term is blank. */
export function searchFilter(term: string | undefined): { contains: string; mode: 'insensitive' } | undefined {
  const trimmed = term?.trim();
  if (!trimmed) return undefined;
  return { contains: trimmed, mode: 'insensitive' };
}

/** Coerce a comma-separated query parameter into an array. */
export const csvArray = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined));

/** Standard date-range filter fragment. */
export function dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const range: { gte?: Date; lte?: Date } = {};
  if (from) {
    const parsed = new Date(from);
    if (!Number.isNaN(parsed.getTime())) range.gte = parsed;
  }
  if (to) {
    const parsed = new Date(to);
    if (!Number.isNaN(parsed.getTime())) range.lte = parsed;
  }
  return Object.keys(range).length > 0 ? range : undefined;
}
