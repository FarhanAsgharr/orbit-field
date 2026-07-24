/**
 * Inspection lifecycle state machine.
 *
 * Enforced on both sides. The device needs it to grey out impossible actions;
 * the server needs it because a device that has been offline for a week may push
 * a transition that was legal when it was queued and is not any more.
 */

import {
  InspectionStatus,
  type Role,
} from '@orbit/types';
import { Permission, can, type AccessSubject } from './rbac.js';
import { AppError, ErrorCode, invalidTransition } from './errors.js';

export interface TransitionRule {
  from: InspectionStatus;
  to: InspectionStatus;
  /** Permission the actor must hold. */
  permission: Permission;
  /** Extra conditions checked against the record. */
  guard?: (ctx: TransitionContext) => string | null;
}

export interface TransitionContext {
  subject: AccessSubject;
  inspection: {
    id: string;
    status: InspectionStatus;
    assignedToId: string | null;
    projectId: string | null;
    totalFields: number;
    answeredFields: number;
    criticalFailures: number;
  };
  /** Validation must have passed before SUBMITTED is reachable. */
  validationPassed?: boolean;
  /** Set when the actor holds `inspection:override`. */
  overrideWarnings?: boolean;
}

const requireAssignee = (ctx: TransitionContext): string | null => {
  if (ctx.inspection.assignedToId === null) return 'This inspection has no assignee.';
  return null;
};

const requireValidation = (ctx: TransitionContext): string | null => {
  if (ctx.validationPassed === false) {
    return 'All required questions must be answered before submitting.';
  }
  return null;
};

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: InspectionStatus.DRAFT, to: InspectionStatus.SCHEDULED, permission: Permission.INSPECTION_ASSIGN, guard: requireAssignee },
  { from: InspectionStatus.DRAFT, to: InspectionStatus.IN_PROGRESS, permission: Permission.INSPECTION_UPDATE },
  { from: InspectionStatus.DRAFT, to: InspectionStatus.CANCELLED, permission: Permission.INSPECTION_DELETE },

  { from: InspectionStatus.SCHEDULED, to: InspectionStatus.IN_PROGRESS, permission: Permission.INSPECTION_UPDATE },
  { from: InspectionStatus.SCHEDULED, to: InspectionStatus.CANCELLED, permission: Permission.INSPECTION_ASSIGN },
  { from: InspectionStatus.SCHEDULED, to: InspectionStatus.DRAFT, permission: Permission.INSPECTION_ASSIGN },

  { from: InspectionStatus.IN_PROGRESS, to: InspectionStatus.SUBMITTED, permission: Permission.INSPECTION_SUBMIT, guard: requireValidation },
  { from: InspectionStatus.IN_PROGRESS, to: InspectionStatus.CANCELLED, permission: Permission.INSPECTION_ASSIGN },

  { from: InspectionStatus.SUBMITTED, to: InspectionStatus.UNDER_REVIEW, permission: Permission.INSPECTION_REVIEW },
  { from: InspectionStatus.SUBMITTED, to: InspectionStatus.APPROVED, permission: Permission.INSPECTION_REVIEW },
  { from: InspectionStatus.SUBMITTED, to: InspectionStatus.REJECTED, permission: Permission.INSPECTION_REVIEW },

  { from: InspectionStatus.UNDER_REVIEW, to: InspectionStatus.APPROVED, permission: Permission.INSPECTION_REVIEW },
  { from: InspectionStatus.UNDER_REVIEW, to: InspectionStatus.REJECTED, permission: Permission.INSPECTION_REVIEW },

  // A rejected inspection returns to the inspector for correction.
  { from: InspectionStatus.REJECTED, to: InspectionStatus.IN_PROGRESS, permission: Permission.INSPECTION_UPDATE },
  { from: InspectionStatus.REJECTED, to: InspectionStatus.CANCELLED, permission: Permission.INSPECTION_ASSIGN },

  // Reopening an approved inspection is deliberately a distinct permission —
  // it rewrites a record someone has already signed off on.
  { from: InspectionStatus.APPROVED, to: InspectionStatus.UNDER_REVIEW, permission: Permission.INSPECTION_REOPEN },
  { from: InspectionStatus.APPROVED, to: InspectionStatus.ARCHIVED, permission: Permission.INSPECTION_ARCHIVE },
  { from: InspectionStatus.CANCELLED, to: InspectionStatus.ARCHIVED, permission: Permission.INSPECTION_ARCHIVE },
  { from: InspectionStatus.ARCHIVED, to: InspectionStatus.APPROVED, permission: Permission.INSPECTION_REOPEN },
];

export function allowedTransitions(from: InspectionStatus, subject: AccessSubject): InspectionStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && can(subject, t.permission)).map((t) => t.to);
}

export function canTransition(ctx: TransitionContext, to: InspectionStatus): boolean {
  return assertTransitionResult(ctx, to) === null;
}

/** Returns null when the transition is legal, or a human-readable reason. */
export function assertTransitionResult(ctx: TransitionContext, to: InspectionStatus): string | null {
  const from = ctx.inspection.status;
  if (from === to) return null;

  const rule = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!rule) return `An inspection cannot move from ${from} to ${to}.`;
  if (!can(ctx.subject, rule.permission)) return 'You do not have permission to perform this action.';

  const guardFailure = rule.guard?.(ctx);
  if (guardFailure) {
    // The override permission relaxes soft guards, never the permission check.
    if (ctx.overrideWarnings && can(ctx.subject, Permission.INSPECTION_OVERRIDE)) return null;
    return guardFailure;
  }
  return null;
}

/** Throwing variant used by the API layer. */
export function assertTransition(ctx: TransitionContext, to: InspectionStatus): void {
  const failure = assertTransitionResult(ctx, to);
  if (failure === null) return;
  if (failure.startsWith('You do not have permission')) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, failure);
  }
  if (!TRANSITIONS.some((t) => t.from === ctx.inspection.status && t.to === to)) {
    throw invalidTransition(ctx.inspection.status, to);
  }
  throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, failure);
}

/** Statuses that count as "open work" on the dashboard. */
export const OPEN_STATUSES: readonly InspectionStatus[] = [
  InspectionStatus.DRAFT,
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
  InspectionStatus.REJECTED,
];

export const AWAITING_REVIEW_STATUSES: readonly InspectionStatus[] = [
  InspectionStatus.SUBMITTED,
  InspectionStatus.UNDER_REVIEW,
];

/** Default landing status for a newly created inspection. */
export function initialStatus(assignedToId: string | null, role: Role): InspectionStatus {
  if (assignedToId === null) return InspectionStatus.DRAFT;
  // An inspector creating work for themselves starts immediately; a planner
  // creating work for someone else schedules it.
  return role === 'INSPECTOR' || role === 'TECHNICIAN'
    ? InspectionStatus.IN_PROGRESS
    : InspectionStatus.SCHEDULED;
}
