-- CreateTable
CREATE TABLE "HealthUploadSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'receiving',
    "fileName" TEXT NOT NULL,
    "declaredSize" INTEGER NOT NULL,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "totalParts" INTEGER NOT NULL,
    "receivedParts" INTEGER NOT NULL DEFAULT 0,
    "partBytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthUploadPart" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthUploadPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealthUploadSession_userId_status_idx" ON "HealthUploadSession"("userId", "status");

-- CreateIndex
CREATE INDEX "HealthUploadSession_expiresAt_idx" ON "HealthUploadSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "HealthUploadPart_sessionId_seq_key" ON "HealthUploadPart"("sessionId", "seq");

-- AddForeignKey
ALTER TABLE "HealthUploadSession" ADD CONSTRAINT "HealthUploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthUploadPart" ADD CONSTRAINT "HealthUploadPart_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HealthUploadSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
