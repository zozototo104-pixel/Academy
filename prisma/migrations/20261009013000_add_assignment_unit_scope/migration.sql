ALTER TABLE "ProgramAssignment" ADD COLUMN "unitId" TEXT;

CREATE INDEX "ProgramAssignment_programId_idx" ON "ProgramAssignment"("programId");
CREATE INDEX "ProgramAssignment_unitId_idx" ON "ProgramAssignment"("unitId");
CREATE INDEX "ProgramAssignment_semester_idx" ON "ProgramAssignment"("semester");
CREATE INDEX "ProgramAssignment_status_idx" ON "ProgramAssignment"("status");
