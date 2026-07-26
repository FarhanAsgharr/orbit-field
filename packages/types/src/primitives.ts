/**
 * Branded primitive types.
 *
 * Every identifier in Orbit Field is a client-generatable ULID. Offline devices
 * mint their own primary keys so that a record created in an aircraft hangar with
 * no signal has the same identity it will have on the server three days later.
 * Branding stops an OrgId from being passed where an InspectionId is expected.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrgId = Brand<string, 'OrgId'>;
export type UserId = Brand<string, 'UserId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type ClientId = Brand<string, 'ClientId'>;
export type SiteId = Brand<string, 'SiteId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type TemplateId = Brand<string, 'TemplateId'>;
export type TemplateVersionId = Brand<string, 'TemplateVersionId'>;
export type SectionId = Brand<string, 'SectionId'>;
export type FieldId = Brand<string, 'FieldId'>;
export type InspectionId = Brand<string, 'InspectionId'>;
export type ResponseId = Brand<string, 'ResponseId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type SignatureId = Brand<string, 'SignatureId'>;
export type ReportId = Brand<string, 'ReportId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type AuditLogId = Brand<string, 'AuditLogId'>;
export type NotificationId = Brand<string, 'NotificationId'>;
export type SessionId = Brand<string, 'SessionId'>;

/** ISO-8601 timestamp with timezone, e.g. `2026-07-24T11:04:22.481Z`. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

/** Calendar date with no time component, e.g. `2026-07-24`. */
export type IsoDate = Brand<string, 'IsoDate'>;

/**
 * Monotonic server sequence number. Every mutation the server accepts is stamped
 * with the next value from a global-per-org sequence; clients pull deltas by
 * asking for "everything after cursor N". This is deliberately not a timestamp —
 * clock skew across a fleet of field devices makes timestamps unusable as cursors.
 */
export type SyncCursor = Brand<number, 'SyncCursor'>;

/** Unsigned integer version counter used for optimistic concurrency. */
export type RecordVersion = Brand<number, 'RecordVersion'>;

export const asOrgId = (v: string): OrgId => v as OrgId;
export const asUserId = (v: string): UserId => v as UserId;
export const asDeviceId = (v: string): DeviceId => v as DeviceId;
export const asInspectionId = (v: string): InspectionId => v as InspectionId;
export const asTemplateId = (v: string): TemplateId => v as TemplateId;
export const asSyncCursor = (v: number): SyncCursor => v as SyncCursor;
export const asRecordVersion = (v: number): RecordVersion => v as RecordVersion;
export const asIsoTimestamp = (v: string | Date): IsoTimestamp =>
  (typeof v === 'string' ? v : v.toISOString()) as IsoTimestamp;

/** Geographic fix captured alongside field data. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy in metres. Lower is better. */
  accuracy: number | null;
  /** Metres above the WGS-84 ellipsoid. */
  altitude: number | null;
  altitudeAccuracy: number | null;
  /** Degrees clockwise from true north. */
  heading: number | null;
  /** Metres per second. */
  speed: number | null;
  capturedAt: IsoTimestamp;
  /** True when the OS reported the location as coming from a mock provider. */
  mocked: boolean;
}

export interface Money {
  /** Minor units (cents/paise) to avoid float drift. */
  amount: number;
  /** ISO-4217, e.g. `USD`. */
  currency: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export type Nullable<T> = T | null;
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
