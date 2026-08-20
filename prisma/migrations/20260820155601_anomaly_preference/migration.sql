-- CreateTable
CREATE TABLE "AnomalyPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "dismissals" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnomalyPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnomalyPreference_userId_category_key" ON "AnomalyPreference"("userId", "category");

-- AddForeignKey
ALTER TABLE "AnomalyPreference" ADD CONSTRAINT "AnomalyPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
