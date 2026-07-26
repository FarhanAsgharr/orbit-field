-- AlterTable
ALTER TABLE "inspections" ADD COLUMN     "supervisorId" VARCHAR(26);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "employeeId" VARCHAR(60);

-- CreateTable
CREATE TABLE "inspection_comments" (
    "id" VARCHAR(26) NOT NULL,
    "orgId" VARCHAR(26) NOT NULL,
    "inspectionId" VARCHAR(26) NOT NULL,
    "authorId" VARCHAR(26),
    "body" TEXT NOT NULL,
    "decision" VARCHAR(30),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspection_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inspection_comments_orgId_inspectionId_createdAt_idx" ON "inspection_comments"("orgId", "inspectionId", "createdAt");

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_comments" ADD CONSTRAINT "inspection_comments_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_comments" ADD CONSTRAINT "inspection_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
