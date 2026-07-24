-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SUPERVISOR', 'INSPECTOR', 'TECHNICIAN', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InspectionOutcome" AS ENUM ('PASS', 'PASS_WITH_OBSERVATIONS', 'FAIL', 'NOT_APPLICABLE', 'PENDING');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'TEXT_AREA', 'NUMBER', 'CURRENCY', 'CHECKBOX', 'RADIO', 'DROPDOWN', 'MULTI_SELECT', 'DATE', 'TIME', 'DATETIME', 'RATING', 'PASS_FAIL', 'YES_NO', 'SIGNATURE', 'GPS', 'PHOTO', 'VIDEO', 'AUDIO', 'FILE', 'BARCODE', 'INSTRUCTION');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT', 'SIGNATURE', 'REPORT_PDF');

-- CreateEnum
CREATE TYPE "AttachmentState" AS ENUM ('LOCAL_ONLY', 'QUEUED', 'UPLOADING', 'FINALIZING', 'UPLOADED', 'FAILED', 'EVICTABLE');

-- CreateEnum
CREATE TYPE "SignatureRole" AS ENUM ('INSPECTOR', 'CUSTOMER', 'SUPERVISOR', 'WITNESS');

-- CreateEnum
CREATE TYPE "SyncEntity" AS ENUM ('ORGANIZATION', 'USER', 'PROJECT', 'CLIENT', 'SITE', 'ASSET', 'TEMPLATE_VERSION', 'INSPECTION', 'RESPONSE', 'ATTACHMENT', 'SIGNATURE', 'NOTIFICATION');

-- CreateEnum
CREATE TYPE "SyncOperationType" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'DEVICE_ENROLMENT', 'STEP_UP_AUTH');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'LOCAL', 'EMAIL', 'IN_APP');

