ALTER TABLE "Exam" ADD COLUMN "generationWarning" TEXT;

UPDATE "Exam"
SET "generationWarning" = 'LIMITED_KNOWLEDGE',
    "title" = REPLACE("title", '[LIMITED_KNOWLEDGE] ', '')
WHERE "title" LIKE '%[LIMITED_KNOWLEDGE]%';
