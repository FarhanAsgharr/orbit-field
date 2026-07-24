/** Core operational entities. */

import type {
  AttachmentKind,
  AttachmentState,
  InspectionOutcome,
  InspectionStatus,
  Priority,
  Role,
  SignatureRole,
  UserStatus,
} from './enums.js';
import type {
  AssetId,
  AttachmentId,
  ClientId,
  DeviceId,
  FieldId,
  GeoPoint,
  InspectionId,
  IsoTimestamp,
  JsonValue,
  OrgId,
  ProjectId,
  RecordVersion,
  ResponseId,
  SectionId,
  SignatureId,
  SiteId,
  SyncCursor,
  TemplateId,
  TemplateVersionId,
  UserId,
} from './primitives.js';

/**
 * Fields every syncable record carries. `version` and `syncCursor` drive
 * optimistic concurrency and delta pulls respectively; `deletedAt` implements
 * soft deletion, because a hard delete cannot be replicated to a device that is
 * offline at the moment it happens.
 */
export interface SyncableRecord {
  version: RecordVersion;
  syncCursor: SyncCursor;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
  /** Device that authored the most recent change. Null for server-side edits. */
  lastWriterDeviceId: DeviceId | null;
  lastWriterUserId: UserId | null;
}

export interface Organization extends SyncableRecord {
  id: OrgId;
  name: string;
  slug: string;
  logoUrl: string | null;
  timezone: string;
  locale: string;
  currency: string;
  settings: OrganizationSettings;
}

export interface OrganizationSettings {
  /** Reject inspections submitted without a GPS fix. */
  requireGpsOnSubmit: boolean;
  /** Maximum acceptable horizontal accuracy, metres. */
  gpsAccuracyThresholdMeters: number;
  /** Refuse fixes flagged as coming from a mock location provider. */
  rejectMockedLocations: boolean;
  /** Inactivity timeout before the app re-prompts for auth, minutes. */
  sessionIdleTimeoutMinutes: number;
  /** Devices must be explicitly enrolled before they can sync. */
  deviceBindingEnabled: boolean;
  maxDevicesPerUser: number;
  /** Days a completed inspection's media stays on-device before eviction. */
  localMediaRetentionDays: number;
  /** Only sync media over unmetered connections by default. */
  wifiOnlyMediaSync: boolean;
  photoCompressionQuality: number;
  /** Burn GPS + timestamp into every captured photo. */
  photoWatermarkEnabled: boolean;
  passwordPolicy: PasswordPolicy;
  brandColor: string | null;
  reportFooterText: string | null;
}

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  /** Reject reuse of the last N passwords. */
  historyDepth: number;
  /** Force rotation after N days. 0 disables expiry. */
  maxAgeDays: number;
}

export interface User extends SyncableRecord {
  id: UserId;
  orgId: OrgId;
  email: string;
  emailVerifiedAt: IsoTimestamp | null;
  phone: string | null;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  role: Role;
  /** Grants beyond the role's baseline, e.g. a SUPERVISOR given `report:export`. */
  extraPermissions: string[];
  /** Explicit denials that override both role and extras. */
  revokedPermissions: string[];
  status: UserStatus;
  department: string | null;
  jobTitle: string | null;
  /** Employee/licence number printed on reports. */
  registrationNumber: string | null;
  /** Projects this user is scoped to. Empty means org-wide for their role. */
  projectIds: ProjectId[];
  lastLoginAt: IsoTimestamp | null;
  timezone: string | null;
  locale: string | null;
}

export interface Device extends SyncableRecord {
  id: DeviceId;
  orgId: OrgId;
  userId: UserId;
  /** Stable hardware/install identifier reported by the app. */
  installationId: string;
  name: string;
  platform: 'ios' | 'android' | 'web';
  osVersion: string;
  appVersion: string;
  model: string | null;
  pushToken: string | null;
  biometricEnrolled: boolean;
  /** Cursor this device has successfully pulled up to. */
  lastSyncCursor: SyncCursor;
  lastSeenAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
  revokedReason: string | null;
}

export interface Client extends SyncableRecord {
  id: ClientId;
  orgId: OrgId;
  name: string;
  code: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  logoUrl: string | null;
  isActive: boolean;
}

export interface Project extends SyncableRecord {
  id: ProjectId;
  orgId: OrgId;
  clientId: ClientId | null;
  name: string;
  code: string;
  description: string | null;
  startDate: IsoTimestamp | null;
  endDate: IsoTimestamp | null;
  managerId: UserId | null;
  isActive: boolean;
}

export interface Site extends SyncableRecord {
  id: SiteId;
  orgId: OrgId;
  projectId: ProjectId | null;
  clientId: ClientId | null;
  name: string;
  code: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Radius in metres inside which an inspection is considered on-site. */
  geofenceRadiusMeters: number | null;
  timezone: string | null;
  contactName: string | null;
  contactPhone: string | null;
  isActive: boolean;
}

