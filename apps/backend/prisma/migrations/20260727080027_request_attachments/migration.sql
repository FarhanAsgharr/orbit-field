/*
  Warnings:

  - You are about to drop the `request_attachments` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "request_attachments" DROP CONSTRAINT "request_attachments_requestId_fkey";

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "requestId" VARCHAR(26);

-- DropTable
DROP TABLE "request_attachments";

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "inspection_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
