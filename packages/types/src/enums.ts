/** Closed enumerations shared by mobile, backend, and admin dashboard. */

export const Role = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  SUPERVISOR: 'SUPERVISOR',
  INSPECTOR: 'INSPECTOR',
  TECHNICIAN: 'TECHNICIAN',
  VIEWER: 'VIEWER',
  /**
   * A customer of the organisation, not a member of it.
   *
   * Everyone above is staff and is scoped by project or by assignment. A CLIENT
   * is scoped by `clientId` instead: they see the work done for their own
   * company and nothing else, which is a different axis entirely and is why
   * this cannot be expressed as a weaker VIEWER.
   */
  CLIENT: 'CLIENT',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/**
 * Roles ordered by authority. Used for "can this user act on that user" checks —
 * a MANAGER may deactivate an INSPECTOR but never an ADMIN.
 */
export const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 70,
  ADMIN: 60,
  MANAGER: 50,
  SUPERVISOR: 40,
  INSPECTOR: 30,
  TECHNICIAN: 20,
  VIEWER: 10,
  // Below every staff role: a client must never outrank anybody, so no
  // `canManageUser` or `canAssignRole` check can ever resolve in their favour.
  CLIENT: 5,
};

export const UserStatus = {
  INVITED: 'INVITED',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DEACTIVATED: 'DEACTIVATED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const InspectionStatus = {
  /** Created locally, never submitted. Editable, excluded from compliance counts. */
  DRAFT: 'DRAFT',
  /** Assigned to an inspector but not yet started. */
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  /** All required fields answered, awaiting supervisor review. */
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  /** Terminal states. */
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type InspectionStatus = (typeof InspectionStatus)[keyof typeof InspectionStatus];

/** Statuses in which an inspector may still mutate responses. */
export const EDITABLE_INSPECTION_STATUSES: readonly InspectionStatus[] = [
  InspectionStatus.DRAFT,
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
  InspectionStatus.REJECTED,
];

export const TERMINAL_INSPECTION_STATUSES: readonly InspectionStatus[] = [
  InspectionStatus.APPROVED,
  InspectionStatus.CANCELLED,
  InspectionStatus.ARCHIVED,
];

/** Overall pass/fail verdict, derived from scored responses. */
export const InspectionOutcome = {
  PASS: 'PASS',
  PASS_WITH_OBSERVATIONS: 'PASS_WITH_OBSERVATIONS',
  FAIL: 'FAIL',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING',
} as const;
export type InspectionOutcome = (typeof InspectionOutcome)[keyof typeof InspectionOutcome];

export const Priority = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** Every question type the checklist builder can render. */
export const FieldType = {
  TEXT: 'TEXT',
  TEXT_AREA: 'TEXT_AREA',
  NUMBER: 'NUMBER',
  CURRENCY: 'CURRENCY',
  CHECKBOX: 'CHECKBOX',
  RADIO: 'RADIO',
  DROPDOWN: 'DROPDOWN',
  MULTI_SELECT: 'MULTI_SELECT',
  DATE: 'DATE',
  TIME: 'TIME',
  DATETIME: 'DATETIME',
  RATING: 'RATING',
  PASS_FAIL: 'PASS_FAIL',
  YES_NO: 'YES_NO',
  SIGNATURE: 'SIGNATURE',
  GPS: 'GPS',
  PHOTO: 'PHOTO',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  FILE: 'FILE',
  BARCODE: 'BARCODE',
  /** Read-only banner/instruction block. Never produces a response value. */
  INSTRUCTION: 'INSTRUCTION',
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

/** Field types whose answer is one or more binary attachments, not a scalar. */
export const MEDIA_FIELD_TYPES: readonly FieldType[] = [
  FieldType.PHOTO,
  FieldType.VIDEO,
  FieldType.AUDIO,
  FieldType.FILE,
  FieldType.SIGNATURE,
];

/** Field types that can carry a pass/fail score and therefore drive the outcome. */
export const SCOREABLE_FIELD_TYPES: readonly FieldType[] = [
  FieldType.CHECKBOX,
  FieldType.RADIO,
  FieldType.DROPDOWN,
  FieldType.PASS_FAIL,
  FieldType.YES_NO,
  FieldType.RATING,
  FieldType.NUMBER,
];

export const AttachmentKind = {
  PHOTO: 'PHOTO',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
  SIGNATURE: 'SIGNATURE',
  REPORT_PDF: 'REPORT_PDF',
} as const;
export type AttachmentKind = (typeof AttachmentKind)[keyof typeof AttachmentKind];

/** Lifecycle of a binary blob as it moves from device to object storage. */
export const AttachmentState = {
  /** Written to device storage, not yet queued. */
  LOCAL_ONLY: 'LOCAL_ONLY',
  QUEUED: 'QUEUED',
  UPLOADING: 'UPLOADING',
  /** All chunks received, server assembling/verifying checksum. */
  FINALIZING: 'FINALIZING',
  UPLOADED: 'UPLOADED',
  FAILED: 'FAILED',
  /** Server copy confirmed; local original may be evicted under storage pressure. */
  EVICTABLE: 'EVICTABLE',
} as const;
export type AttachmentState = (typeof AttachmentState)[keyof typeof AttachmentState];

export const SignatureRole = {
  INSPECTOR: 'INSPECTOR',
  CUSTOMER: 'CUSTOMER',
  SUPERVISOR: 'SUPERVISOR',
  WITNESS: 'WITNESS',
} as const;
export type SignatureRole = (typeof SignatureRole)[keyof typeof SignatureRole];

/** Entity families that participate in delta sync. */
export const SyncEntity = {
  ORGANIZATION: 'ORGANIZATION',
  USER: 'USER',
  PROJECT: 'PROJECT',
  CLIENT: 'CLIENT',
  SITE: 'SITE',
  ASSET: 'ASSET',
  TEMPLATE_VERSION: 'TEMPLATE_VERSION',
  INSPECTION: 'INSPECTION',
  RESPONSE: 'RESPONSE',
  ATTACHMENT: 'ATTACHMENT',
  SIGNATURE: 'SIGNATURE',
  NOTIFICATION: 'NOTIFICATION',
} as const;
export type SyncEntity = (typeof SyncEntity)[keyof typeof SyncEntity];

export const SyncOperation = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
} as const;
export type SyncOperation = (typeof SyncOperation)[keyof typeof SyncOperation];

/** State machine for a single queued mutation on the device. */
export const OutboxState = {
  PENDING: 'PENDING',
  /** Handed to the sync engine, awaiting server response. */
  IN_FLIGHT: 'IN_FLIGHT',
  /** Server rejected with a retryable error; waiting for backoff to elapse. */
  RETRYING: 'RETRYING',
  /** Server detected a concurrent edit. Blocked until a human resolves it. */
  CONFLICTED: 'CONFLICTED',
  /** Permanently rejected (validation, permission). Requires user action. */
  DEAD_LETTER: 'DEAD_LETTER',
  APPLIED: 'APPLIED',
} as const;
export type OutboxState = (typeof OutboxState)[keyof typeof OutboxState];

export const ConflictResolution = {
  KEEP_LOCAL: 'KEEP_LOCAL',
  KEEP_SERVER: 'KEEP_SERVER',
  MERGE: 'MERGE',
} as const;
export type ConflictResolution = (typeof ConflictResolution)[keyof typeof ConflictResolution];

export const NotificationChannel = {
  PUSH: 'PUSH',
  LOCAL: 'LOCAL',
  EMAIL: 'EMAIL',
  IN_APP: 'IN_APP',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationTopic = {
  INSPECTION_ASSIGNED: 'INSPECTION_ASSIGNED',
  INSPECTION_DUE: 'INSPECTION_DUE',
  INSPECTION_OVERDUE: 'INSPECTION_OVERDUE',
  INSPECTION_APPROVED: 'INSPECTION_APPROVED',
  INSPECTION_REJECTED: 'INSPECTION_REJECTED',
  SYNC_COMPLETED: 'SYNC_COMPLETED',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  REPORT_READY: 'REPORT_READY',
} as const;
export type NotificationTopic = (typeof NotificationTopic)[keyof typeof NotificationTopic];

export const OtpPurpose = {
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  DEVICE_ENROLMENT: 'DEVICE_ENROLMENT',
  STEP_UP_AUTH: 'STEP_UP_AUTH',
} as const;
export type OtpPurpose = (typeof OtpPurpose)[keyof typeof OtpPurpose];

export const AuditAction = {
  AUTH_LOGIN: 'AUTH_LOGIN',
  AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_TOKEN_REFRESH: 'AUTH_TOKEN_REFRESH',
  AUTH_TOKEN_REUSE_DETECTED: 'AUTH_TOKEN_REUSE_DETECTED',
  AUTH_PASSWORD_CHANGED: 'AUTH_PASSWORD_CHANGED',
  AUTH_PASSWORD_RESET: 'AUTH_PASSWORD_RESET',
  DEVICE_ENROLLED: 'DEVICE_ENROLLED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  RECORD_CREATED: 'RECORD_CREATED',
  RECORD_UPDATED: 'RECORD_UPDATED',
  RECORD_DELETED: 'RECORD_DELETED',
  INSPECTION_SUBMITTED: 'INSPECTION_SUBMITTED',
  INSPECTION_APPROVED: 'INSPECTION_APPROVED',
  INSPECTION_REJECTED: 'INSPECTION_REJECTED',
  CONFLICT_RESOLVED: 'CONFLICT_RESOLVED',
  REPORT_GENERATED: 'REPORT_GENERATED',
  REPORT_EXPORTED: 'REPORT_EXPORTED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
