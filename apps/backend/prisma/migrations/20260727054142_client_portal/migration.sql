-- CreateEnum
CREATE TYPE "InspectionRequestStatus" AS ENUM ('PENDING_APPROVAL', 'INFORMATION_REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "clientId" VARCHAR(26);

-- CreateTable
CREATE TABLE "inspection_requests" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "clientId" VARCHAR(26) NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "inspectionType" VARCHAR(120),
    "specialInstructions" TEXT,
    "siteId" VARCHAR(26),
    "assetId" VARCHAR(26),
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "status" "InspectionRequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "preferredDate" TIMESTAMPTZ(6),
    "preferredTime" VARCHAR(20),
    "requestedById" VARCHAR(26) NOT NULL,
    "reviewedById" VARCHAR(26),
    "reviewedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "inspectionId" VARCHAR(26),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "inspection_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_attachments" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "requestId" VARCHAR(26) NOT NULL,
    "fileName" VARCHAR(300) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "storageKey" VARCHAR(500) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "uploadedById" VARCHAR(26) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "request_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_comments" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "requestId" VARCHAR(26) NOT NULL,
    "authorId" VARCHAR(26),
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inspection_requests_orgId_clientId_status_createdAt_idx" ON "inspection_requests"("orgId", "clientId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "inspection_requests_orgId_status_createdAt_idx" ON "inspection_requests"("orgId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_requests_orgId_number_key" ON "inspection_requests"("orgId", "number");

-- CreateIndex
CREATE INDEX "request_attachments_orgId_requestId_idx" ON "request_attachments"("orgId", "requestId");

-- CreateIndex
CREATE INDEX "request_comments_orgId_requestId_createdAt_idx" ON "request_comments"("orgId", "requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_requests" ADD CONSTRAINT "inspection_requests_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "inspection_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "inspection_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
