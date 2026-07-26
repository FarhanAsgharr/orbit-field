/** HTTP request/response contracts shared by clients and server. */

import type { Organization, User } from './domain.js';
import type {
  AttachmentKind,
  InspectionOutcome,
  InspectionStatus,
  NotificationTopic,
  OtpPurpose,
  Priority,
  Role,
} from './enums.js';
import type {
  ClientId,
  DeviceId,
  GeoPoint,
  InspectionId,
  IsoTimestamp,
  ProjectId,
  SiteId,
  TemplateId,
  UserId,
} from './primitives.js';

/** Uniform error body. Every non-2xx response has exactly this shape. */
export interface ApiError {
  error: {
    /** Stable machine code, e.g. `AUTH_INVALID_CREDENTIALS`. */
    code: string;
    message: string;
    /** Field-level detail for 422 responses. */
    fields?: Record<string, string>;
    /** Correlation id, also emitted in server logs. */
    requestId: string;
    /** Seconds to wait, present on 429 and 503. */
    retryAfter?: number;
  };
}

export interface ApiSuccess<T> {
  data: T;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  installationId: string;
  name: string;
  platform: 'ios' | 'android' | 'web';
  osVersion: string;
  appVersion: string;
  model?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  device: DeviceInfo;
  /** Issues a long-lived refresh token bound to this device. */
  rememberMe?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AuthSession {
  tokens: AuthTokens;
  user: User;
  organization: Organization;
  device: { id: DeviceId; enrolled: boolean };
  /** Effective permission set after role + extras - revocations. */
  permissions: string[];
}

export interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  /** Joining an existing org by invite, or creating a new one. */
  inviteToken?: string;
  organizationName?: string;
  device: DeviceInfo;
}

export interface RefreshRequest {
  refreshToken: string;
  deviceId: DeviceId;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface VerifyOtpRequest {
  email: string;
  code: string;
  purpose: OtpPurpose;
}

export interface VerifyOtpResponse {
  /** Short-lived single-use token proving the OTP was satisfied. */
  actionToken: string;
  expiresIn: number;
}

export interface ResetPasswordRequest {
  actionToken: string;
  newPassword: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface BiometricEnrolRequest {
  deviceId: DeviceId;
  /** Base64 SPKI public key; the private half never leaves the secure enclave. */
  publicKey: string;
}

export interface BiometricLoginRequest {
  deviceId: DeviceId;
  /** Server-issued nonce, signed by the enclave key. */
  challenge: string;
  signature: string;
  device: DeviceInfo;
}

export interface BiometricChallengeResponse {
  challenge: string;
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

export interface CreateInspectionRequest {
  /** Device-minted ULID so the record has identity before it reaches the server. */
  id?: InspectionId;
  templateId: TemplateId;
  title?: string;
  projectId?: ProjectId | null;
  clientId?: ClientId | null;
  siteId?: SiteId | null;
  assetId?: string | null;
  priority?: Priority;
  category?: string | null;
  department?: string | null;
  assignedToId?: UserId | null;
  scheduledFor?: IsoTimestamp | null;
  dueAt?: IsoTimestamp | null;
  notes?: string | null;
  tags?: string[];
  startLocation?: GeoPoint | null;
}

export type UpdateInspectionRequest = Partial<
  Omit<CreateInspectionRequest, 'id' | 'templateId'>
> & { status?: InspectionStatus };

export interface SubmitInspectionRequest {
  endLocation?: GeoPoint | null;
  notes?: string | null;
  /** Bypasses non-critical warnings; requires `inspection:override` permission. */
  acknowledgeWarnings?: boolean;
}

export interface ReviewInspectionRequest {
  decision: 'APPROVE' | 'REJECT';
  reason?: string;
}

export interface InspectionQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: InspectionStatus[];
  outcome?: InspectionOutcome[];
  priority?: Priority[];
  templateId?: TemplateId[];
  projectId?: ProjectId[];
  clientId?: ClientId[];
  siteId?: SiteId[];
  assignedToId?: UserId[];
  tags?: string[];
  createdFrom?: IsoTimestamp;
  createdTo?: IsoTimestamp;
  dueFrom?: IsoTimestamp;
  dueTo?: IsoTimestamp;
  /** Bounding-box geo filter. */
  bbox?: [number, number, number, number];
  includeArchived?: boolean;
  sortBy?: 'createdAt' | 'updatedAt' | 'dueAt' | 'priority' | 'number' | 'score';
  sortDir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Responses & attachments
// ---------------------------------------------------------------------------

export interface UpsertResponseRequest {
  fieldId: string;
  sectionId: string;
  repeatIndex?: number;
  value: unknown;
  comment?: string | null;
  location?: GeoPoint | null;
}

export interface CreateUploadRequest {
  attachmentId: string;
  inspectionId?: InspectionId | null;
  responseId?: string | null;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 hex. Enables server-side dedupe and integrity verification. */
  checksum: string;
  capturedAt?: IsoTimestamp | null;
  location?: GeoPoint | null;
  caption?: string | null;
  pairTag?: string | null;
}

// ---------------------------------------------------------------------------
// Reports & analytics
// ---------------------------------------------------------------------------

export interface GenerateReportRequest {
  inspectionId: InspectionId;
  /** Named layout registered for the org. */
  layout?: string;
  includePhotos?: boolean;
  includeMap?: boolean;
  includeSignatures?: boolean;
  includeFailuresOnly?: boolean;
  locale?: string;
}

export type ReportPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export interface AnalyticsQuery {
  from: IsoTimestamp;
  to: IsoTimestamp;
  period?: ReportPeriod;
  projectId?: ProjectId[];
  siteId?: SiteId[];
  templateId?: TemplateId[];
  inspectorId?: UserId[];
  timezone?: string;
}

export interface TimeSeriesPoint {
  bucket: IsoTimestamp;
  total: number;
  completed: number;
  failed: number;
  passed: number;
}

export interface DashboardSummary {
  assigned: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  overdue: number;
  dueToday: number;
  completionRate: number;
  failureRate: number;
  averageScore: number | null;
  averageDurationMinutes: number | null;
  trend: TimeSeriesPoint[];
}

export interface InspectorPerformance {
  userId: UserId;
  name: string;
  assigned: number;
  completed: number;
  failed: number;
  completionRate: number;
  averageScore: number | null;
  averageDurationMinutes: number | null;
  onTimeRate: number;
}

export interface SitePerformance {
  siteId: SiteId;
  name: string;
  total: number;
  failed: number;
  failureRate: number;
  averageScore: number | null;
  lastInspectedAt: IsoTimestamp | null;
}

export interface HeatMapCell {
  latitude: number;
  longitude: number;
  weight: number;
  failures: number;
}

// ---------------------------------------------------------------------------
// Admin & notifications
// ---------------------------------------------------------------------------

export interface InviteUserRequest {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  department?: string | null;
  jobTitle?: string | null;
  projectIds?: ProjectId[];
}

export interface UpdateUserRequest {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  role?: Role;
  department?: string | null;
  jobTitle?: string | null;
  registrationNumber?: string | null;
  projectIds?: ProjectId[];
  extraPermissions?: string[];
  revokedPermissions?: string[];
  status?: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
}

export interface NotificationPayload {
  topic: NotificationTopic;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Deep link, e.g. `orbit://inspections/01J...`. */
  deepLink?: string;
}
