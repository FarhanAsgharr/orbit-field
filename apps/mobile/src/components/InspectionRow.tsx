/**
 * Inspection list row.
 *
 * Shared by the dashboard and the inspections list so the two can never drift.
 *
 * Sync state is shown on the row itself rather than only in the sync tab: an
 * inspector needs to see at a glance which of the twelve jobs they did today has
 * actually reached the server, without navigating away from the list.
 */

import type { InspectionListItem } from '@orbit/types';
import { formatRelativeTime } from '@orbit/utils';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import {
  Badge,
  Card,
  outcomePresentation,
  priorityPresentation,
  ProgressBar,
  statusPresentation,
  Txt,
} from './ui';

export function InspectionRow({
  item,
  onPress,
}: {
  item: InspectionListItem;
  onPress: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const status = statusPresentation(item.status);
  const priority = priorityPresentation(item.priority);
  const outcome = outcomePresentation(item.outcome);

  const progress = item.totalFields > 0 ? item.answeredFields / item.totalFields : 0;

  // Overdue is computed at render rather than stored: a row that was on time
  // when it was written becomes overdue by the passage of time alone.
  const isOverdue =
    item.dueAt !== null &&
    Date.parse(item.dueAt) < Date.now() &&
    !['APPROVED', 'CANCELLED', 'ARCHIVED', 'SUBMITTED', 'UNDER_REVIEW'].includes(item.status);

  return (
    <Card onPress={onPress} padded={false}>
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        {/* --- line 1: reference and status --- */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Txt variant="micro" color="muted" style={{ flex: 1 }} numberOfLines={1}>
            {item.number}
          </Txt>
          {item.hasConflict ? (
            <Badge label="Conflict" tone="danger" icon="⚠" />
          ) : item.hasPendingChanges ? (
            <Badge label="Not synced" tone="warning" icon="↑" />
          ) : null}
          <Badge label={status.label} tone={status.tone} icon={status.icon} />
        </View>

        {/* --- line 2: title --- */}
        <Txt variant="subheading" numberOfLines={2}>
          {item.title}
        </Txt>

        {/* --- line 3: context --- */}
        <View style={{ gap: theme.spacing.xxs }}>
          <Txt variant="caption" color="secondary" numberOfLines={1}>
            {item.templateName}
          </Txt>
          {item.siteName || item.clientName ? (
            <Txt variant="caption" color="muted" numberOfLines={1}>
              {[item.siteName, item.clientName].filter(Boolean).join(' · ')}
            </Txt>
          ) : null}
        </View>

        {/* --- progress, only while there is progress to show --- */}
        {item.totalFields > 0 && item.status !== 'APPROVED' ? (
          <View style={{ gap: theme.spacing.xs }}>
            <ProgressBar
              value={progress}
              tone={progress === 1 ? 'success' : 'accent'}
              label={`${item.answeredFields} of ${item.totalFields} questions answered`}
            />
            <Txt variant="micro" color="muted">
              {item.answeredFields} / {item.totalFields} answered
              {item.attachmentCount > 0
                ? ` · ${item.attachmentCount} attachment${item.attachmentCount === 1 ? '' : 's'}`
                : ''}
            </Txt>
          </View>
        ) : null}

        {/* --- footer: due date, priority, outcome --- */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            flexWrap: 'wrap',
          }}
        >
          {item.dueAt ? (
            <Badge
              label={
                isOverdue
                  ? `Overdue ${formatRelativeTime(item.dueAt)}`
                  : `Due ${formatRelativeTime(item.dueAt)}`
              }
              tone={isOverdue ? 'danger' : 'neutral'}
              icon={isOverdue ? '!' : '◔'}
            />
          ) : null}

          {item.priority !== 'NORMAL' ? (
            <Badge label={priority.label} tone={priority.tone} icon={priority.icon} />
          ) : null}

          {item.outcome !== 'PENDING' ? (
            <Badge label={outcome.label} tone={outcome.tone} icon={outcome.icon} />
          ) : null}

          {item.score !== null ? (
            <Txt variant="micro" color="muted" style={{ marginLeft: 'auto' }}>
              {Math.round(item.score)}%
            </Txt>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
