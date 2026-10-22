-- Replace the raw partial unique index with a Prisma-representable nullable unique key.
-- Active tasks store `${questionId}:${reason}` in activeDedupKey; completed,
-- failed and skipped tasks clear it to NULL, allowing historical attempts to coexist.

DROP INDEX IF EXISTS "QuestionRecheckTask_active_question_reason_key";

ALTER TABLE "QuestionRecheckTask"
  ADD COLUMN IF NOT EXISTS "activeDedupKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "QuestionRecheckTask_activeDedupKey_key"
  ON "QuestionRecheckTask"("activeDedupKey");
