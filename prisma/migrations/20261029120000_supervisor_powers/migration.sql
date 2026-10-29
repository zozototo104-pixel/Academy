-- صلاحيات المشرف البشري (2026-10-29): اقتراحات الوحدات + التماس مراجعة
-- امتحانات الوحدات + حقول مراجعة الدرجات البشرية على المحاولات.

-- AlterTable: التماس + مراجعة بشرية على محاولات امتحانات الوحدات
ALTER TABLE "ExamAttempt" ADD COLUMN     "appealStatus" TEXT DEFAULT 'NONE',
ADD COLUMN     "appealReason" TEXT,
ADD COLUMN     "appealResponse" TEXT,
ADD COLUMN     "appealedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- AlterTable: مراجعة بشرية على محاولات الامتحانات الفصلية (الالتماس موجود أصلًا)
ALTER TABLE "ProgramExamAttempt" ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- CreateTable: اقتراحات المشرف على الوحدات
CREATE TABLE "SupervisorUnitProposal" (
    "id" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "unitId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupervisorUnitProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupervisorUnitProposal_programId_status_idx" ON "SupervisorUnitProposal"("programId", "status");

-- CreateIndex
CREATE INDEX "SupervisorUnitProposal_supervisorId_createdAt_idx" ON "SupervisorUnitProposal"("supervisorId", "createdAt");
