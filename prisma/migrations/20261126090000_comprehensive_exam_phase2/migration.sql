-- Comprehensive exam phase 2: candidates, invitations, attempts, answers
-- + Certificate.comprehensiveExamId link.
-- Additive only: four new tables + one nullable column, no changes to
-- existing tables or rows. This migration is a FILE ONLY: it must never
-- be applied to a live database by this change; deployment applies it
-- via the normal migrate path after the owner approves the branch.
CREATE TABLE "ComprehensiveExamCandidate" (
    "id" "text" NOT NULL,
    "examId" "text" NOT NULL,
    "fullName" "text" NOT NULL,
    "nationalId" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text",
    "externalCertificateFileKey" "text" NOT NULL,
    "externalCertificateFileName" "text" NOT NULL,
    "idDocumentFileKey" "text" NOT NULL,
    "idDocumentFileName" "text" NOT NULL,
    "status" "text" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejectedReason" "text",
    "submittedBy" "text" NOT NULL DEFAULT 'CANDIDATE',
    "reviewedById" "text",
    "reviewedAt" TIMESTAMP(3),
    "createdById" "text",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComprehensiveExamCandidate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComprehensiveExamCandidate_examId_status_idx" ON "ComprehensiveExamCandidate"("examId", "status");
CREATE INDEX "ComprehensiveExamCandidate_examId_nationalId_idx" ON "ComprehensiveExamCandidate"("examId", "nationalId");
CREATE INDEX "ComprehensiveExamCandidate_email_idx" ON "ComprehensiveExamCandidate"("email");

ALTER TABLE "ComprehensiveExamCandidate" ADD CONSTRAINT "ComprehensiveExamCandidate_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ComprehensiveExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComprehensiveExamInvitation" (
    "id" "text" NOT NULL,
    "candidateId" "text" NOT NULL,
    "token" "text" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "text" NOT NULL DEFAULT 'PENDING',
    "emailStatus" "text",
    "emailError" "text",
    "whatsappStatus" "text",
    "whatsappError" "text",
    "lastSentAt" TIMESTAMP(3),
    "createdById" "text",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComprehensiveExamInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComprehensiveExamInvitation_token_key" ON "ComprehensiveExamInvitation"("token");
CREATE INDEX "ComprehensiveExamInvitation_candidateId_status_idx" ON "ComprehensiveExamInvitation"("candidateId", "status");
CREATE INDEX "ComprehensiveExamInvitation_expiresAt_idx" ON "ComprehensiveExamInvitation"("expiresAt");

ALTER TABLE "ComprehensiveExamInvitation" ADD CONSTRAINT "ComprehensiveExamInvitation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ComprehensiveExamCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComprehensiveExamAttempt" (
    "id" "text" NOT NULL,
    "invitationId" "text" NOT NULL,
    "candidateId" "text" NOT NULL,
    "examId" "text" NOT NULL,
    "questionSnapshot" "text",
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "status" "text" NOT NULL DEFAULT 'STARTED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "durationUsedMin" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComprehensiveExamAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComprehensiveExamAttempt_invitationId_key" ON "ComprehensiveExamAttempt"("invitationId");
CREATE INDEX "ComprehensiveExamAttempt_candidateId_idx" ON "ComprehensiveExamAttempt"("candidateId");
CREATE INDEX "ComprehensiveExamAttempt_examId_status_idx" ON "ComprehensiveExamAttempt"("examId", "status");

ALTER TABLE "ComprehensiveExamAttempt" ADD CONSTRAINT "ComprehensiveExamAttempt_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "ComprehensiveExamInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComprehensiveExamAttempt" ADD CONSTRAINT "ComprehensiveExamAttempt_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ComprehensiveExamCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComprehensiveExamAttempt" ADD CONSTRAINT "ComprehensiveExamAttempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ComprehensiveExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComprehensiveExamAnswer" (
    "id" "text" NOT NULL,
    "attemptId" "text" NOT NULL,
    "questionId" "text" NOT NULL,
    "selectedOption" INTEGER,
    "isCorrect" BOOLEAN,
    "points" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComprehensiveExamAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComprehensiveExamAnswer_attemptId_questionId_key" ON "ComprehensiveExamAnswer"("attemptId", "questionId");
CREATE INDEX "ComprehensiveExamAnswer_attemptId_idx" ON "ComprehensiveExamAnswer"("attemptId");

ALTER TABLE "ComprehensiveExamAnswer" ADD CONSTRAINT "ComprehensiveExamAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ComprehensiveExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Certificate" ADD COLUMN "comprehensiveExamId" "text";
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_comprehensiveExamId_fkey" FOREIGN KEY ("comprehensiveExamId") REFERENCES "ComprehensiveExam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
