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

import { ROLE_RANK, type Role } from '@orbit/types';

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

/** SUPER_ADMIN is defined as "everything" so new permissions are never missed. */
const SUPER_ADMIN: Permission[] = [...ALL_PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN,
  ADMIN,
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
 */
export function canManageUser(actor: AccessSubject, target: { role: Role; orgId: string; userId: string }): boolean {
  if (actor.orgId !== target.orgId && actor.role !== 'SUPER_ADMIN') return false;
  if (actor.userId === target.userId) return false;
  if (!can(actor, Permission.USER_UPDATE)) return false;
  return ROLE_RANK[actor.role] > ROLE_RANK[target.role];
}

/** A user may only assign roles strictly below their own. */
export function canAssignRole(actor: AccessSubject, role: Role): boolean {
  if (!can(actor, Permission.USER_ROLE_ASSIGN)) return false;
  return ROLE_RANK[actor.role] > ROLE_RANK[role];
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
  inspection: { orgId: string; assignedToId: string | null; projectId: string | null; createdById?: string | null },
): boolean {
  if (subject.orgId !== inspection.orgId) return false;
  if (!canAccessProject(subject, inspection.projectId)) return false;
  if (can(subject, Permission.INSPECTION_READ_ALL)) return true;
  return (
    inspection.assignedToId === subject.userId ||
    inspection.createdById === subject.userId
  );
}

export function canEditInspection(
  subject: AccessSubject,
  inspection: { orgId: string; assignedToId: string | null; projectId: string | null; createdById?: string | null },
): boolean {
  if (!canAccessInspection(subject, inspection)) return false;
  if (can(subject, Permission.INSPECTION_UPDATE_ANY)) return true;
  if (!can(subject, Permission.INSPECTION_UPDATE)) return false;
  return (
    inspection.assignedToId === subject.userId ||
    inspection.createdById === subject.userId
  );
}
