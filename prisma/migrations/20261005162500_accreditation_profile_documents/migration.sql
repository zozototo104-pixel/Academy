-- CreateTable
CREATE TABLE "AccreditationProfile" (
    "id" TEXT NOT NULL,
    "singletonKey" TEXT NOT NULL DEFAULT 'default',
    "licenseNumber" TEXT,
    "licenseVerifyUrl" TEXT,
    "licensingAuthority" TEXT,
    "trustNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccreditationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccreditationPartnership" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "description" TEXT,
    "verifyUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccreditationPartnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccreditationDocument" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "partnershipId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'LICENSE',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "verifyUrl" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccreditationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccreditationProfile_singletonKey_key" ON "AccreditationProfile"("singletonKey");

-- CreateIndex
CREATE INDEX "AccreditationPartnership_profileId_active_displayOrder_idx" ON "AccreditationPartnership"("profileId", "active", "displayOrder");

-- CreateIndex
CREATE INDEX "AccreditationDocument_profileId_kind_active_idx" ON "AccreditationDocument"("profileId", "kind", "active");

-- CreateIndex
CREATE INDEX "AccreditationDocument_partnershipId_idx" ON "AccreditationDocument"("partnershipId");

-- AddForeignKey
ALTER TABLE "AccreditationPartnership" ADD CONSTRAINT "AccreditationPartnership_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AccreditationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccreditationDocument" ADD CONSTRAINT "AccreditationDocument_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AccreditationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccreditationDocument" ADD CONSTRAINT "AccreditationDocument_partnershipId_fkey" FOREIGN KEY ("partnershipId") REFERENCES "AccreditationPartnership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
