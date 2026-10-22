-- D3.2b: atomic guard against duplicate ACTIVE recheck tasks.
-- At most one PENDING/RUNNING task per (questionId, reason) may exist;
-- concurrent enqueues now collide on this index instead of both passing
-- the logical check. (Partial index: expressed in SQL only, Prisma's
-- schema language cannot model the WHERE clause.)
CREATE UNIQUE INDEX "QuestionRecheckTask_active_question_reason_key" ON "QuestionRecheckTask" ("questionId", "reason") WHERE "status" IN ('PENDING', 'RUNNING');
