ALTER TABLE "Question" ADD COLUMN "knowledgeItemId" TEXT;
ALTER TABLE "Question" ADD COLUMN "sourceEvidence" TEXT;
ALTER TABLE "Question" ADD COLUMN "rubric" TEXT;
ALTER TABLE "ProgramQuestion" ADD COLUMN "knowledgeItemId" TEXT;
ALTER TABLE "ProgramQuestion" ADD COLUMN "rubric" TEXT;
ALTER TABLE "QuestionBankItem" ADD COLUMN "rubric" TEXT;
