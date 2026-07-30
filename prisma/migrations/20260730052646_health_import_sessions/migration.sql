-- CreateTable
CREATE TABLE "HealthImportSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "source" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER,
    "totalChunks" INTEGER NOT NULL DEFAULT 0,
    "examined" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "unsupported" TEXT NOT NULL DEFAULT '[]',
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "stagedPlan" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthImportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthImportChunk" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthImportChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealthImportSession_userId_status_idx" ON "HealthImportSession"("userId", "status");

-- CreateIndex
CREATE INDEX "HealthImportSession_expiresAt_idx" ON "HealthImportSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "HealthImportChunk_sessionId_seq_key" ON "HealthImportChunk"("sessionId", "seq");

-- AddForeignKey
ALTER TABLE "HealthImportSession" ADD CONSTRAINT "HealthImportSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthImportChunk" ADD CONSTRAINT "HealthImportChunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HealthImportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
