/**
 * Start a new inspection.
 *
 * Template selection is the whole screen. Everything else — site, client, due
 * date — is deliberately deferred to the form itself: an inspector standing in
 * front of a panel wants to start recording immediately, not fill in a metadata
 * wizard first. The record is created the moment a template is chosen, so even
 * if the app dies on the next screen the inspection exists.
 */

import { InspectionStatus } from '@orbit/types';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, EmptyState, Field, LoadingState, Txt } from '../../src/components/ui';
import { captureLocation } from '../../src/features/location/location.service';
import { invalidateQueries, useLiveQuery } from '../../src/hooks/useLiveQuery';
import { useRuntime } from '../../src/stores/session.store';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function NewInspectionScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  const templates = useLiveQuery(
    () => runtime.repositories.templates.listAvailable(search.trim() || undefined),
    [search],
  );
  const categories = useLiveQuery(() => runtime.repositories.templates.categories(), []);

  const filtered = category ? templates.filter((t) => t.category === category) : templates;

  /**
   * Create and open.
   *
   * The starting location is captured in the background — waiting up to twelve
   * seconds for a GPS fix before showing the form would be intolerable, and the
   * fix is only needed by the time the inspection is submitted.
   */
  const start = useCallback(
    (templateVersionId: string, templateId: string, name: string) => {
      setCreating(templateVersionId);
      try {
        const inspection = runtime.repositories.inspections.create({
          templateId,
          templateVersionId,
          title: name,
          assignedToId: runtime.identity.userId,
          status: InspectionStatus.IN_PROGRESS,
        });

        invalidateQueries();
        router.replace(`/inspection/${inspection.id}`);

        void (async () => {
          const result = await captureLocation({ timeoutMs: 15_000, targetAccuracyMeters: 20 });
          if (result.point) {
            runtime.repositories.inspections.update(inspection.id, {
              startLocation: result.point as never,
            });
            invalidateQueries();
          }
        })();
      } finally {
        setCreating(null);
      }
    },
    [runtime, router],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View
        style={{
          paddingTop: insets.top + theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.md,
          gap: theme.spacing.md,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <Txt
            variant="caption"
            color="accent"
            onPress={() => router.back()}
            accessibilityRole="button"
          >
            ‹ Cancel
          </Txt>
        </View>

        <Txt variant="title">Start an inspection</Txt>
        <Txt variant="caption" color="secondary">
          Choose the checklist for the work you are about to carry out.
        </Txt>

        <Field
          placeholder="Search checklists"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />

        {categories.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
          >
            {[null, ...categories].map((cat) => {
              const active = category === cat;
              return (
                <Pressable
                  key={cat ?? 'all'}
                  onPress={() => setCategory(cat)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={{
                    paddingHorizontal: theme.spacing.lg,
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
                    {cat ?? 'All'}
                  </Txt>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
          gap: theme.spacing.sm,
        }}
      >
        {filtered.length === 0 ? (
          <Card>
            <EmptyState
              icon="☰"
              title={search ? 'No matching checklists' : 'No checklists downloaded'}
              message={
                search
                  ? 'Try a different search term.'
                  : 'Checklists sync from your organisation. Connect to the internet and sync to download them.'
              }
              action={
                search ? (
                  <Button label="Clear search" variant="secondary" onPress={() => setSearch('')} />
                ) : (
                  <Button label="Sync now" onPress={() => void runtime.engine.sync('MANUAL')} />
                )
              }
            />
          </Card>
        ) : (
          filtered.map((template) => (
            <Card
              key={template.id}
              onPress={() => start(template.id, template.templateId, template.name)}
            >
              <View style={{ gap: theme.spacing.sm }}>
                <View
                  style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md }}
                >
                  <Txt variant="subheading" style={{ flex: 1 }}>
                    {template.name}
                  </Txt>
                  {creating === template.id ? (
                    <LoadingState label="" />
                  ) : (
                    <Txt color="muted">›</Txt>
                  )}
                </View>

                {template.description ? (
                  <Txt variant="caption" color="secondary" numberOfLines={2}>
                    {template.description}
                  </Txt>
                ) : null}

                <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                  {template.category ? <Badge label={template.category} tone="accent" /> : null}
                  {template.discipline ? (
                    <Badge label={template.discipline} tone="neutral" />
                  ) : null}
                  <Badge
                    label={`${template.fieldCount} question${template.fieldCount === 1 ? '' : 's'}`}
                    tone="neutral"
                  />
                  {/* Version is shown because an inspection is pinned to it and
                      the number appears on the final report. */}
                  <Badge label={`v${template.version}`} tone="neutral" />
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </View>
  );
}