-- CreateTable
CREATE TABLE "organizations" (
    "id" VARCHAR(26) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "logoUrl" VARCHAR(500),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "locale" VARCHAR(16) NOT NULL DEFAULT 'en',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "syncSequence" BIGINT NOT NULL DEFAULT 0,
    "numberPrefix" VARCHAR(8) NOT NULL DEFAULT 'INS',
    "numberSequence" INTEGER NOT NULL DEFAULT 0,
    "numberYear" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "phone" VARCHAR(32),
    "firstName" VARCHAR(100) NOT NULL,
    "lastName" VARCHAR(100) NOT NULL,
    "avatarUrl" VARCHAR(500),
    "passwordHash" VARCHAR(255),
    "passwordHistory" JSONB NOT NULL DEFAULT '[]',
    "passwordChangedAt" TIMESTAMPTZ(6),
    "role" "Role" NOT NULL DEFAULT 'INSPECTOR',
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revokedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "department" VARCHAR(120),
    "jobTitle" VARCHAR(120),
    "registrationNumber" VARCHAR(80),
    "timezone" VARCHAR(64),
    "locale" VARCHAR(16),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "lastLoginIp" INET,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "installationId" VARCHAR(128) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "osVersion" VARCHAR(40) NOT NULL,
    "appVersion" VARCHAR(40) NOT NULL,
    "model" VARCHAR(80),
    "pushToken" VARCHAR(400),
    "biometricPublicKey" TEXT,
    "biometricEnrolledAt" TIMESTAMPTZ(6),
    "lastSyncCursor" BIGINT NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMPTZ(6),
    "lastSyncAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" VARCHAR(200),
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "deviceId" VARCHAR(26),
    "tokenHash" VARCHAR(64) NOT NULL,
    "familyId" VARCHAR(26) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "replacedById" VARCHAR(26),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" VARCHAR(120),
    "userAgent" VARCHAR(400),
    "ipAddress" INET,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" INET,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(40),
    "contactName" VARCHAR(120),
    "contactEmail" VARCHAR(320),
    "contactPhone" VARCHAR(32),
    "address" TEXT,
    "logoUrl" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "clientId" VARCHAR(26),
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMPTZ(6),
    "endDate" TIMESTAMPTZ(6),
    "managerId" VARCHAR(26),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "projectId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "addedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "projectId" VARCHAR(26),
    "clientId" VARCHAR(26),
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(40),
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geofenceRadiusMeters" INTEGER,
    "timezone" VARCHAR(64),
    "contactName" VARCHAR(120),
    "contactPhone" VARCHAR(32),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "siteId" VARCHAR(26),
    "parentAssetId" VARCHAR(26),
    "name" VARCHAR(200) NOT NULL,
    "tag" VARCHAR(120) NOT NULL,
    "category" VARCHAR(120),
    "manufacturer" VARCHAR(120),
    "model" VARCHAR(120),
    "serialNumber" VARCHAR(120),
    "installedAt" TIMESTAMPTZ(6),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(120),
    "discipline" VARCHAR(120),
    "defaultPriority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "activeVersionId" VARCHAR(26),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" VARCHAR(26) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" VARCHAR(26) NOT NULL,
    "templateId" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "scoring" JSONB NOT NULL DEFAULT '{}',
    "requiredSignatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMPTZ(6),
    "publishedById" VARCHAR(26),
    "retiredAt" TIMESTAMPTZ(6),
    "changeNote" TEXT,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "templateId" VARCHAR(26) NOT NULL,
    "templateVersionId" VARCHAR(26) NOT NULL,
    "projectId" VARCHAR(26),
    "clientId" VARCHAR(26),
    "siteId" VARCHAR(26),
    "assetId" VARCHAR(26),
    "title" VARCHAR(300) NOT NULL,
    "status" "InspectionStatus" NOT NULL DEFAULT 'DRAFT',
    "outcome" "InspectionOutcome" NOT NULL DEFAULT 'PENDING',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "category" VARCHAR(120),
    "department" VARCHAR(120),
    "assignedToId" VARCHAR(26),
    "createdById" VARCHAR(26) NOT NULL,
    "reviewedById" VARCHAR(26),
    "startedAt" TIMESTAMPTZ(6),
    "scheduledFor" TIMESTAMPTZ(6),
    "dueAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "submittedAt" TIMESTAMPTZ(6),
    "reviewedAt" TIMESTAMPTZ(6),
    "rejectionReason" TEXT,
    "startLocation" JSONB,
    "endLocation" JSONB,
    "distanceFromSiteMeters" DOUBLE PRECISION,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "score" DOUBLE PRECISION,
    "totalFields" INTEGER NOT NULL DEFAULT 0,
    "answeredFields" INTEGER NOT NULL DEFAULT 0,
    "failedFields" INTEGER NOT NULL DEFAULT 0,
    "criticalFailures" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "duplicatedFromId" VARCHAR(26),
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_responses" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "inspectionId" VARCHAR(26) NOT NULL,
    "sectionId" VARCHAR(26) NOT NULL,
    "fieldId" VARCHAR(26) NOT NULL,
    "repeatIndex" INTEGER NOT NULL DEFAULT 0,
    "value" JSONB,
    "comment" TEXT,
    "score" DOUBLE PRECISION,
    "isFailure" BOOLEAN NOT NULL DEFAULT false,
    "isNotApplicable" BOOLEAN NOT NULL DEFAULT false,
    "location" JSONB,
    "answeredAt" TIMESTAMPTZ(6),
    "answeredById" VARCHAR(26),
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "inspection_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "inspectionId" VARCHAR(26),
    "responseId" VARCHAR(26),
    "kind" "AttachmentKind" NOT NULL,
    "state" "AttachmentState" NOT NULL DEFAULT 'LOCAL_ONLY',
    "fileName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "storageKey" VARCHAR(500),
    "thumbnailStorageKey" VARCHAR(500),
    "location" JSONB,
    "capturedAt" TIMESTAMPTZ(6),
    "caption" TEXT,
    "pairTag" VARCHAR(20),
    "annotations" JSONB,
    "uploadedAt" TIMESTAMPTZ(6),
    "uploadAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastUploadError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "attachmentId" VARCHAR(26) NOT NULL,
    "deviceId" VARCHAR(26) NOT NULL,
    "chunkSize" INTEGER NOT NULL,
    "totalChunks" INTEGER NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "receivedChunks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "storageUploadId" VARCHAR(255),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "inspectionId" VARCHAR(26) NOT NULL,
    "role" "SignatureRole" NOT NULL,
    "signerName" VARCHAR(200) NOT NULL,
    "signerTitle" VARCHAR(120),
    "signerEmail" VARCHAR(320),
    "attachmentId" VARCHAR(26),
    "strokes" JSONB,
    "signedAt" TIMESTAMPTZ(6) NOT NULL,
    "location" JSONB,
    "declaration" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "lastWriterDeviceId" VARCHAR(26),
    "lastWriterUserId" VARCHAR(26),

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "inspectionId" VARCHAR(26) NOT NULL,
    "layout" VARCHAR(80) NOT NULL DEFAULT 'default',
    "storageKey" VARCHAR(500),
    "sizeBytes" BIGINT,
    "checksum" VARCHAR(64),
    "generatedOnDevice" BOOLEAN NOT NULL DEFAULT false,
    "generatedById" VARCHAR(26) NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locale" VARCHAR(16) NOT NULL DEFAULT 'en',
    "options" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_log" (
    "cursor" BIGINT NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "operation" "SyncOperationType" NOT NULL,
    "entityId" VARCHAR(26) NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB,
    "projectId" VARCHAR(26),
    "assignedToId" VARCHAR(26),
    "actorUserId" VARCHAR(26),
    "actorDeviceId" VARCHAR(26),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_log_pkey" PRIMARY KEY ("cursor")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "deviceId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "operation" "SyncOperationType" NOT NULL,
    "entityId" VARCHAR(26) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "resultVersion" INTEGER,
    "resultCursor" BIGINT,
    "errorCode" VARCHAR(60),
    "errorMessage" TEXT,
    "lamport" INTEGER NOT NULL,
    "appliedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflicts" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "operationId" VARCHAR(26) NOT NULL,
    "deviceId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "entityId" VARCHAR(26) NOT NULL,
    "baseVersion" INTEGER,
    "serverVersion" INTEGER NOT NULL,
    "localRecord" JSONB NOT NULL,
    "serverRecord" JSONB NOT NULL,
    "diffs" JSONB NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolvedById" VARCHAR(26),
    "resolutionStrategy" VARCHAR(20),
    "resolvedRecord" JSONB,
    "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_sessions" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "deviceId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "trigger" VARCHAR(24) NOT NULL,
    "cursorBefore" BIGINT NOT NULL,
    "cursorAfter" BIGINT,
    "pushedCount" INTEGER NOT NULL DEFAULT 0,
    "pulledCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "bytesUp" BIGINT NOT NULL DEFAULT 0,
    "bytesDown" BIGINT NOT NULL DEFAULT 0,
    "outcome" VARCHAR(16),
    "error" TEXT,
    "appVersion" VARCHAR(40),
    "networkType" VARCHAR(24),
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,

    CONSTRAINT "sync_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26),
    "deviceId" VARCHAR(26),
    "action" VARCHAR(60) NOT NULL,
    "entity" VARCHAR(40),
    "entityId" VARCHAR(26),
    "changes" JSONB,
    "metadata" JSONB,
    "ipAddress" INET,
    "userAgent" VARCHAR(400),
    "requestId" VARCHAR(40),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "userId" VARCHAR(26) NOT NULL,
    "topic" VARCHAR(60) NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'PUSH',
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "deepLink" VARCHAR(300),
    "readAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "failedAt" TIMESTAMPTZ(6),
    "failureReason" VARCHAR(300),
    "syncCursor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_slug_idx" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "users_orgId_role_idx" ON "users"("orgId", "role");

-- CreateIndex
CREATE INDEX "users_orgId_status_idx" ON "users"("orgId", "status");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_orgId_email_key" ON "users"("orgId", "email");

-- CreateIndex
CREATE INDEX "devices_orgId_userId_idx" ON "devices"("orgId", "userId");

-- CreateIndex
CREATE INDEX "devices_pushToken_idx" ON "devices"("pushToken");

-- CreateIndex
CREATE UNIQUE INDEX "devices_userId_installationId_key" ON "devices"("userId", "installationId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "otp_codes_userId_purpose_consumedAt_idx" ON "otp_codes"("userId", "purpose", "consumedAt");

-- CreateIndex
CREATE INDEX "otp_codes_expiresAt_idx" ON "otp_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "clients_orgId_isActive_idx" ON "clients"("orgId", "isActive");

-- CreateIndex
CREATE INDEX "clients_orgId_syncCursor_idx" ON "clients"("orgId", "syncCursor");

-- CreateIndex
CREATE UNIQUE INDEX "clients_orgId_code_key" ON "clients"("orgId", "code");

-- CreateIndex
CREATE INDEX "projects_orgId_isActive_idx" ON "projects"("orgId", "isActive");

-- CreateIndex
CREATE INDEX "projects_orgId_syncCursor_idx" ON "projects"("orgId", "syncCursor");

-- CreateIndex
CREATE UNIQUE INDEX "projects_orgId_code_key" ON "projects"("orgId", "code");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- CreateIndex
CREATE INDEX "sites_orgId_isActive_idx" ON "sites"("orgId", "isActive");

-- CreateIndex
CREATE INDEX "sites_orgId_syncCursor_idx" ON "sites"("orgId", "syncCursor");

-- CreateIndex
CREATE INDEX "sites_latitude_longitude_idx" ON "sites"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "assets_orgId_siteId_idx" ON "assets"("orgId", "siteId");

-- CreateIndex
CREATE INDEX "assets_orgId_syncCursor_idx" ON "assets"("orgId", "syncCursor");

-- CreateIndex
CREATE UNIQUE INDEX "assets_orgId_tag_key" ON "assets"("orgId", "tag");

-- CreateIndex
CREATE INDEX "templates_orgId_isArchived_idx" ON "templates"("orgId", "isArchived");

-- CreateIndex
CREATE INDEX "templates_orgId_syncCursor_idx" ON "templates"("orgId", "syncCursor");

-- CreateIndex
CREATE INDEX "template_versions_orgId_syncCursor_idx" ON "template_versions"("orgId", "syncCursor");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_templateId_version_key" ON "template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "inspections_orgId_assignedToId_status_idx" ON "inspections"("orgId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "inspections_orgId_status_dueAt_idx" ON "inspections"("orgId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "inspections_orgId_syncCursor_idx" ON "inspections"("orgId", "syncCursor");

-- CreateIndex
CREATE INDEX "inspections_orgId_siteId_idx" ON "inspections"("orgId", "siteId");

-- CreateIndex
CREATE INDEX "inspections_orgId_templateId_idx" ON "inspections"("orgId", "templateId");

-- CreateIndex
CREATE INDEX "inspections_orgId_createdAt_idx" ON "inspections"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_orgId_number_key" ON "inspections"("orgId", "number");

-- CreateIndex
CREATE INDEX "inspection_responses_orgId_syncCursor_idx" ON "inspection_responses"("orgId", "syncCursor");

-- CreateIndex
CREATE INDEX "inspection_responses_inspectionId_idx" ON "inspection_responses"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_responses_inspectionId_fieldId_repeatIndex_key" ON "inspection_responses"("inspectionId", "fieldId", "repeatIndex");

-- CreateIndex
CREATE INDEX "attachments_orgId_syncCursor_idx" ON "attachments"("orgId", "syncCursor");

-- CreateIndex
CREATE INDEX "attachments_inspectionId_idx" ON "attachments"("inspectionId");

-- CreateIndex
CREATE INDEX "attachments_responseId_idx" ON "attachments"("responseId");

-- CreateIndex
CREATE INDEX "attachments_orgId_checksum_idx" ON "attachments"("orgId", "checksum");

-- CreateIndex
CREATE INDEX "attachments_state_idx" ON "attachments"("state");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_attachmentId_key" ON "upload_sessions"("attachmentId");

-- CreateIndex
CREATE INDEX "upload_sessions_expiresAt_idx" ON "upload_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "upload_sessions_orgId_deviceId_idx" ON "upload_sessions"("orgId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_attachmentId_key" ON "signatures"("attachmentId");

-- CreateIndex
CREATE INDEX "signatures_orgId_syncCursor_idx" ON "signatures"("orgId", "syncCursor");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_inspectionId_role_key" ON "signatures"("inspectionId", "role");

-- CreateIndex
CREATE INDEX "reports_orgId_inspectionId_idx" ON "reports"("orgId", "inspectionId");

-- CreateIndex
CREATE INDEX "change_log_orgId_cursor_idx" ON "change_log"("orgId", "cursor");

-- CreateIndex
CREATE INDEX "change_log_orgId_entity_cursor_idx" ON "change_log"("orgId", "entity", "cursor");

-- CreateIndex
CREATE INDEX "change_log_createdAt_idx" ON "change_log"("createdAt");

-- CreateIndex
CREATE INDEX "sync_operations_orgId_deviceId_appliedAt_idx" ON "sync_operations"("orgId", "deviceId", "appliedAt");

-- CreateIndex
CREATE INDEX "sync_operations_expiresAt_idx" ON "sync_operations"("expiresAt");

-- CreateIndex
CREATE INDEX "sync_conflicts_orgId_resolvedAt_idx" ON "sync_conflicts"("orgId", "resolvedAt");

-- CreateIndex
CREATE INDEX "sync_conflicts_orgId_entityId_idx" ON "sync_conflicts"("orgId", "entityId");

-- CreateIndex
CREATE INDEX "sync_sessions_orgId_startedAt_idx" ON "sync_sessions"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "sync_sessions_deviceId_startedAt_idx" ON "sync_sessions"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_createdAt_idx" ON "audit_logs"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_action_createdAt_idx" ON "audit_logs"("orgId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_entity_entityId_idx" ON "audit_logs"("orgId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_orgId_syncCursor_idx" ON "notifications"("orgId", "syncCursor");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_parentAssetId_fkey" FOREIGN KEY ("parentAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_responses" ADD CONSTRAINT "inspection_responses_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_responses" ADD CONSTRAINT "inspection_responses_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "inspection_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
