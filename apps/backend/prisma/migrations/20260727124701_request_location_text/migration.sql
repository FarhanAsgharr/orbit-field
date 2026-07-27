-- AlterTable
ALTER TABLE "inspection_requests" ADD COLUMN     "projectName" VARCHAR(200),
ADD COLUMN     "siteAddress" TEXT,
ADD COLUMN     "siteName" VARCHAR(200);
