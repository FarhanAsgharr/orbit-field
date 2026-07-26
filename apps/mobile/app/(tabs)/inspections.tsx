/**
 * Inspections list.
 *
 * Reads entirely from SQLite, so search and filtering work identically offline.
 * `FlashList` rather than `FlatList` because an inspector with a year of history
 * can legitimately have several thousand rows, and FlatList's recycling falls
 * over well before that on a mid-range Android device.
 */

import { InspectionStatus } from '@orbit/types';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InspectionRow } from '../../src/components/InspectionRow';
import { Badge, Button, EmptyState, Field, Txt } from '../../src/components/ui';
import type { InspectionFilter } from '../../src/db/repositories/inspection.repository';
import { useLiveQuery, useRefresh } from '../../src/hooks/useLiveQuery';
import { useRuntime } from '../../src/stores/session.store';
import { useTheme } from '../../src/theme/ThemeProvider';

type QuickFilter = 'ALL' | 'MINE' | 'OPEN' | 'DUE' | 'UNSYNCED' | 'COMPLETED';

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: 'MINE', label: 'My work' },
  { key: 'OPEN', label: 'Open' },
  { key: 'DUE', label: 'Due soon' },
  { key: 'UNSYNCED', label: 'Not synced' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'ALL', label: 'All' },
];

export default function InspectionsScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();

  const [search, setSearch] = useState('');
  const [quick, setQuick] = useState<QuickFilter>('MINE');

  const buildFilter = useCallback((): InspectionFilter => {
    const base: InspectionFilter = {
      search: search.trim() || undefined,
      sortBy: 'updatedAt',
      sortDir: 'desc',
      limit: 500,
    };

    switch (quick) {
      case 'MINE':
        return { ...base, assignedToId: runtime.identity.userId };
      case 'OPEN':
        return {
          ...base,
          status: [
            InspectionStatus.DRAFT,
            InspectionStatus.SCHEDULED,
            InspectionStatus.IN_PROGRESS,
            InspectionStatus.REJECTED,
          ],
        };
      case 'DUE':
        return {
          ...base,
          // Next seven days — the planning horizon an inspector actually works to.
          dueBefore: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          status: [
            InspectionStatus.SCHEDULED,
            InspectionStatus.IN_PROGRESS,
            InspectionStatus.DRAFT,
          ],
          sortBy: 'dueAt',
          sortDir: 'asc',
        };
      case 'UNSYNCED':
        return { ...base, dirtyOnly: true };
      case 'COMPLETED':
        return {
          ...base,
          status: [
            InspectionStatus.SUBMITTED,
            InspectionStatus.UNDER_REVIEW,
            InspectionStatus.APPROVED,
          ],
        };
      case 'ALL':
      default:
        return { ...base, includeArchived: true };
    }
  }, [search, quick, runtime.identity.userId]);

  const items = useLiveQuery(
    () => runtime.repositories.inspections.list(buildFilter()),
    [search, quick],
  );

  const { refreshing, refresh } = useRefresh(
    useCallback(async () => {
      await runtime.engine.sync('MANUAL');
    }, [runtime]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      {/* --- header --- */}
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Txt variant="title">Inspections</Txt>
          <Button label="New" size="small" onPress={() => router.push('/inspection/new')} />
        </View>

        <Field
          placeholder="Search by reference, title, or site"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
        >
          {QUICK_FILTERS.map((filter) => {
            const active = quick === filter.key;
            return (
              <Pressable
                key={filter.key}
                onPress={() => setQuick(filter.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  paddingHorizontal: theme.spacing.lg,
                  // Chips still clear the 48pt gloved-hand minimum.
                  minHeight: theme.touchTarget.minimum,
                  justifyContent: 'center',
                  borderRadius: theme.radius.pill,
                  backgroundColor: active ? theme.colors.accent : theme.colors.surface,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : theme.colors.border,
                }}
              >
                <Txt
                  variant="captionStrong"
                  style={{ color: active ? theme.colors.accentText : theme.colors.textSecondary }}
                >
                  {filter.label}
                </Txt>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Txt variant="micro" color="muted">
            {items.length} {items.length === 1 ? 'inspection' : 'inspections'}
          </Txt>
          {items.some((i) => i.hasPendingChanges) ? (
            <Badge
              label={`${items.filter((i) => i.hasPendingChanges).length} not synced`}
              tone="warning"
              icon="↑"
            />
          ) : null}
        </View>
      </View>

      {/* --- list --- */}
      <FlashList
        data={items}
        keyExtractor={(item) => item.id}
        estimatedItemSize={168}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
        }}
        ItemSeparatorComponent={() => <View style={{ height: theme.spacing.sm }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.colors.accent}
          />
        }
        renderItem={({ item }) => (
          <InspectionRow item={item} onPress={() => router.push(`/inspection/${item.id}`)} />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={search ? '⌕' : '☰'}
            title={search ? 'No matches' : 'No inspections yet'}
            message={
              search
                ? `Nothing matches "${search.trim()}". Try a different reference or site name.`
                : quick === 'UNSYNCED'
                  ? 'Everything on this device has been saved to the server.'
                  : 'Inspections assigned to you will appear here. Pull down to check for new work.'
            }
            action={
              search ? (
                <Button label="Clear search" variant="secondary" onPress={() => setSearch('')} />
              ) : (
                <Button
                  label="Start an inspection"
                  onPress={() => router.push('/inspection/new')}
                />
              )
            }
          />
        }
      />
    </View>
  );
}
