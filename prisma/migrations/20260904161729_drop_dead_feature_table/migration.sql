/*
  Warnings:

  - You are about to drop the `features_daily` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "features_daily" DROP CONSTRAINT "features_daily_instrumentId_fkey";

-- DropTable
DROP TABLE "features_daily";
