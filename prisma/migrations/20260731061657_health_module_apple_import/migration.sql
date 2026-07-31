-- AlterTable
ALTER TABLE "HealthImportBatch" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "errors" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "ignoredFiles" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "keptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recordsDuplicate" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recordsImported" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "undoneAt" TIMESTAMP(3),
ADD COLUMN     "undoneCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "xmlBytes" BIGINT;

-- CreateTable
CREATE TABLE "HealthRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "value" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'apple_health',
    "sourceApp" TEXT,
    "externalId" TEXT,
    "fingerprint" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealthRecord_userId_kind_date_idx" ON "HealthRecord"("userId", "kind", "date");

-- CreateIndex
CREATE INDEX "HealthRecord_userId_date_idx" ON "HealthRecord"("userId", "date");

-- CreateIndex
CREATE INDEX "HealthRecord_batchId_idx" ON "HealthRecord"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthRecord_userId_fingerprint_key" ON "HealthRecord"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "HealthImportBatch_userId_status_idx" ON "HealthImportBatch"("userId", "status");

-- AddForeignKey
ALTER TABLE "HealthRecord" ADD CONSTRAINT "HealthRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthRecord" ADD CONSTRAINT "HealthRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "HealthImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
