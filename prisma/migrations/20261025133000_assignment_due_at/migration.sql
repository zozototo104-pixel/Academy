-- Assignment fixed calendar deadline (admin-chosen date, same for all students).
-- dueDays stays for old assignments and is used only when dueAt is NULL.
ALTER TABLE "ProgramAssignment" ADD COLUMN "dueAt" TIMESTAMP(3);
