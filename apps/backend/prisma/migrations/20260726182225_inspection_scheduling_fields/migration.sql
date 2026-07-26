-- AlterTable
ALTER TABLE "inspections" ADD COLUMN     "estimatedDurationMinutes" INTEGER,
ADD COLUMN     "scheduledAt" TIMESTAMPTZ(6);
