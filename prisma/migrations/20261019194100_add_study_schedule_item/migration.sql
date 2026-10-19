-- CreateEnum
CREATE TYPE "StudyScheduleItemType" AS ENUM ('READING', 'UNIT', 'STUDY_GUIDE', 'ASSIGNMENT', 'EXAM', 'REVIEW');

-- CreateEnum
CREATE TYPE "StudyScheduleItemStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "StudyScheduleItemSource" AS ENUM ('AI', 'MANUAL', 'IMPORT');

-- CreateTable
CREATE TABLE "StudyScheduleItem" (
  "id" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "semester" INTEGER NOT NULL,
  "week" INTEGER NOT NULL,
  "dayOffset" INTEGER,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "type" "StudyScheduleItemType" NOT NULL,
  "unitId" TEXT,
  "studyGuideId" TEXT,
  "assignmentId" TEXT,
  "examId" TEXT,
  "durationMin" INTEGER,
  "order" INTEGER NOT NULL DEFAULT 0,
  "status" "StudyScheduleItemStatus" NOT NULL DEFAULT 'DRAFT',
  "source" "StudyScheduleItemSource" NOT NULL DEFAULT 'MANUAL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StudyScheduleItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudyScheduleItem_programId_semester_status_idx" ON "StudyScheduleItem"("programId", "semester", "status");

-- AddForeignKey
ALTER TABLE "StudyScheduleItem" ADD CONSTRAINT "StudyScheduleItem_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;
