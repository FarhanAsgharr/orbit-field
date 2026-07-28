/**
 * Role-based access control.
 *
 * One permission catalogue, one matrix, used by three consumers: the API
 * middleware (authoritative), the mobile app (to hide unusable controls), and
 * the admin dashboard (to render the role editor). Keeping them in one file is
 * what stops the classic drift where the UI offers a button the API rejects.
 *
 * Evaluation order is deliberate: an explicit revocation always beats an
 * explicit grant, which always beats the role baseline. That makes "this
 * contractor may do everything an inspector does except delete" expressible
 * without inventing a new role.
 */

import { type Role, ROLE_RANK } from '@orbit/types';

/** Every permission the system recognises. `resource:action`. */
export const Permission = {
  // Organisation
  ORG_READ: 'org:read',
  ORG_UPDATE: 'org:update',
  ORG_SETTINGS_UPDATE: 'org:settings:update',
  ORG_BILLING: 'org:billing',

  // Users & access
  USER_READ: 'user:read',
  USER_INVITE: 'user:invite',
  USER_UPDATE: 'user:update',
  USER_DEACTIVATE: 'user:deactivate',
  USER_ROLE_ASSIGN: 'user:role:assign',
  USER_IMPERSONATE: 'user:impersonate',
  DEVICE_READ: 'device:read',
  DEVICE_REVOKE: 'device:revoke',

  // Reference data
  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  PROJECT_DELETE: 'project:delete',
  CLIENT_READ: 'client:read',
  CLIENT_WRITE: 'client:write',
  CLIENT_DELETE: 'client:delete',
  SITE_READ: 'site:read',
  SITE_WRITE: 'site:write',
  SITE_DELETE: 'site:delete',
  ASSET_READ: 'asset:read',
  ASSET_WRITE: 'asset:write',

  // Templates
  TEMPLATE_READ: 'template:read',
  TEMPLATE_WRITE: 'template:write',
  TEMPLATE_PUBLISH: 'template:publish',
  TEMPLATE_DELETE: 'template:delete',

  // Inspections
  INSPECTION_READ: 'inspection:read',
  /** Read inspections belonging to other users. Without it, own-records only. */
  INSPECTION_READ_ALL: 'inspection:read:all',
  INSPECTION_CREATE: 'inspection:create',
  INSPECTION_UPDATE: 'inspection:update',
  /** Edit an inspection assigned to someone else. */
  INSPECTION_UPDATE_ANY: 'inspection:update:any',
  INSPECTION_DELETE: 'inspection:delete',
  INSPECTION_ASSIGN: 'inspection:assign',
  INSPECTION_SUBMIT: 'inspection:submit',
  INSPECTION_REVIEW: 'inspection:review',
  INSPECTION_REOPEN: 'inspection:reopen',
  INSPECTION_ARCHIVE: 'inspection:archive',
  /** Submit despite non-critical validation warnings. */
  INSPECTION_OVERRIDE: 'inspection:override',
  INSPECTION_EXPORT: 'inspection:export',

  // Reports & analytics
  REPORT_GENERATE: 'report:generate',
  REPORT_READ: 'report:read',
  REPORT_EXPORT: 'report:export',
  ANALYTICS_READ: 'analytics:read',
  ANALYTICS_READ_ALL: 'analytics:read:all',

  // Sync & operations
  SYNC_PUSH: 'sync:push',
  SYNC_PULL: 'sync:pull',
  CONFLICT_RESOLVE: 'conflict:resolve',

  // Audit & system
  AUDIT_READ: 'audit:read',
  SYSTEM_SETTINGS: 'system:settings',
  SYSTEM_HEALTH: 'system:health',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

const VIEWER: Permission[] = [
  Permission.ORG_READ,
  Permission.PROJECT_READ,
  Permission.CLIENT_READ,
  Permission.SITE_READ,
  Permission.ASSET_READ,
  Permission.TEMPLATE_READ,
  Permission.INSPECTION_READ,
  Permission.REPORT_READ,
  Permission.SYNC_PULL,
];

/**
 * Technicians assist on inspections but do not own them: they can record
 * answers and capture media, and cannot submit for approval or create work.
 */
const TECHNICIAN: Permission[] = [
  ...VIEWER,
  Permission.INSPECTION_UPDATE,
  Permission.SYNC_PUSH,
  Permission.CONFLICT_RESOLVE,
];

const INSPECTOR: Permission[] = [
  ...TECHNICIAN,
  Permission.INSPECTION_CREATE,
  Permission.INSPECTION_SUBMIT,
  Permission.INSPECTION_EXPORT,
  Permission.REPORT_GENERATE,
  Permission.ASSET_WRITE,
];

const SUPERVISOR: Permission[] = [
  ...INSPECTOR,
  Permission.INSPECTION_READ_ALL,
  Permission.INSPECTION_UPDATE_ANY,
  Permission.INSPECTION_ASSIGN,
  Permission.INSPECTION_REVIEW,
  Permission.INSPECTION_REOPEN,
  Permission.INSPECTION_OVERRIDE,
  Permission.ANALYTICS_READ,
  Permission.REPORT_EXPORT,
  Permission.USER_READ,
  Permission.DEVICE_READ,
];

const MANAGER: Permission[] = [
  ...SUPERVISOR,
  Permission.PROJECT_WRITE,
  Permission.CLIENT_WRITE,
  Permission.SITE_WRITE,
  Permission.TEMPLATE_WRITE,
  Permission.TEMPLATE_PUBLISH,
  Permission.INSPECTION_ARCHIVE,
  Permission.INSPECTION_DELETE,
  Permission.ANALYTICS_READ_ALL,
  Permission.USER_INVITE,
  Permission.USER_UPDATE,
];

const ADMIN: Permission[] = [
  ...MANAGER,
  Permission.ORG_UPDATE,
  Permission.ORG_SETTINGS_UPDATE,
  Permission.USER_DEACTIVATE,
  Permission.USER_ROLE_ASSIGN,
  Permission.DEVICE_REVOKE,
  Permission.PROJECT_DELETE,
  Permission.CLIENT_DELETE,
  Permission.SITE_DELETE,
  Permission.TEMPLATE_DELETE,
  Permission.AUDIT_READ,
  Permission.SYSTEM_HEALTH,
];

/**
 * A customer, not a member of staff.
 *
 * Deliberately tiny, and deliberately not a subset of VIEWER: a client reads
 * inspections *for their own company* and generates reports from them, and can
 * see nothing else in the installation. The scoping that makes that safe is
 * `clientId` on the subject, applied in every query — the permissions here only
 * decide which endpoints they may reach at all.
 *
 * There is no INSPECTION_READ_ALL, no ANALYTICS_READ, no USER_READ and no
 * AUDIT_READ, so the analytics, people and audit endpoints refuse them outright
 * rather than relying on a filter being remembered.
 */
const CLIENT: Permission[] = [
  Permission.INSPECTION_READ,
  Permission.REPORT_READ,
  Permission.REPORT_GENERATE,
  Permission.SITE_READ,
  Permission.ASSET_READ,
];

/** SUPER_ADMIN is defined as "everything" so new permissions are never missed. */
const SUPER_ADMIN: Permission[] = [...ALL_PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN,
  ADMIN,
  CLIENT,
  MANAGER,
  SUPERVISOR,
  INSPECTOR,
  TECHNICIAN,
  VIEWER,
};

/** The identity an authorisation decision is made about. */
export interface AccessSubject {
  userId: string;
  orgId: string;
  role: Role;
  extraPermissions?: string[];
  revokedPermissions?: string[];
  /** Empty means org-wide within the role's reach. */
  projectIds?: string[];
  /**
   * The customer this user belongs to, when they are one.
   *
   * Set only for CLIENT users. Every query that can reach inspection data
   * narrows on it, so a client sees their own company's work and no other
   * customer's — a second isolation boundary inside the organisation, below the
   * tenant boundary.
   */
  clientId?: string | null;
}

/** Resolve the effective permission set: role ∪ extras − revocations. */
export function effectivePermissions(subject: AccessSubject): Set<string> {
  const set = new Set<string>(ROLE_PERMISSIONS[subject.role] ?? []);
  for (const p of subject.extraPermissions ?? []) set.add(p);
  for (const p of subject.revokedPermissions ?? []) set.delete(p);
  return set;
}

export function can(subject: AccessSubject, permission: Permission | string): boolean {
  return effectivePermissions(subject).has(permission);
}

export function canAll(subject: AccessSubject, permissions: Array<Permission | string>): boolean {
  const set = effectivePermissions(subject);
  return permissions.every((p) => set.has(p));
}

export function canAny(subject: AccessSubject, permissions: Array<Permission | string>): boolean {
  const set = effectivePermissions(subject);
  return permissions.some((p) => set.has(p));
}

/**
 * Whether `actor` may administer `target`. Equal-rank users cannot act on each
 * other, which prevents two admins from locking one another out, and nobody
 * except a SUPER_ADMIN can touch a SUPER_ADMIN.
 *
 * **No role crosses an organisation.** This used to exempt SUPER_ADMIN from the
 * tenant check, which was survivable while signup ran exactly once and there
 * was only ever one organisation for a SUPER_ADMIN to be owner of. Orbit Field
 * is now a multi-company product where anybody can register their own company
 * and becomes its SUPER_ADMIN — so that exemption would hand every new
 * registrant authority over every other company in the deployment.
 *
 * The routes already look their targets up scoped by `orgId`, so this was
 * defence in depth rather than a live hole. It is the layer that has to be
 * right anyway: the day a call site forgets that `where`, this is what stands
 * between one company and all the others.
 */
export function canManageUser(
  actor: AccessSubject,
  target: { role: Role; orgId: string; userId: string },
): boolean {
  if (actor.orgId !== target.orgId) return false;
  if (actor.userId === target.userId) return false;
  if (!can(actor, Permission.USER_UPDATE)) return false;
  return ROLE_RANK[actor.role] > ROLE_RANK[target.role];
}

/** A user may only assign roles strictly below their own. */
export function canAssignRole(actor: AccessSubject, role: Role): boolean {
  if (!can(actor, Permission.USER_ROLE_ASSIGN)) return false;
  return ROLE_RANK[actor.role] > ROLE_RANK[role];
}

/**
 * Whether a record belonging to a customer is visible to this subject.
 *
 * Staff are unaffected — they have no `clientId` and see whatever their role
 * and project scope allow. A client sees only their own company's records, and
 * a record with no customer at all is invisible to them: internal work is not
 * theirs to read.
 */
export function canAccessClientRecord(
  subject: AccessSubject,
  record: { clientId: string | null },
): boolean {
  if (!subject.clientId) return true;
  return record.clientId !== null && record.clientId === subject.clientId;
}

/** True when this subject is a customer rather than a member of staff. */
export function isClientUser(subject: AccessSubject): boolean {
  return subject.role === 'CLIENT' || Boolean(subject.clientId);
}

/** Scope check for project-restricted users. */
export function canAccessProject(subject: AccessSubject, projectId: string | null): boolean {
  const scoped = subject.projectIds ?? [];
  if (scoped.length === 0) return true; // org-wide
  if (projectId === null) return false; // unscoped record, scoped user
  return scoped.includes(projectId);
}

/** Record-level check for an inspection, combining ownership and project scope. */
export function canAccessInspection(
  subject: AccessSubject,
  inspection: {
    orgId: string;
    assignedToId: string | null;
    projectId: string | null;
    createdById?: string | null;
    /** Whose work it is. Required for a client subject; ignored for staff. */
    clientId?: string | null;
  },
): boolean {
  if (subject.orgId !== inspection.orgId) return false;

  /*
   * A customer is scoped by whose work it is.
   *
   * Returns early rather than falling through to the staff rules: a client is
   * neither the assignee nor the creator, so the checks below would refuse
   * them their own inspection, and `clientId === undefined` on a record must
   * refuse rather than pass — a caller that forgot to select the column would
   * otherwise hand over the organisation.
   */
  if (subject.clientId) {
    return inspection.clientId != null && inspection.clientId === subject.clientId;
  }

  if (!canAccessProject(subject, inspection.projectId)) return false;
  if (can(subject, Permission.INSPECTION_READ_ALL)) return true;
  return inspection.assignedToId === subject.userId || inspection.createdById === subject.userId;
}

export function canEditInspection(
  subject: AccessSubject,
  inspection: {
    orgId: string;
    assignedToId: string | null;
    projectId: string | null;
    createdById?: string | null;
  },
): boolean {
  if (!canAccessInspection(subject, inspection)) return false;
  if (can(subject, Permission.INSPECTION_UPDATE_ANY)) return true;
  if (!can(subject, Permission.INSPECTION_UPDATE)) return false;
  return inspection.assignedToId === subject.userId || inspection.createdById === subject.userId;
}
