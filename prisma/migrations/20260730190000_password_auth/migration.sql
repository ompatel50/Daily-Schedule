-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_userId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "emailVerified",
DROP COLUMN "image",
ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFailedLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "Account";


-- Invalidate every session issued before password auth existed. Rows that
-- predate this migration get tokenVersion 1 while any old JWT carries no tv
-- claim (and a hypothetical forged claim would say 0): both mismatch, so
-- Google-era sessions die immediately. Fresh databases are unaffected —
-- their users are created after this migration with tokenVersion 0.
UPDATE "User" SET "tokenVersion" = 1;