/** A physical thing under inspection: a transformer, a panel, a fire door. */
export interface Asset extends SyncableRecord {
  id: AssetId;
  orgId: OrgId;
  siteId: SiteId | null;
  parentAssetId: AssetId | null;
  name: string;
  /** Serial/tag number, matched by the barcode scanner. */
  tag: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  installedAt: IsoTimestamp | null;
  latitude: number | null;
  longitude: number | null;
  metadata: Record<string, JsonValue>;
  isActive: boolean;
}

export interface Inspection extends SyncableRecord {
  id: InspectionId;
  orgId: OrgId;
  /** Human-facing sequential reference, e.g. `INS-2026-004182`. */
  number: string;
  templateId: TemplateId;
  /** Pinned at creation; never changes for the life of the inspection. */
  templateVersionId: TemplateVersionId;
  projectId: ProjectId | null;
  clientId: ClientId | null;
  siteId: SiteId | null;
  assetId: AssetId | null;
  title: string;
  status: InspectionStatus;
  outcome: InspectionOutcome;
  priority: Priority;
  category: string | null;
  department: string | null;
  assignedToId: UserId | null;
  /** Set when work actually begins on the device. */
  startedAt: IsoTimestamp | null;
  scheduledFor: IsoTimestamp | null;
  dueAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  submittedAt: IsoTimestamp | null;
  reviewedById: UserId | null;
  reviewedAt: IsoTimestamp | null;
  rejectionReason: string | null;
  /** Fix captured when the inspection was started. */
  startLocation: GeoPoint | null;
  /** Fix captured at submission — proves the inspector was on site. */
  endLocation: GeoPoint | null;
  /** Distance from the site's registered coordinates at submission, metres. */
  distanceFromSiteMeters: number | null;
  notes: string | null;
  tags: string[];
  /** Weighted percentage 0..100, null until scoring runs. */
  score: number | null;
  totalFields: number;
  answeredFields: number;
  failedFields: number;
  criticalFailures: number;
  /** True once the record has been archived out of active lists. */
  isArchived: boolean;
  /** Source inspection when this was created via duplicate. */
  duplicatedFromId: InspectionId | null;
}

/** One answer to one field, optionally within one repeat instance of a section. */
export interface InspectionResponse extends SyncableRecord {
  id: ResponseId;
  orgId: OrgId;
  inspectionId: InspectionId;
  sectionId: SectionId;
  fieldId: FieldId;
  /** Repeat index for repeatable sections; 0 for non-repeating. */
  repeatIndex: number;
  /**
   * The answer. Shape depends on field type: scalar for TEXT/NUMBER, string for
   * single-choice (option value), string[] for MULTI_SELECT, GeoPoint for GPS,
   * null for media fields (whose payload lives in Attachment rows).
   */
  value: JsonValue;
  /** Free-text observation attached to this specific answer. */
  comment: string | null;
  /** Score contributed by this answer, post-weighting. Null when unscored. */
  score: number | null;
  isFailure: boolean;
  isNotApplicable: boolean;
  /** Where the inspector stood when answering, if the template demanded it. */
  location: GeoPoint | null;
  answeredAt: IsoTimestamp | null;
  answeredById: UserId | null;
}

export interface Attachment extends SyncableRecord {
  id: AttachmentId;
  orgId: OrgId;
  inspectionId: InspectionId | null;
  responseId: ResponseId | null;
  kind: AttachmentKind;
  state: AttachmentState;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 of the original bytes; the server rejects mismatched uploads. */
  checksum: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Absolute path on the device. Null once evicted. */
  localUri: string | null;
  /** Object-storage key. Null until the upload finalizes. */
  storageKey: string | null;
  thumbnailStorageKey: string | null;
  location: GeoPoint | null;
  capturedAt: IsoTimestamp | null;
  caption: string | null;
  /** `BEFORE` / `AFTER` pairing tag for comparison photos. */
  pairTag: string | null;
  /** Vector annotation overlay, stored separately so the original is preserved. */
  annotations: JsonValue | null;
  uploadedAt: IsoTimestamp | null;
  uploadAttempts: number;
  lastUploadError: string | null;
}

export interface Signature extends SyncableRecord {
  id: SignatureId;
  orgId: OrgId;
  inspectionId: InspectionId;
  role: SignatureRole;
  /** Printed name of the signatory. */
  signerName: string;
  signerTitle: string | null;
  signerEmail: string | null;
  /** Attachment holding the rendered PNG. */
  attachmentId: AttachmentId | null;
  /** Raw stroke data, retained for forensic verification. */
  strokes: JsonValue | null;
  signedAt: IsoTimestamp;
  location: GeoPoint | null;
  /** Statement the signatory agreed to. */
  declaration: string | null;
}

/** Denormalised list-row projection — what the inspections list actually renders. */
export interface InspectionListItem {
  id: InspectionId;
  number: string;
  title: string;
  status: InspectionStatus;
  outcome: InspectionOutcome;
  priority: Priority;
  templateName: string;
  siteName: string | null;
  clientName: string | null;
  assigneeName: string | null;
  dueAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
  score: number | null;
  answeredFields: number;
  totalFields: number;
  attachmentCount: number;
  /** Device-only: this row has unsynced local changes. */
  hasPendingChanges?: boolean;
  /** Device-only: this row is blocked on conflict resolution. */
  hasConflict?: boolean;
}
