-- Graduation transactions: one living record per enrollment that stores
-- the eligibility snapshot and the explicit administrative approval.
-- Certificate issuance is refused by the server unless an APPROVED
-- record exists here; automatic academic events only register/refresh it.
CREATE TABLE "GraduationRequest" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "admissionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION,
    "snapshot" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "certificateId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraduationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GraduationRequest_enrollmentId_key" ON "GraduationRequest"("enrollmentId");

CREATE INDEX "GraduationRequest_status_idx" ON "GraduationRequest"("status");

CREATE INDEX "GraduationRequest_userId_idx" ON "GraduationRequest"("userId");
