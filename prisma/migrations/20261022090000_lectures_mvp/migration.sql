-- CreateEnum
CREATE TYPE "LectureDeliveryMode" AS ENUM ('EXTERNAL_LINK', 'RECORDED_ONLY');
CREATE TYPE "LectureProvider" AS ENUM ('ZOOM', 'MEET', 'TEAMS', 'OTHER');
CREATE TYPE "LectureSessionStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED', 'RESCHEDULED');
CREATE TYPE "LectureAttendanceStatus" AS ENUM ('JOINED', 'PRESENT', 'ABSENT');
CREATE TYPE "LectureVideoSource" AS ENUM ('YOUTUBE', 'VIMEO', 'DRIVE', 'FACEBOOK', 'DAILYMOTION', 'LOOM', 'BUNNY', 'CLOUDFLARE', 'MP4', 'HLS', 'S3', 'EXTERNAL');
CREATE TYPE "LectureVideoStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "LectureSeries" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "unitId" TEXT,
    "supervisorId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "weekday" INTEGER,
    "timeOfDay" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "durationMin" INTEGER NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LectureSeries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LectureSeries_weekday_check" CHECK ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6),
    CONSTRAINT "LectureSeries_durationMin_check" CHECK ("durationMin" > 0)
);

-- CreateTable
CREATE TABLE "LectureSession" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "deliveryMode" "LectureDeliveryMode" NOT NULL DEFAULT 'EXTERNAL_LINK',
    "provider" "LectureProvider" NOT NULL DEFAULT 'OTHER',
    "meetingUrl" TEXT,
    "meetingPasscode" TEXT,
    "status" "LectureSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "updatedById" TEXT,
    "reminder24hSentAt" TIMESTAMP(3),
    "reminder15mSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LectureSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LectureAttendance" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "LectureAttendanceStatus" NOT NULL DEFAULT 'JOINED',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    CONSTRAINT "LectureAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LectureVideoResource" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "unitId" TEXT,
    "sessionId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" "LectureVideoSource" NOT NULL,
    "url" TEXT,
    "storageKey" TEXT,
    "provider" TEXT,
    "embedId" TEXT,
    "thumbnailUrl" TEXT,
    "originalUrl" TEXT,
    "status" "LectureVideoStatus" NOT NULL DEFAULT 'DRAFT',
    "mimeType" TEXT,
    "sizeBytes" BIGINT,
    "durationSec" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LectureVideoResource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LectureVideoResource_url_or_storageKey_check" CHECK ("url" IS NOT NULL OR "storageKey" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "LectureWatchProgress" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "watchedPercent" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LectureWatchProgress_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LectureWatchProgress_positionSec_check" CHECK ("positionSec" >= 0),
    CONSTRAINT "LectureWatchProgress_watchedPercent_check" CHECK ("watchedPercent" BETWEEN 0 AND 100)
);

-- CreateIndex
CREATE INDEX "LectureSeries_programId_active_idx" ON "LectureSeries"("programId", "active");
CREATE INDEX "LectureSeries_supervisorId_idx" ON "LectureSeries"("supervisorId");
CREATE INDEX "LectureSeries_unitId_idx" ON "LectureSeries"("unitId");
CREATE INDEX "LectureSession_seriesId_idx" ON "LectureSession"("seriesId");
CREATE INDEX "LectureSession_status_startsAt_idx" ON "LectureSession"("status", "startsAt");
CREATE UNIQUE INDEX "LectureAttendance_sessionId_userId_key" ON "LectureAttendance"("sessionId", "userId");
CREATE INDEX "LectureAttendance_userId_idx" ON "LectureAttendance"("userId");
CREATE INDEX "LectureVideoResource_programId_status_order_idx" ON "LectureVideoResource"("programId", "status", "order");
CREATE INDEX "LectureVideoResource_sessionId_idx" ON "LectureVideoResource"("sessionId");
CREATE INDEX "LectureVideoResource_unitId_idx" ON "LectureVideoResource"("unitId");
CREATE UNIQUE INDEX "LectureWatchProgress_videoId_userId_key" ON "LectureWatchProgress"("videoId", "userId");
CREATE INDEX "LectureWatchProgress_userId_idx" ON "LectureWatchProgress"("userId");

-- AddForeignKey
ALTER TABLE "LectureSeries" ADD CONSTRAINT "LectureSeries_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LectureSeries" ADD CONSTRAINT "LectureSeries_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LectureSeries" ADD CONSTRAINT "LectureSeries_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LectureSeries" ADD CONSTRAINT "LectureSeries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LectureSession" ADD CONSTRAINT "LectureSession_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "LectureSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LectureSession" ADD CONSTRAINT "LectureSession_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LectureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LectureAttendance" ADD CONSTRAINT "LectureAttendance_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LectureVideoResource" ADD CONSTRAINT "LectureVideoResource_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LectureVideoResource" ADD CONSTRAINT "LectureVideoResource_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LectureVideoResource" ADD CONSTRAINT "LectureVideoResource_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LectureSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LectureWatchProgress" ADD CONSTRAINT "LectureWatchProgress_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "LectureVideoResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LectureWatchProgress" ADD CONSTRAINT "LectureWatchProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
