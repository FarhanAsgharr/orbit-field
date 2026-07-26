-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "barcode" VARCHAR(200),
ADD COLUMN     "qrCode" VARCHAR(200);

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "region" VARCHAR(120);
