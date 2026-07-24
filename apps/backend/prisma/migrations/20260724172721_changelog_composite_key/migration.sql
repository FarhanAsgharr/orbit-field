-- DropIndex
DROP INDEX "change_log_orgId_cursor_idx";

-- AlterTable
ALTER TABLE "change_log" DROP CONSTRAINT "change_log_pkey",
ADD CONSTRAINT "change_log_pkey" PRIMARY KEY ("orgId", "cursor");

