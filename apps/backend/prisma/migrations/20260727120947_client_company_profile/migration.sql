-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "city" VARCHAR(120),
ADD COLUMN     "contactDesignation" VARCHAR(120),
ADD COLUMN     "country" VARCHAR(120),
ADD COLUMN     "industry" VARCHAR(120),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "postalCode" VARCHAR(20),
ADD COLUMN     "registrationNumber" VARCHAR(80),
ADD COLUMN     "state" VARCHAR(120),
ADD COLUMN     "taxNumber" VARCHAR(80),
ADD COLUMN     "website" VARCHAR(300),
ADD COLUMN     "whatsapp" VARCHAR(32);
